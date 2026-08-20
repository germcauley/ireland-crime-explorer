"use client";

import type { LayerGroup, Map as LeafletMap, Polygon as LeafletPolygon } from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import { annualSum, percentageChange, type QueryAnswer } from "../lib/analytics";
import type { DashboardData, Division, Station } from "../lib/dashboard-types";

type MapMode = "station" | "division";
type TrendPeriod = "year_on_year" | "three_year" | "since_2019";
type Point = { x: number; y: number };
type AreaChange = {
  station: Station;
  current: number | null;
  baseline: number | null;
  change: number | null;
  isRaw: boolean;
};
type DivisionAreaChange = {
  division: Division;
  current: number | null;
  baseline: number | null;
  change: number | null;
  isRaw: boolean;
};
type GeoJSONGeometry = Division["boundary"];

const ASK_CRIME_BOT_ENABLED = true;

const numberFormat = new Intl.NumberFormat("en-IE");
const oneDecimal = new Intl.NumberFormat("en-IE", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const longitudeScale = Math.cos((53.4 * Math.PI) / 180);

async function loadLeaflet() {
  const leafletModule = await import("leaflet");
  return (
    (leafletModule as typeof leafletModule & { default?: typeof leafletModule }).default ??
    leafletModule
  );
}

// Percentage change is misleading on tiny baselines (one extra murder can
// read as "+100%"), so below that threshold we fall back to showing and
// colouring the raw count difference instead.
function combinedChange(current: number | null, baseline: number | null): { change: number | null; isRaw: boolean } {
  const pct = percentageChange(current, baseline);
  if (pct !== null) return { change: pct, isRaw: false };
  if (current !== null && baseline !== null) return { change: current - baseline, isRaw: true };
  return { change: null, isRaw: false };
}

function formatSigned(value: number, isRaw = false) {
  if (isRaw) return `${value > 0 ? "+" : ""}${numberFormat.format(value)}`;
  return `${value > 0 ? "+" : ""}${oneDecimal.format(value)}%`;
}

function changeColour(value: number | null, isRaw = false) {
  if (value === null) return "#b9b6ae";
  if (isRaw) {
    if (value >= 3) return "#8f2f27";
    if (value >= 1) return "#df9870";
    if (value === 0) return "#e8e1d4";
    if (value >= -2) return "#a8bc96";
    return "#376b54";
  }
  if (value >= 25) return "#8f2f27";
  if (value >= 10) return "#bd5941";
  if (value > 2) return "#df9870";
  if (value >= -2) return "#e8e1d4";
  if (value >= -10) return "#a8bc96";
  if (value >= -25) return "#6f9674";
  return "#376b54";
}

// The three tones the Nightshift palette uses for a change figure. Thresholds
// match changeColour's flat band so a colour and a tone never disagree.
function toneOf(value: number | null, isRaw = false): "up" | "down" | "flat" {
  if (value === null) return "flat";
  if (isRaw) return value > 0 ? "up" : value < 0 ? "down" : "flat";
  return value > 2 ? "up" : value < -2 ? "down" : "flat";
}

function clipPolygon(polygon: Point[], a: number, b: number, c: number) {
  const result: Point[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const currentDistance = a * current.x + b * current.y - c;
    const nextDistance = a * next.x + b * next.y - c;
    const currentInside = currentDistance <= 0;
    const nextInside = nextDistance <= 0;

    if (currentInside) result.push(current);
    if (currentInside !== nextInside) {
      const ratio = currentDistance / (currentDistance - nextDistance);
      result.push({
        x: current.x + ratio * (next.x - current.x),
        y: current.y + ratio * (next.y - current.y),
      });
    }
  }
  return result;
}

function buildAreaCell(
  station: Station,
  stations: Station[],
  bounds: [number, number, number, number],
) {
  const point = { x: station.lng * longitudeScale, y: station.lat };
  let polygon: Point[] = [
    { x: bounds[0] * longitudeScale, y: bounds[1] },
    { x: bounds[2] * longitudeScale, y: bounds[1] },
    { x: bounds[2] * longitudeScale, y: bounds[3] },
    { x: bounds[0] * longitudeScale, y: bounds[3] },
  ];

  stations.forEach((other) => {
    if (other.id === station.id || polygon.length === 0) return;
    const otherPoint = { x: other.lng * longitudeScale, y: other.lat };
    const a = 2 * (otherPoint.x - point.x);
    const b = 2 * (otherPoint.y - point.y);
    const c =
      otherPoint.x * otherPoint.x +
      otherPoint.y * otherPoint.y -
      point.x * point.x -
      point.y * point.y;
    polygon = clipPolygon(polygon, a, b, c);
  });

  return polygon.map((vertex) => [vertex.y, vertex.x / longitudeScale] as [number, number]);
}

function buildSparkline(points: Array<{ quarter: string; value: number | null }>, width: number, height: number) {
  const values = points.map((point) => point.value).filter((value): value is number => value !== null);
  if (values.length < 2) return { segments: [] as string[], dots: [] as { x: number; y: number }[] };
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const stepX = width / Math.max(1, points.length - 1);
  const coords = points.map((point, index) => {
    if (point.value === null) return null;
    const x = index * stepX;
    const y = height - ((point.value - min) / range) * height;
    return { x, y };
  });

  const segments: string[] = [];
  let current: string[] = [];
  coords.forEach((coordinate) => {
    if (!coordinate) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${coordinate.x.toFixed(1)},${coordinate.y.toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(" "));

  const dots = coords.filter((coordinate): coordinate is { x: number; y: number } => coordinate !== null);
  return { segments, dots };
}

function geometryBounds(geometry: GeoJSONGeometry): [number, number, number, number] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const visit = (node: unknown): void => {
    if (Array.isArray(node) && typeof node[0] === "number") {
      const [lng, lat] = node as [number, number];
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    if (Array.isArray(node)) node.forEach(visit);
  };
  visit(geometry.coordinates);
  return [minLng, minLat, maxLng, maxLat];
}

function exteriorRingsLatLng(geometry: GeoJSONGeometry): [number, number][][] {
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates as number[][][]]
      : (geometry.coordinates as number[][][][]);
  return polygons.map((polygon) =>
    polygon[0].map(([lng, lat]) => [lat, lng] as [number, number]),
  );
}

// Client-side echo of the normalise/matchTier pair in app/lib/analytics.ts.
// The server matcher runs against an LLM's parsed filters; this one runs
// against keystrokes, so it lives here rather than pulling the data layer
// into the bundle — but it ranks by the same discrete tiers, so a query that
// resolves one way in Crime Bot resolves the same way in search.
function normaliseQuery(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTier(hay: string, needle: string): number {
  if (!hay || !needle) return 0;
  if (hay === needle) return 3;
  if (hay.startsWith(needle)) return 2;
  if (hay.includes(needle)) return 1;
  return 0;
}

type SearchHit = {
  key: string;
  kind: "station" | "division" | "place";
  badge: string;
  title: string;
  subtitle: string;
  change: number | null;
  isRaw: boolean;
  approximate: boolean;
  geography: MapMode;
  areaId: string;
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Modal plumbing shared by the filter sheet and the drill-down screens:
// focus moves in on open, Tab cycles inside, Escape closes, focus returns to
// whatever opened it.
function useModalBehaviour(
  open: boolean,
  close: () => void,
  container: { current: HTMLElement | null },
) {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () =>
      container.current ? Array.from(container.current.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    const timeout = window.setTimeout(() => focusables()[0]?.focus(), 20);

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", onKeyDown);
      opener?.focus?.();
    };
  }, [container, open]);
}

const CHECK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4.5 12.5 5 5 10-11" />
  </svg>
);

const SEARCH_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m16.5 16.5 4 4" />
  </svg>
);

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function CrimeExplorer({ data }: { data: DashboardData }) {
  const [mapMode, setMapMode] = useState<MapMode>("division");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [selectedDivisionGroup, setSelectedDivisionGroup] = useState(data.divisionCategories[2]?.id ?? "03");
  const [selectedDivisionDetail, setSelectedDivisionDetail] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState(data.meta.latestCompleteYear);
  const [trendPeriod, setTrendPeriod] = useState<TrendPeriod>("year_on_year");
  const [selectedStationId, setSelectedStationId] = useState("65102");
  const [selectedDivisionId, setSelectedDivisionId] = useState(data.divisions[0]?.id ?? "");
  const [quarterRangeExpanded, setQuarterRangeExpanded] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [askInput, setAskInput] = useState("");
  const [askStatus, setAskStatus] = useState<"idle" | "loading" | "error">("idle");
  const [askError, setAskError] = useState<string | null>(null);
  const [askResult, setAskResult] = useState<QueryAnswer | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [recentSearches, setRecentSearches] = useState<SearchHit[]>([]);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  // The layout is CSS-driven, but Leaflet paints polygons into a canvas that
  // no stylesheet can reach, so the map's own palette and its touch behaviour
  // need to know the breakpoint. Starts false so the server render and the
  // first client render agree.
  const [isNarrow, setIsNarrow] = useState(false);
  const mapElement = useRef<HTMLDivElement>(null);
  const filterSheet = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchOpener = useRef<HTMLButtonElement>(null);
  const mapInstance = useRef<LeafletMap | null>(null);
  const areaLayer = useRef<LayerGroup | null>(null);
  const maskLayer = useRef<LeafletPolygon | null>(null);

  const selectedDivisionCode = selectedDivisionDetail ?? selectedDivisionGroup;
  const selectedDivisionGroupCopy =
    data.divisionCategories.find((group) => group.id === selectedDivisionGroup) ?? data.divisionCategories[0];
  const selectedDivisionDetailCopy = selectedDivisionDetail
    ? selectedDivisionGroupCopy?.children.find((child) => child.id === selectedDivisionDetail)
    : undefined;

  const yearIndex = data.meta.years.indexOf(selectedYear);
  const baselineIndex =
    trendPeriod === "year_on_year"
      ? Math.max(0, yearIndex - 1)
      : trendPeriod === "three_year"
        ? Math.max(0, yearIndex - 3)
        : 0;
  const baselineYear = data.meta.years[baselineIndex];
  const hasBaseline = baselineIndex < yearIndex;
  const selectedCategoryCopy =
    data.categories.find((category) => category.id === selectedCategory) ?? data.categories[0];

  const areaChanges = useMemo<AreaChange[]>(
    () =>
      data.stations.map((station) => {
        const current = station.series[selectedCategory][yearIndex];
        const baseline = hasBaseline ? station.series[selectedCategory][baselineIndex] : null;
        const { change, isRaw } = combinedChange(current, baseline);
        return { station, current, baseline, change, isRaw };
      }),
    [baselineIndex, data.stations, hasBaseline, selectedCategory, yearIndex],
  );

  const availableChanges = useMemo(
    () => areaChanges.filter((entry): entry is AreaChange & { change: number } => entry.change !== null),
    [areaChanges],
  );
  const rankedIncreases = useMemo(
    () => [...availableChanges].sort((a, b) => b.change - a.change),
    [availableChanges],
  );
  const rankedDecreases = useMemo(
    () => [...availableChanges].sort((a, b) => a.change - b.change),
    [availableChanges],
  );
  const selectedArea =
    areaChanges.find((entry) => entry.station.id === selectedStationId) ?? areaChanges[0];
  const summary = useMemo(
    () =>
      availableChanges.reduce(
        (result, entry) => {
          if (entry.isRaw) {
            if (entry.change > 0) result.increased += 1;
            else if (entry.change < 0) result.decreased += 1;
            else result.stable += 1;
          } else if (entry.change > 2) result.increased += 1;
          else if (entry.change < -2) result.decreased += 1;
          else result.stable += 1;
          return result;
        },
        { increased: 0, decreased: 0, stable: 0 },
      ),
    [availableChanges],
  );

  const divisionAreaChanges = useMemo<DivisionAreaChange[]>(
    () =>
      data.divisions.map((division) => {
        const current = annualSum(division, selectedDivisionCode, selectedYear, data.meta.quarters);
        const baseline = hasBaseline
          ? annualSum(division, selectedDivisionCode, baselineYear, data.meta.quarters)
          : null;
        const { change, isRaw } = combinedChange(current, baseline);
        return { division, current, baseline, change, isRaw };
      }),
    [baselineYear, data.divisions, data.meta.quarters, hasBaseline, selectedDivisionCode, selectedYear],
  );
  const availableDivisionChanges = useMemo(
    () =>
      divisionAreaChanges.filter(
        (entry): entry is DivisionAreaChange & { change: number } => entry.change !== null,
      ),
    [divisionAreaChanges],
  );
  const rankedDivisionIncreases = useMemo(
    () => [...availableDivisionChanges].sort((a, b) => b.change - a.change),
    [availableDivisionChanges],
  );
  const rankedDivisionDecreases = useMemo(
    () => [...availableDivisionChanges].sort((a, b) => a.change - b.change),
    [availableDivisionChanges],
  );
  const selectedDivisionArea =
    divisionAreaChanges.find((entry) => entry.division.id === selectedDivisionId) ?? divisionAreaChanges[0];
  const divisionSummary = useMemo(
    () =>
      availableDivisionChanges.reduce(
        (result, entry) => {
          if (entry.isRaw) {
            if (entry.change > 0) result.increased += 1;
            else if (entry.change < 0) result.decreased += 1;
            else result.stable += 1;
          } else if (entry.change > 2) result.increased += 1;
          else if (entry.change < -2) result.decreased += 1;
          else result.stable += 1;
          return result;
        },
        { increased: 0, decreased: 0, stable: 0 },
      ),
    [availableDivisionChanges],
  );

  const divisionQuarterSeries = useMemo(() => {
    const division = selectedDivisionArea?.division;
    if (!division) return [];
    const series = division.series[selectedDivisionCode] ?? [];
    const startIndex = quarterRangeExpanded ? 0 : data.meta.defaultQuarterStartIndex;
    return data.meta.quarters.slice(startIndex).map((quarter, index) => ({
      quarter,
      value: series[startIndex + index] ?? null,
    }));
  }, [data.meta.defaultQuarterStartIndex, data.meta.quarters, quarterRangeExpanded, selectedDivisionArea, selectedDivisionCode]);

  const mapBounds = useMemo<[number, number, number, number]>(() => {
    const latitudes = data.stations.map((station) => station.lat);
    const longitudes = data.stations.map((station) => station.lng);
    return [
      Math.min(...longitudes) - 0.035,
      Math.min(...latitudes) - 0.025,
      Math.max(...longitudes) + 0.035,
      Math.max(...latitudes) + 0.025,
    ];
  }, [data.stations]);

  const nationalBounds = useMemo<[number, number, number, number]>(() => {
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    data.divisions.forEach((division) => {
      const [dMinLng, dMinLat, dMaxLng, dMaxLat] = geometryBounds(division.boundary);
      if (dMinLng < minLng) minLng = dMinLng;
      if (dMinLat < minLat) minLat = dMinLat;
      if (dMaxLng > maxLng) maxLng = dMaxLng;
      if (dMaxLat > maxLat) maxLat = dMaxLat;
    });
    return [minLng - 0.15, minLat - 0.1, maxLng + 0.15, maxLat + 0.1];
  }, [data.divisions]);

  const irelandMaskRings = useMemo(
    () => data.divisions.flatMap((division) => exteriorRingsLatLng(division.boundary)),
    [data.divisions],
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const update = () => setIsNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    async function updateMask() {
      if (!mapReady || !mapInstance.current) return;
      const leaflet = await loadLeaflet();
      if (mapMode !== "division") {
        if (maskLayer.current) mapInstance.current.removeLayer(maskLayer.current);
        return;
      }
      if (maskLayer.current) {
        // The land outside Ireland is water-blue on desktop and the Nightshift
        // canvas colour on mobile, so the mask is restyled when the breakpoint
        // flips rather than rebuilt.
        maskLayer.current.setStyle({ fillColor: isNarrow ? "#0d1f19" : "#cfe1e6" });
        maskLayer.current.addTo(mapInstance.current);
        return;
      }
      const worldRing: [number, number][] = [
        [-85, -180],
        [85, -180],
        [85, 180],
        [-85, 180],
      ];
      maskLayer.current = leaflet
        .polygon([worldRing, ...irelandMaskRings], {
          pane: "ireland-mask",
          stroke: false,
          fillColor: isNarrow ? "#0d1f19" : "#cfe1e6",
          fillOpacity: 1,
          interactive: false,
        })
        .addTo(mapInstance.current);
    }
    updateMask();
  }, [irelandMaskRings, isNarrow, mapMode, mapReady]);

  useEffect(() => {
    let cancelled = false;
    async function initialiseMap() {
      if (!mapElement.current || mapInstance.current) return;
      const leaflet = await loadLeaflet();
      if (cancelled || !mapElement.current) return;
      const map = leaflet.map(mapElement.current, {
        zoomControl: false,
        attributionControl: true,
        minZoom: 6,
        preferCanvas: true,
      });
      mapInstance.current = map;
      leaflet
        .tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "&copy; OpenStreetMap contributors",
          maxZoom: 18,
          opacity: 0.68,
        })
        .addTo(map);
      const maskPane = map.createPane("ireland-mask");
      maskPane.style.zIndex = "350";
      maskPane.style.pointerEvents = "none";
      new leaflet.Control.Zoom({ position: "bottomright" }).addTo(map);
      map.fitBounds(
        [
          [mapBounds[1], mapBounds[0]],
          [mapBounds[3], mapBounds[2]],
        ],
        { padding: [10, 10] },
      );
      areaLayer.current = leaflet.layerGroup().addTo(map);
      setMapReady(true);
    }
    initialiseMap();
    return () => {
      cancelled = true;
      mapInstance.current?.remove();
      mapInstance.current = null;
      areaLayer.current = null;
      maskLayer.current = null;
    };
  }, [data.stations, mapBounds]);

  useEffect(() => {
    async function renderStationAreas() {
      if (!mapReady || !areaLayer.current || mapMode !== "station") return;
      const leaflet = await loadLeaflet();
      areaLayer.current.clearLayers();

      const restingOpacity = (change: number | null, selected: boolean) => {
        if (change === null) return isNarrow ? 0.4 : 0.48;
        if (isNarrow) return selected ? 0.98 : 0.62;
        return 0.76;
      };
      const restingStroke = (selected: boolean) =>
        isNarrow
          ? { color: selected ? "#e07a5f" : "rgba(226,238,231,.28)", weight: selected ? 2.6 : 0.9 }
          : { color: selected ? "#102e26" : "rgba(23,55,45,.56)", weight: selected ? 3 : 1 };

      areaChanges.forEach((entry) => {
        const selected = entry.station.id === selectedStationId;
        const cell = buildAreaCell(entry.station, data.stations, mapBounds);
        const changeLabel = entry.change === null ? "Not available" : formatSigned(entry.change, entry.isRaw);
        const countLabel =
          entry.current === null || entry.baseline === null
            ? "No comparable counts"
            : `${numberFormat.format(entry.baseline)} → ${numberFormat.format(entry.current)} incidents`;
        const tooltip = `
          <div class="area-tooltip">
            <span>${escapeHtml(entry.station.division)}</span>
            <strong>${escapeHtml(entry.station.name)}</strong>
            <b>${escapeHtml(changeLabel)}</b>
            <small>${baselineYear}–${selectedYear} · ${escapeHtml(countLabel)}</small>
          </div>`;
        const polygon = leaflet.polygon(cell, {
          ...restingStroke(selected),
          fillColor: changeColour(entry.change, entry.isRaw),
          fillOpacity: restingOpacity(entry.change, selected),
          className: "reporting-area-cell",
        });
        // Touch has no hover: a tooltip there would need a tap that is already
        // spoken for by selection, and the readout says the same thing.
        if (!isNarrow) {
          polygon.bindTooltip(tooltip, {
            sticky: true,
            direction: "top",
            opacity: 1,
            className: "change-tooltip",
          });
          polygon.on("mouseover", () => polygon.setStyle({ weight: 3, fillOpacity: 0.9 }));
          polygon.on("mouseout", () =>
            polygon.setStyle({
              weight: entry.station.id === selectedStationId ? 3 : 1,
              fillOpacity: entry.change === null ? 0.48 : 0.76,
            }),
          );
        }
        polygon.on("click", () => setSelectedStationId(entry.station.id));
        polygon.addTo(areaLayer.current!);

        // On touch the point is a second, smaller tap target for the same
        // area, so it grows enough to be reachable rather than decorative.
        const stationPoint = leaflet.circleMarker([entry.station.lat, entry.station.lng], {
          radius: isNarrow ? (selected ? 9 : 4.5) : selected ? 4.5 : 2.6,
          color: isNarrow ? "#f6f2e9" : "#f8f5ee",
          weight: isNarrow ? 1.6 : 1,
          fillColor: isNarrow ? "#12271f" : "#17372d",
          fillOpacity: 0.9,
        });
        if (!isNarrow) {
          stationPoint.bindTooltip(tooltip, {
            direction: "top",
            opacity: 1,
            className: "change-tooltip",
          });
        }
        stationPoint.on("click", () => setSelectedStationId(entry.station.id));
        stationPoint.addTo(areaLayer.current!);
      });
    }
    renderStationAreas();
  }, [areaChanges, baselineYear, data.stations, isNarrow, mapBounds, mapMode, mapReady, selectedStationId, selectedYear]);

  useEffect(() => {
    async function renderDivisionAreas() {
      if (!mapReady || !areaLayer.current || mapMode !== "division") return;
      const leaflet = await loadLeaflet();
      areaLayer.current.clearLayers();

      divisionAreaChanges.forEach((entry) => {
        const selected = entry.division.id === selectedDivisionId;
        const changeLabel = entry.change === null ? "Not available" : formatSigned(entry.change, entry.isRaw);
        const countLabel =
          entry.current === null || entry.baseline === null
            ? "No comparable counts"
            : `${numberFormat.format(entry.baseline)} → ${numberFormat.format(entry.current)} incidents`;
        const tooltip = `
          <div class="area-tooltip">
            <span>Garda Division</span>
            <strong>${escapeHtml(entry.division.name)}</strong>
            <b>${escapeHtml(changeLabel)}</b>
            <small>${baselineYear}–${selectedYear} · ${escapeHtml(countLabel)}</small>
          </div>`;
        const layer = leaflet.geoJSON(entry.division.boundary as never, {
          style: {
            color: isNarrow
              ? selected
                ? "#e07a5f"
                : "rgba(226,238,231,.28)"
              : selected
                ? "#102e26"
                : "rgba(23,55,45,.56)",
            weight: isNarrow ? (selected ? 2.6 : 0.9) : selected ? 3 : 1.4,
            fillColor: changeColour(entry.change, entry.isRaw),
            fillOpacity: isNarrow
              ? entry.change === null
                ? 0.4
                : selected
                  ? 0.98
                  : 0.62
              : entry.change === null
                ? 0.48
                : 0.76,
            className: "reporting-area-cell",
          },
        });
        if (!isNarrow) {
          layer.bindTooltip(tooltip, { sticky: true, direction: "top", opacity: 1, className: "change-tooltip" });
          layer.on("mouseover", () => layer.setStyle({ weight: 3, fillOpacity: 0.9 }));
          layer.on("mouseout", () =>
            layer.setStyle({
              weight: entry.division.id === selectedDivisionId ? 3 : 1.4,
              fillOpacity: entry.change === null ? 0.48 : 0.76,
            }),
          );
        }
        layer.on("click", () => setSelectedDivisionId(entry.division.id));
        layer.addTo(areaLayer.current!);
      });
    }
    renderDivisionAreas();
  }, [baselineYear, divisionAreaChanges, isNarrow, mapMode, mapReady, selectedDivisionId, selectedYear]);

  // Leaflet renders grey wherever its container grew without it noticing, so
  // every change to the map's box has to be followed by invalidateSize().
  // Geography switches are one such change; the resizable sheet is the other.
  useEffect(() => {
    if (!mapReady) return;
    const timeout = window.setTimeout(() => {
      const map = mapInstance.current;
      if (!map) return;
      // Measure first: the map's box differs between the two geographies on
      // mobile (station view reserves a band for the readout), and Leaflet
      // renders grey wherever it fits bounds to a stale size.
      map.invalidateSize({ animate: false, pan: false });
      const bounds = mapMode === "station" ? mapBounds : nationalBounds;
      map.fitBounds(
        [
          [bounds[1], bounds[0]],
          [bounds[3], bounds[2]],
        ],
        { padding: [10, 10] },
      );
    }, 60);
    return () => window.clearTimeout(timeout);
  }, [isNarrow, mapBounds, mapMode, mapReady, nationalBounds]);

  async function submitAskQuestion() {
    const question = askInput.trim();
    if (!question) return;
    setAskStatus("loading");
    setAskError(null);
    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const payload = (await response.json()) as QueryAnswer;
      if (!payload.ok) {
        setAskStatus("error");
        setAskError(payload.reason);
        setAskResult(null);
        return;
      }
      setAskStatus("idle");
      setAskResult(payload);
    } catch {
      setAskStatus("error");
      setAskError("Couldn't reach the query service.");
      setAskResult(null);
    }
  }

  // One place where "point the whole app at this area" is expressed. Crime
  // Bot's "Show on map" and the search overlay both land here, so a bot answer
  // and a search result can never drift into selecting different things.
  function focusOn(target: {
    geography: MapMode;
    areaId?: string | null;
    categoryId?: string | null;
    year?: number | null;
  }) {
    setMapMode(target.geography);
    if (target.year !== null && target.year !== undefined) setSelectedYear(target.year);
    if (target.geography === "station") {
      if (target.areaId) setSelectedStationId(target.areaId);
      if (target.categoryId) setSelectedCategory(target.categoryId);
      return;
    }
    if (target.areaId) setSelectedDivisionId(target.areaId);
    if (target.categoryId && target.categoryId !== "__all__") {
      const group = data.divisionCategories.find(
        (candidate) =>
          candidate.id === target.categoryId ||
          candidate.children.some((child) => child.id === target.categoryId),
      );
      if (group) {
        setSelectedDivisionGroup(group.id);
        setSelectedDivisionDetail(group.id === target.categoryId ? null : target.categoryId);
      }
    }
  }

  function jumpToAskResult() {
    if (!askResult || !askResult.ok) return;
    focusOn({
      geography: askResult.geography,
      areaId: askResult.geography === "station" ? askResult.stationId : askResult.divisionId,
      categoryId: askResult.categoryId,
      year: askResult.year,
    });
  }

  const searchHits = useMemo<SearchHit[]>(() => {
    const needle = normaliseQuery(searchQuery);
    if (!needle) return [];
    const scored: Array<{ tier: number; hit: SearchHit }> = [];

    areaChanges.forEach((entry) => {
      const tier = searchTier(normaliseQuery(entry.station.name), needle);
      if (!tier) return;
      scored.push({
        tier,
        hit: {
          key: `station-${entry.station.id}`,
          kind: "station",
          badge: "ST",
          title: entry.station.name,
          subtitle: `Station area · ${entry.station.division} · ${
            entry.current === null ? "no count" : `${numberFormat.format(entry.current)} in ${selectedYear}`
          }`,
          change: entry.change,
          isRaw: entry.isRaw,
          approximate: false,
          geography: "station",
          areaId: entry.station.id,
        },
      });
    });

    divisionAreaChanges.forEach((entry) => {
      const name = entry.division.name;
      const tier = Math.max(
        searchTier(normaliseQuery(name), needle),
        searchTier(normaliseQuery(name.replace(/ Division$/, "")), needle),
      );
      if (!tier) return;
      scored.push({
        tier,
        hit: {
          key: `division-${entry.division.id}`,
          kind: "division",
          badge: "DV",
          title: name,
          subtitle: `Garda Division · ${
            entry.current === null ? "no comparable count" : `${numberFormat.format(entry.current)} in ${selectedYear}`
          }`,
          change: entry.change,
          isRaw: entry.isRaw,
          approximate: false,
          geography: "division",
          areaId: entry.division.id,
        },
      });
    });

    (data.places ?? []).forEach((place) => {
      const tier = searchTier(normaliseQuery(place.place), needle);
      if (!tier) return;
      const stations = place.stationIds
        .map((id) => data.stations.find((station) => station.id === id))
        .filter((station): station is Station => Boolean(station));
      if (stations.length === 0) return;
      scored.push({
        tier: tier - 0.5,
        hit: {
          key: `place-${place.place}`,
          kind: "place",
          badge: "PL",
          // A place never gets a change figure of its own: it has no boundary
          // and no series. It only says which official area it belongs to.
          title: place.place,
          subtitle: `Place · ${stations.length > 1 ? "nearest station areas are" : "nearest station area is"} ${stations
            .map((station) => station.name)
            .join(" or ")}`,
          change: null,
          isRaw: false,
          approximate: place.confidence === "low",
          geography: "station",
          areaId: stations[0].id,
        },
      });
    });

    return scored
      .sort((a, b) => b.tier - a.tier || a.hit.title.localeCompare(b.hit.title))
      .slice(0, 8)
      .map((entry) => entry.hit);
  }, [areaChanges, data.places, data.stations, divisionAreaChanges, searchQuery, selectedYear]);

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    searchOpener.current?.focus();
  }

  function applySearchHit(hit: SearchHit) {
    focusOn({ geography: hit.geography, areaId: hit.areaId });
    setRecentSearches((previous) => [hit, ...previous.filter((entry) => entry.key !== hit.key)].slice(0, 6));
    closeSearch();
  }

  useEffect(() => {
    if (!searchOpen) return;
    const timeout = window.setTimeout(() => searchInput.current?.focus(), 30);
    return () => window.clearTimeout(timeout);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen]);

  const areaCount = mapMode === "station" ? data.stations.length : data.divisions.length;
  const activeSummary = mapMode === "station" ? summary : divisionSummary;

  // Chips carry the top-level choice for whichever geography is showing:
  // the CJA11 "useful groupings" for stations, the CJQ06 groups for divisions.
  const stationGroupCategories = useMemo(
    () => data.categories.filter((category) => category.kind === "grouped"),
    [data.categories],
  );
  const stationDetailCategories = useMemo(
    () => data.categories.filter((category) => category.kind === "official"),
    [data.categories],
  );
  const activeGroupLabel =
    mapMode === "station"
      ? selectedCategoryCopy.shortLabel
      : selectedDivisionDetailCopy?.label ?? selectedDivisionGroupCopy?.shortLabel ?? "";

  // The nationwide total for the current selection, summed from the same
  // per-area values the map is coloured from — never a separate figure.
  const nationalTotal = useMemo(() => {
    const entries = mapMode === "station" ? areaChanges : divisionAreaChanges;
    let total = 0;
    let any = false;
    entries.forEach((entry) => {
      if (entry.current !== null) {
        total += entry.current;
        any = true;
      }
    });
    return any ? total : null;
  }, [areaChanges, divisionAreaChanges, mapMode]);

  const closeFilterSheet = () => setFilterSheetOpen(false);
  useModalBehaviour(filterSheetOpen, closeFilterSheet, filterSheet);

  // The one figure the mobile map leads with. Both branches read the same
  // entries the map is coloured from; combinedChange returning null means the
  // baseline is too small or missing, which reads as "n/a", never as 0%.
  const readoutChange = mapMode === "station" ? selectedArea?.change ?? null : selectedDivisionArea?.change ?? null;
  const readoutIsRaw = mapMode === "station" ? selectedArea?.isRaw ?? false : selectedDivisionArea?.isRaw ?? false;
  const readoutCurrent = mapMode === "station" ? selectedArea?.current ?? null : selectedDivisionArea?.current ?? null;
  const readoutBaseline = mapMode === "station" ? selectedArea?.baseline ?? null : selectedDivisionArea?.baseline ?? null;
  const readoutName =
    mapMode === "station" ? selectedArea?.station.name ?? "" : selectedDivisionArea?.division.name ?? "";
  const readoutEyebrow =
    mapMode === "station"
      ? `${selectedArea?.station.division ?? "Dublin"} · ${selectedCategoryCopy.shortLabel} · ${selectedYear} vs ${baselineYear}`
      : `${activeGroupLabel} · ${selectedYear} vs ${baselineYear}`;
  const readoutCounts =
    readoutCurrent === null || readoutBaseline === null
      ? "Comparable counts unavailable"
      : `${numberFormat.format(readoutBaseline)} → ${numberFormat.format(readoutCurrent)} recorded incidents`;

  function selectMobileGroup(id: string) {
    if (mapMode === "station") {
      setSelectedCategory(id);
      return;
    }
    setSelectedDivisionGroup(id);
    setSelectedDivisionDetail(null);
  }

  return (
    <main className={`change-map-app${filterSheetOpen ? " ns-behind-sheet" : ""}`}>
      <header className="map-site-header">
        <a href="#atlas" className="map-wordmark" aria-label="Ireland Crime Explorer map">
          <i aria-hidden="true" />
          Ireland Crime Explorer
        </a>
        <p>Official CSO data · through {data.meta.latestCompleteYear}</p>
        <a href="#source">Source &amp; limits</a>
      </header>

      {/* Nightshift header. Rendered on every viewport but shown only under the
          700px breakpoint, so there is no JS viewport test and no hydration
          mismatch — CSS alone decides which header the reader sees. */}
      <header className="ns-header">
        <span className="ns-wordmark">
          <i aria-hidden="true" />
          Crime Explorer
        </span>
        <div className="ns-header-actions">
          <button
            type="button"
            ref={searchOpener}
            className="ns-icon-button"
            aria-label="Search for a place, station or division"
            onClick={() => setSearchOpen(true)}
          >
            {SEARCH_ICON}
          </button>
        </div>
      </header>

      <div className="ns-chiprow" role="group" aria-label="Offence group">
        {(mapMode === "station" ? stationGroupCategories : data.divisionCategories).map((group) => {
          const active =
            mapMode === "station" ? group.id === selectedCategory : group.id === selectedDivisionGroup;
          return (
            <button
              key={group.id}
              type="button"
              className={`ns-chip${active ? " is-selected" : ""}`}
              aria-pressed={active}
              onClick={() => selectMobileGroup(group.id)}
            >
              {group.shortLabel}
            </button>
          );
        })}
        <button type="button" className="ns-chip ns-chip-more" onClick={() => setFilterSheetOpen(true)}>
          All filters
        </button>
      </div>

      <section className="dashboard-toolbar-row">
        <div className="dashboard-toolbar">
          <div className="mode-toggle" role="group" aria-label="Map geography">
            <button
              type="button"
              className={mapMode === "station" ? "active" : ""}
              onClick={() => setMapMode("station")}
            >
              Station <small>{data.stations.length} Dublin areas</small>
            </button>
            <button
              type="button"
              className={mapMode === "division" ? "active" : ""}
              onClick={() => setMapMode("division")}
            >
              Division <small>{data.divisions.length} areas nationwide · real boundaries</small>
            </button>
          </div>

          {mapMode === "station" ? (
            <label htmlFor="crime-type" className="toolbar-field">
              Crime type
              <select
                id="crime-type"
                value={selectedCategory}
                onChange={(event) => setSelectedCategory(event.target.value)}
              >
                <optgroup label="Useful groupings">
                  {data.categories
                    .filter((category) => category.kind === "grouped")
                    .map((category) => (
                      <option value={category.id} key={category.id}>{category.shortLabel}</option>
                    ))}
                </optgroup>
                <optgroup label="Official CJA11 categories">
                  {data.categories
                    .filter((category) => category.kind === "official")
                    .map((category) => (
                      <option value={category.id} key={category.id}>{category.shortLabel}</option>
                    ))}
                </optgroup>
              </select>
            </label>
          ) : (
            <>
              <label htmlFor="offence-group" className="toolbar-field">
                Offence group
                <select
                  id="offence-group"
                  value={selectedDivisionGroup}
                  onChange={(event) => {
                    setSelectedDivisionGroup(event.target.value);
                    setSelectedDivisionDetail(null);
                  }}
                >
                  {data.divisionCategories.map((group) => (
                    <option value={group.id} key={group.id}>{group.shortLabel}</option>
                  ))}
                </select>
              </label>
              <label htmlFor="offence-detail" className="toolbar-field">
                Detail
                <select
                  id="offence-detail"
                  value={selectedDivisionDetail ?? ""}
                  onChange={(event) => setSelectedDivisionDetail(event.target.value || null)}
                >
                  <option value="">All of this group</option>
                  {selectedDivisionGroupCopy?.children.map((child) => (
                    <option value={child.id} key={child.id}>{child.label}</option>
                  ))}
                </select>
              </label>
            </>
          )}

          <label htmlFor="map-year" className="toolbar-field">
            Latest year
            <select
              id="map-year"
              value={selectedYear}
              onChange={(event) => setSelectedYear(Number(event.target.value))}
            >
              {[...data.meta.years].reverse().map((year) => (
                <option value={year} key={year}>{year}</option>
              ))}
            </select>
          </label>
          <label htmlFor="comparison-period" className="toolbar-field">
            Compare with
            <select
              id="comparison-period"
              value={trendPeriod}
              onChange={(event) => setTrendPeriod(event.target.value as TrendPeriod)}
            >
              <option value="year_on_year">Previous year</option>
              <option value="three_year">Three years earlier</option>
              <option value="since_2019">2019</option>
            </select>
          </label>

          {mapMode === "station" ? (
            <>
              <p className="category-description">{selectedCategoryCopy.description}</p>
              {selectedCategoryCopy.availabilityNote && (
                <p className="category-warning">{selectedCategoryCopy.availabilityNote}</p>
              )}
              <p className="category-note">
                Homicide and sexual-offence detail is not published at station level.{" "}
                <button
                  type="button"
                  className="inline-link"
                  onClick={() => {
                    setMapMode("division");
                    setSelectedDivisionGroup("01");
                    setSelectedDivisionDetail(null);
                  }}
                >
                  See it in Division view
                </button>
                .
              </p>
            </>
          ) : (
            <p className="category-description">
              {selectedDivisionDetailCopy?.label ?? `All of: ${selectedDivisionGroupCopy?.label}`}
              {" — official CJQ06 offence code "}
              {selectedDivisionCode}.
            </p>
          )}
        </div>

        <div className="stat-tiles" aria-label={`Area changes from ${baselineYear} to ${selectedYear}`}>
          <div className="stat-tile"><strong>{areaCount}</strong><span>areas</span></div>
          <div className="stat-tile up"><strong>{activeSummary.increased}</strong><span>increased</span></div>
          <div className="stat-tile down"><strong>{activeSummary.decreased}</strong><span>decreased</span></div>
          <div className="stat-tile flat"><strong>{activeSummary.stable}</strong><span>little change</span></div>
        </div>
      </section>

      {ASK_CRIME_BOT_ENABLED && (
      <section className="ask-panel" aria-label="Ask Crime Bot">
        <div className="ask-header">
          <span className="ask-avatar" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
              <path d="M12 2 5 4.5V11c0 5 3 8.5 7 10 4-1.5 7-5 7-10V4.5L12 2Z" />
              <path d="m9.3 12 1.9 1.9 3.7-3.9" />
            </svg>
          </span>
          <div>
            <strong className="ask-title">Ask Crime Bot</strong>
            <span className="ask-subtitle">Ask a question about the data, in plain English</span>
          </div>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitAskQuestion();
          }}
        >
          <label htmlFor="ask-question" className="visually-hidden">Ask Crime Bot a question</label>
          <div className="ask-row">
            <input
              id="ask-question"
              type="text"
              placeholder="e.g. how many burglaries in Dundrum in 2023?"
              value={askInput}
              onChange={(event) => setAskInput(event.target.value)}
              maxLength={300}
            />
            <button type="submit" disabled={askStatus === "loading" || !askInput.trim()}>
              {askStatus === "loading" ? "Asking…" : "Ask"}
            </button>
          </div>
        </form>
        {askStatus === "error" && askError && <p className="ask-error">{askError}</p>}
        {askResult?.ok && (
          <p className="ask-answer">
            <strong>
              {askResult.count === null ? "No comparable data" : numberFormat.format(askResult.count)}
            </strong>{" "}
            {askResult.categoryLabel} incidents in {askResult.areaLabel} in {askResult.year}
            {askResult.compareYear !== null && askResult.changePct !== null && (
              <> — {formatSigned(askResult.changePct)} vs {askResult.compareYear} ({askResult.compareCount === null ? "n/a" : numberFormat.format(askResult.compareCount)})</>
            )}
            .{" "}
            <button type="button" className="inline-link" onClick={jumpToAskResult}>
              Show on map
            </button>
          </p>
        )}
      </section>
      )}

      <section className="dashboard-body" id="atlas">
        <aside className="movers-rail" aria-label="Largest changes">
          {mapMode === "station" ? (
            <>
              <div>
                <p>Largest increases</p>
                {rankedIncreases.slice(0, 3).map((entry) => (
                  <button type="button" key={entry.station.id} onClick={() => setSelectedStationId(entry.station.id)}>
                    <span>{entry.station.name}</span><strong>{formatSigned(entry.change, entry.isRaw)}</strong>
                  </button>
                ))}
              </div>
              <div>
                <p>Largest decreases</p>
                {rankedDecreases.slice(0, 3).map((entry) => (
                  <button type="button" key={entry.station.id} onClick={() => setSelectedStationId(entry.station.id)}>
                    <span>{entry.station.name}</span><strong>{formatSigned(entry.change, entry.isRaw)}</strong>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div>
                <p>Largest increases</p>
                {rankedDivisionIncreases.slice(0, 3).map((entry) => (
                  <button type="button" key={entry.division.id} onClick={() => setSelectedDivisionId(entry.division.id)}>
                    <span>{entry.division.name}</span><strong>{formatSigned(entry.change, entry.isRaw)}</strong>
                  </button>
                ))}
              </div>
              <div>
                <p>Largest decreases</p>
                {rankedDivisionDecreases.slice(0, 3).map((entry) => (
                  <button type="button" key={entry.division.id} onClick={() => setSelectedDivisionId(entry.division.id)}>
                    <span>{entry.division.name}</span><strong>{formatSigned(entry.change, entry.isRaw)}</strong>
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>

        <section
          className={`district-map-panel${mapMode === "station" ? " ns-station-view" : ""}`}
          aria-label="Dublin recorded crime change map"
        >
          <div className="map-panel-heading">
            <div>
              <span>
                {mapMode === "station"
                  ? `All ${data.stations.length} Dublin reporting areas`
                  : `All ${data.divisions.length} Garda Divisions nationwide`}
              </span>
              <strong>
                {mapMode === "station"
                  ? selectedCategoryCopy.shortLabel
                  : selectedDivisionDetailCopy?.label ?? selectedDivisionGroupCopy?.shortLabel}{" "}
                · {baselineYear}–{selectedYear}
              </strong>
            </div>
            <div className="change-legend" aria-label="Percentage-change colour scale">
              <span>Decreased</span>
              <i /><i /><i /><i /><i /><i /><i />
              <span>Increased</span>
            </div>
          </div>

          <div
            ref={mapElement}
            className="district-map"
            aria-label="Map of Dublin recorded-crime reporting areas"
          />

          {mapMode === "station" && availableChanges.length === 0 && (
            <div className="map-no-data">No comparable area data for this selection.</div>
          )}
          {mapMode === "division" && availableDivisionChanges.length === 0 && (
            <div className="map-no-data">No comparable area data for this selection.</div>
          )}

          {/* Nightshift readout. The container never takes a tap — it sits over
              live geography — so it is pointer-events:none and only the
              controls inside it opt back in. */}
          <div className="ns-readout" aria-live="polite">
            <p className="ns-readout-eyebrow">{readoutEyebrow}</p>
            <h2 className="ns-readout-name">{readoutName}</h2>
            <div className="ns-readout-figure">
              <strong className={`tone-${toneOf(readoutChange, readoutIsRaw)}`}>
                {readoutChange === null ? "n/a" : formatSigned(readoutChange, readoutIsRaw)}
              </strong>
              <p>{readoutCounts}</p>
            </div>
          </div>

          {mapMode === "station" ? (
            <article className="selected-area-card" aria-live="polite">
              <span>{selectedArea.station.division}</span>
              <h2>{selectedArea.station.name}</h2>
              <div>
                <strong>{selectedArea.change === null ? "n/a" : formatSigned(selectedArea.change, selectedArea.isRaw)}</strong>
                <p>from {baselineYear} to {selectedYear}</p>
              </div>
              <small>
                {selectedArea.current === null || selectedArea.baseline === null
                  ? "Comparable counts unavailable"
                  : `${numberFormat.format(selectedArea.baseline)} → ${numberFormat.format(selectedArea.current)} recorded incidents`}
              </small>
            </article>
          ) : (
            <article className="selected-area-card division-card" aria-live="polite">
              <span>Garda Division</span>
              <h2>{selectedDivisionArea?.division.name}</h2>
              <div>
                <strong>
                  {selectedDivisionArea?.change === null || selectedDivisionArea?.change === undefined
                    ? "n/a"
                    : formatSigned(selectedDivisionArea.change, selectedDivisionArea.isRaw)}
                </strong>
                <p>from {baselineYear} to {selectedYear}</p>
              </div>
              <small>
                {selectedDivisionArea?.current === null || selectedDivisionArea?.baseline === null
                  ? "Comparable counts unavailable"
                  : `${numberFormat.format(selectedDivisionArea!.baseline!)} → ${numberFormat.format(selectedDivisionArea!.current!)} recorded incidents`}
              </small>

              <div className="quarter-chart">
                <div className="quarter-chart-heading">
                  <span>Quarterly trend</span>
                  <button type="button" onClick={() => setQuarterRangeExpanded((value) => !value)}>
                    {quarterRangeExpanded ? "Show 2019–present" : "Show full history (2003–)"}
                  </button>
                </div>
                {(() => {
                  const { segments, dots } = buildSparkline(divisionQuarterSeries, 100, 34);
                  return segments.length === 0 ? (
                    <p className="quarter-chart-empty">Not enough comparable quarters to chart.</p>
                  ) : (
                    <svg viewBox="0 0 100 34" preserveAspectRatio="none" className="quarter-chart-svg">
                      {segments.map((points, index) => (
                        <polyline key={index} points={points} fill="none" />
                      ))}
                      {dots.map((dot, index) => (
                        <circle key={index} cx={dot.x} cy={dot.y} r={0.9} />
                      ))}
                    </svg>
                  );
                })()}
                <small>
                  {data.meta.quarters[quarterRangeExpanded ? 0 : data.meta.defaultQuarterStartIndex]}
                  {" – "}
                  {data.meta.quarters[data.meta.quarters.length - 1]}
                </small>
              </div>
            </article>
          )}

          <p className="map-guidance">Hover over an area for its exact change · click to pin details</p>
        </section>
      </section>

      {filterSheetOpen && (
        <div className="ns-scrim" onClick={closeFilterSheet}>
          <div
            className="ns-filter-sheet"
            ref={filterSheet}
            role="dialog"
            aria-modal="true"
            aria-label="Filter"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ns-filter-head">
              <h2>Filter</h2>
              <span className="ns-summary-pill">
                {activeSummary.increased} up · {activeSummary.decreased} down
              </span>
            </div>

            <div className="ns-filter-body">
              <p className="ns-eyebrow">Offence group</p>
              <div className="ns-group-rows">
                {(mapMode === "station" ? stationGroupCategories : data.divisionCategories).map((group) => {
                  const active =
                    mapMode === "station" ? group.id === selectedCategory : group.id === selectedDivisionGroup;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      className={`ns-group-row${active ? " is-selected" : ""}`}
                      aria-pressed={active}
                      onClick={() => selectMobileGroup(group.id)}
                    >
                      <span>{group.shortLabel}</span>
                      {active && <i aria-hidden="true">{CHECK_ICON}</i>}
                    </button>
                  );
                })}
              </div>

              <p className="ns-eyebrow">Detail</p>
              <div className="ns-pill-wrap">
                {mapMode === "division" ? (
                  <>
                    <button
                      type="button"
                      className={`ns-pill${selectedDivisionDetail === null ? " is-selected" : ""}`}
                      aria-pressed={selectedDivisionDetail === null}
                      onClick={() => setSelectedDivisionDetail(null)}
                    >
                      All of this group
                    </button>
                    {selectedDivisionGroupCopy?.children.length === 0 && (
                      <p className="ns-note">
                        The CSO publishes no sub-categories for {selectedDivisionGroupCopy?.label} — this group is
                        the finest level available.
                      </p>
                    )}
                    {selectedDivisionGroupCopy?.children.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        className={`ns-pill${selectedDivisionDetail === child.id ? " is-selected" : ""}`}
                        aria-pressed={selectedDivisionDetail === child.id}
                        onClick={() => setSelectedDivisionDetail(child.id)}
                      >
                        {child.label}
                      </button>
                    ))}
                  </>
                ) : (
                  stationDetailCategories.map((category) => (
                    <button
                      key={category.id}
                      type="button"
                      className={`ns-pill${selectedCategory === category.id ? " is-selected" : ""}`}
                      aria-pressed={selectedCategory === category.id}
                      onClick={() => setSelectedCategory(category.id)}
                    >
                      {category.shortLabel}
                    </button>
                  ))
                )}
              </div>

              <p className="ns-eyebrow">Latest year</p>
              <div className="ns-pill-wrap">
                {[...data.meta.years].reverse().map((year) => (
                  <button
                    key={year}
                    type="button"
                    className={`ns-pill${year === selectedYear ? " is-selected" : ""}`}
                    aria-pressed={year === selectedYear}
                    onClick={() => setSelectedYear(year)}
                  >
                    {year}
                  </button>
                ))}
              </div>

              <p className="ns-eyebrow">{selectedYear} compared with</p>
              <div className="ns-period-row">
                {(
                  [
                    ["year_on_year", "Previous year"],
                    ["three_year", "Three years earlier"],
                    ["since_2019", String(data.meta.years[0])],
                  ] as Array<[TrendPeriod, string]>
                ).map(([period, label]) => (
                  <button
                    key={period}
                    type="button"
                    className={`ns-period${trendPeriod === period ? " is-selected" : ""}`}
                    aria-pressed={trendPeriod === period}
                    onClick={() => setTrendPeriod(period)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {mapMode === "station" && selectedCategoryCopy.availabilityNote && (
                <p className="ns-note ns-note-warning">{selectedCategoryCopy.availabilityNote}</p>
              )}
            </div>

            <div className="ns-filter-foot">
              <div>
                <span>
                  {activeGroupLabel} · {selectedYear} vs {baselineYear}
                </span>
                <strong>
                  {nationalTotal === null
                    ? "No comparable counts for this selection"
                    : `${numberFormat.format(nationalTotal)} incidents ${
                        mapMode === "station" ? "across the 41 Dublin areas" : "nationwide"
                      }`}
                </strong>
              </div>
              <button type="button" className="ns-primary" onClick={closeFilterSheet}>
                Show map
              </button>
            </div>
          </div>
        </div>
      )}

      {searchOpen && (
        <div className="ns-overlay ns-search" role="dialog" aria-modal="true" aria-label="Search areas">
          <div className="ns-search-row">
            <div className="ns-search-field">
              {SEARCH_ICON}
              <label htmlFor="ns-search-input" className="visually-hidden">
                Search for a place, station or division
              </label>
              <input
                id="ns-search-input"
                ref={searchInput}
                type="text"
                inputMode="search"
                enterKeyHint="search"
                autoComplete="off"
                placeholder="Place, station or division"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && searchHits[0]) {
                    event.preventDefault();
                    applySearchHit(searchHits[0]);
                  }
                }}
              />
            </div>
            <button type="button" className="ns-search-cancel" onClick={closeSearch}>
              Cancel
            </button>
          </div>

          <div className="ns-search-body">
            {searchQuery.trim() !== "" && (
              <>
                <p className="ns-eyebrow">Matches</p>
                {searchHits.length === 0 ? (
                  <p className="ns-search-empty">
                    Nothing matches “{searchQuery.trim()}”. Try a station, a Garda Division or a Dublin place name.
                  </p>
                ) : (
                  searchHits.map((hit) => (
                    <button key={hit.key} type="button" className="ns-match" onClick={() => applySearchHit(hit)}>
                      <span className="ns-match-badge">{hit.badge}</span>
                      <span className="ns-match-copy">
                        <strong>{hit.title}</strong>
                        <small>{hit.subtitle}</small>
                      </span>
                      {hit.approximate ? (
                        <span className="ns-approx">approx</span>
                      ) : (
                        <span className={`ns-match-change tone-${toneOf(hit.change, hit.isRaw)}`}>
                          {hit.change === null ? "n/a" : formatSigned(hit.change, hit.isRaw)}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </>
            )}

            {recentSearches.length > 0 && (
              <>
                <p className="ns-eyebrow">Recent</p>
                <div className="ns-recents">
                  {recentSearches.map((hit) => (
                    <button key={`recent-${hit.key}`} type="button" onClick={() => applySearchHit(hit)}>
                      {hit.title}
                    </button>
                  ))}
                </div>
              </>
            )}

            <p className="ns-search-footnote">
              A station name is not a suburb boundary — matches say which official area they belong to.
            </p>
          </div>
        </div>
      )}

      <footer id="source" className="map-source-footer">
        <div>
          <span>Data source</span>
          <strong>{mapMode === "station" ? "Central Statistics Office · CJA11" : "Central Statistics Office · CJQ06"}</strong>
        </div>
        <p>
          {mapMode === "station"
            ? <>Values are exact station/sub-district records. Filled cells are approximate areas derived from station locations—not official boundary polygons. {data.meta.dataNote}</>
            : <>Division boundaries are official CSO polygons; offence counts are exact quarterly records. {data.meta.divisionGeographyNote}</>}
        </p>
        <a
          href={
            mapMode === "station"
              ? "https://data.gov.ie/en_GB/dataset/cja11-recorded-crime-incidents-new-garda-operating-model"
              : "https://data.gov.ie/en_GB/dataset/cjq06-recorded-crime-offences-by-type-of-offence-garda-division-and-quarter"
          }
          target="_blank"
          rel="noreferrer"
        >
          Open official dataset ↗
        </a>
      </footer>
    </main>
  );
}
