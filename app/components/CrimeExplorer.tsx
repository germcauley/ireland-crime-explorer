"use client";

import type { LayerGroup, Map as LeafletMap, Polygon as LeafletPolygon } from "leaflet";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { annualSum, percentageChange } from "../lib/analytics";
import type { DashboardData, Division, Station } from "../lib/dashboard-types";
import { RecentReporting } from "./RecentReporting";
import { ReportingView } from "./ReportingView";

type MapMode = "station" | "division";
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

// Peek / half / full. The sheet drags to any height between MIN and MAX and
// settles on whichever of these three is nearest.
const DETENTS = [86, 320, 620];
const SHEET_MIN = 78;
const SHEET_MAX = 660;

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

// Fading a neighbour by dropping its opacity lets the tile layer show through,
// so the surrounding areas revert to a plain street map — the styled surface
// breaks apart exactly when the reader is concentrating on one area. Washing
// the colour toward the canvas instead keeps every polygon opaque, so the map
// stays one surface and the focused area is the only saturated thing on it.
function washToward(colour: string, towards: string, amount: number) {
  const parse = (value: string) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
  const [r1, g1, b1] = parse(colour);
  const [r2, g2, b2] = parse(towards);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * amount);
  return `#${[mix(r1, r2), mix(g1, g2), mix(b1, b2)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

// Voronoi clipping divides by the gap between two vertex distances, which is
// zero on a degenerate edge and yields NaN coordinates. Leaflet throws
// "Invalid LatLng object: (NaN, NaN)" on those and unmounts the whole app, so
// nothing unusable is allowed to reach it: an area that cannot be framed
// simply is not flown to.
function finiteBounds(
  bounds: [[number, number], [number, number]],
): [[number, number], [number, number]] | null {
  return bounds.flat().every(Number.isFinite) ? bounds : null;
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

// Lightweight matching for the place and official-area search.
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
  useEffect(() => {
    closeRef.current = close;
  });

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

const BACK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m14.5 5-7 7 7 7" />
  </svg>
);

const CHEVRON_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9.5 6 6 6-6" />
  </svg>
);

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

/* Theme store. The reader's stored choice wins; absent one, the OS preference
   does, and the app keeps following it as it changes. Kept outside React so
   the same value the pre-paint script in layout.tsx reads is the one rendered. */
const THEME_EVENT = "crime-explorer-theme";

function readTheme(): "light" | "dark" {
  try {
    const stored = window.localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "dark";
  }
}

function setStoredTheme(next: "light" | "dark") {
  try {
    window.localStorage.setItem("theme", next);
  } catch {
    // A blocked store only costs persistence, not the toggle itself.
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}

function subscribeToTheme(onChange: () => void) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  window.addEventListener(THEME_EVENT, onChange);
  return () => {
    query.removeEventListener("change", onChange);
    window.removeEventListener(THEME_EVENT, onChange);
  };
}

// One mark for both directions: a half-filled disc reads as "theme" rather
// than asserting which one you are about to get.
const THEME_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 0 0 0 17Z" fill="currentColor" stroke="none" />
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
  const [selectedBaselineYear, setSelectedBaselineYear] = useState(
    data.meta.years[Math.max(0, data.meta.years.length - 2)],
  );
  const [selectedStationId, setSelectedStationId] = useState("65102");
  const [selectedDivisionId, setSelectedDivisionId] = useState(data.divisions[0]?.id ?? "");
  const [quarterRangeExpanded, setQuarterRangeExpanded] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [recentSearches, setRecentSearches] = useState<SearchHit[]>([]);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [mixOpen, setMixOpen] = useState(false);
  const [openMixGroup, setOpenMixGroup] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  // The layout is CSS-driven, but Leaflet paints polygons into a canvas that
  // no stylesheet can reach, so the map's own palette and its touch behaviour
  // need to know the breakpoint. Starts false so the server render and the
  // first client render agree.
  const [isNarrow, setIsNarrow] = useState(false);
  // The app always has a selected area, so selection alone cannot mean "zoomed
  // in" — the map would open tight on an arbitrary division. This tracks the
  // separate act of a reader choosing an area, which is what earns the zoom.
  // Reporting is a peer of the map rather than a third geography: mapMode
  // drives every layer, bound and legend, and must keep meaning a geography.
  const [view, setView] = useState<"map" | "reporting">("map");
  const [areaFocused, setAreaFocused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  // The theme lives outside React — in localStorage and the OS preference —
  // so it is read as an external store rather than mirrored into state. That
  // also lets the server render a known value and the client correct it after
  // hydration without a mismatch.
  const theme = useSyncExternalStore(subscribeToTheme, readTheme, () => "dark" as const);
  const isDark = theme !== "light";
  const [sheetHeight, setSheetHeight] = useState(DETENTS[0]);
  const sheet = useRef<HTMLElement | null>(null);
  const sheetDrag = useRef<{ startY: number; startHeight: number; moved: boolean; height: number } | null>(null);
  // Leaflet handlers are bound once per render pass of the layer effects; a ref
  // keeps them calling the current selectArea without rebinding every layer.
  const selectAreaRef = useRef<(id: string) => void>(() => {});
  const mapElement = useRef<HTMLDivElement>(null);
  const filterSheet = useRef<HTMLDivElement>(null);
  const mixPanel = useRef<HTMLDivElement>(null);
  const infoPanel = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchOpener = useRef<HTMLButtonElement>(null);
  const mapInstance = useRef<LeafletMap | null>(null);
  const areaLayer = useRef<LayerGroup | null>(null);
  const maskLayer = useRef<LeafletPolygon | null>(null);
  const mapResizeObserver = useRef<ResizeObserver | null>(null);

  const selectedDivisionCode = selectedDivisionDetail ?? selectedDivisionGroup;
  const selectedDivisionGroupCopy =
    data.divisionCategories.find((group) => group.id === selectedDivisionGroup) ?? data.divisionCategories[0];
  const selectedDivisionDetailCopy = selectedDivisionDetail
    ? selectedDivisionGroupCopy?.children.find((child) => child.id === selectedDivisionDetail)
    : undefined;

  const yearIndex = data.meta.years.indexOf(selectedYear);
  const comparisonYears = useMemo(
    () => [...data.meta.years].filter((year) => year < selectedYear).reverse(),
    [data.meta.years, selectedYear],
  );
  const baselineYear = comparisonYears.includes(selectedBaselineYear)
    ? selectedBaselineYear
    : comparisonYears[0] ?? selectedYear;
  const baselineIndex = data.meta.years.indexOf(baselineYear);
  const hasBaseline = baselineIndex >= 0 && baselineIndex < yearIndex;
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
    // Must stay in step with the Nightshift media query in globals.css: a
    // phone held landscape is 844px wide and 390px tall, and the desktop
    // dashboard does not fit in 390px of height.
    const query = window.matchMedia("(max-width: 700px), (max-height: 480px) and (max-width: 900px)");
    const update = () => setIsNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  function toggleTheme() {
    // An explicit choice outranks the system preference from here on.
    setStoredTheme(theme === "dark" ? "light" : "dark");
  }

  // The stylesheet zeroes its own transitions under reduced motion, but the
  // map's fly-to happens in Leaflet, where CSS cannot reach it.
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
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
        maskLayer.current.setStyle({ fillColor: isDark ? "#0d1f19" : "#cfe1e6" });
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
          fillColor: isDark ? "#0d1f19" : "#cfe1e6",
          fillOpacity: 1,
          interactive: false,
        })
        .addTo(mapInstance.current);
    }
    updateMask();
  }, [irelandMaskRings, isDark, isNarrow, mapMode, mapReady]);

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
        // Fractional zoom: with integer steps, fitting Ireland to a phone-sized
        // box lands a whole zoom level short and letterboxes the island.
        zoomSnap: 0,
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
        { padding: [10, 10], animate: false },
      );
      areaLayer.current = leaflet.layerGroup().addTo(map);

      // The map's box changes for reasons React never re-renders for: a font
      // finishing loading, the sheet being dragged, the on-screen keyboard,
      // an orientation change. Watching the element is the only way to be
      // sure Leaflet is never painting at a stale size — which is what grey
      // tiles are. Panning to keep the centre matters here: the sheet takes
      // height off the bottom of the map, and without it the geography walks
      // off the edge as the sheet grows.
      if (typeof ResizeObserver !== "undefined" && mapElement.current) {
        mapResizeObserver.current = new ResizeObserver(() => {
          map.invalidateSize({ animate: false });
        });
        mapResizeObserver.current.observe(mapElement.current);
      }
      setMapReady(true);
    }
    initialiseMap();
    return () => {
      cancelled = true;
      mapResizeObserver.current?.disconnect();
      mapResizeObserver.current = null;
      mapInstance.current?.remove();
      mapInstance.current = null;
      areaLayer.current = null;
      // The layer effects wait on mapReady. Leaving it true across a teardown
      // means the flag never changes on the way back up, so they never re-run
      // and the rebuilt map keeps its tiles but loses every polygon.
      setMapReady(false);
      maskLayer.current = null;
    };
    // `view` is a dependency because the map panel moves between parents when
    // the view changes. React keeps this effect alive across that move, so
    // without it the instance stays bound to a container that has been
    // detached and the new one never paints.
  }, [data.stations, mapBounds, view]);

  useEffect(() => {
    async function renderStationAreas() {
      if (!mapReady || !areaLayer.current || mapMode !== "station") return;
      const leaflet = await loadLeaflet();
      areaLayer.current.clearLayers();

      const restingOpacity = (change: number | null, selected: boolean) => {
        // Focusing an area pushes everything else back rather than hiding it:
        // the neighbours still carry the change scale, they just stop competing
        // with the area being read.
        // Neighbours keep their opacity when focused; they are washed toward
        // the canvas colour instead, so no tile layer shows through.
        // How a fill reads depends on the canvas behind it, not the width.
        if (change === null) return isDark ? 0.4 : 0.48;
        if (isDark) return selected ? 0.98 : 0.62;
        return 0.76;
      };
      const restingStroke = (selected: boolean) => {
        if (areaFocused && !selected) {
          return { color: isDark ? "rgba(226,238,231,.10)" : "rgba(23,55,45,.16)", weight: 0.6 };
        }
        return isDark
          ? { color: selected ? "#e07a5f" : "rgba(226,238,231,.28)", weight: selected ? 2.6 : 0.9 }
          : { color: selected ? "#102e26" : "rgba(23,55,45,.56)", weight: selected ? 3 : 1 };
      };

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
          fillColor:
              areaFocused && !selected
                ? washToward(changeColour(entry.change, entry.isRaw), isDark ? "#0d1f19" : "#cfe1e6", 0.82)
                : changeColour(entry.change, entry.isRaw),
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
              ...restingStroke(selected),
              fillOpacity: restingOpacity(entry.change, selected),
            }),
          );
        }
        polygon.on("click", () => selectAreaRef.current(entry.station.id));
        polygon.addTo(areaLayer.current!);

        // On touch the point is a second, smaller tap target for the same
        // area, so it grows enough to be reachable rather than decorative.
        const stationPoint = leaflet.circleMarker([entry.station.lat, entry.station.lng], {
          radius: isNarrow ? (selected ? 9 : 4.5) : selected ? 4.5 : 2.6,
          color: isNarrow ? "#f6f2e9" : "#f8f5ee",
          weight: isNarrow ? 1.6 : 1,
          fillColor: isDark ? "#12271f" : "#17372d",
          fillOpacity: 0.9,
        });
        if (!isNarrow) {
          stationPoint.bindTooltip(tooltip, {
            direction: "top",
            opacity: 1,
            className: "change-tooltip",
          });
        }
        stationPoint.on("click", () => selectAreaRef.current(entry.station.id));
        stationPoint.addTo(areaLayer.current!);
      });
    }
    renderStationAreas();
  }, [areaChanges, areaFocused, baselineYear, data.stations, isDark, isNarrow, mapBounds, mapMode, mapReady, selectedStationId, selectedYear]);

  useEffect(() => {
    async function renderDivisionAreas() {
      if (!mapReady || !areaLayer.current || mapMode !== "division") return;
      const leaflet = await loadLeaflet();
      areaLayer.current.clearLayers();

      // Same treatment as the station cells: a focused area pushes its
      // neighbours back rather than removing them.
      const restingOpacity = (change: number | null, selected: boolean) => {
        // Neighbours keep their opacity when focused; they are washed toward
        // the canvas colour instead, so no tile layer shows through.
        // How a fill reads depends on the canvas behind it, not the width.
        if (change === null) return isDark ? 0.4 : 0.48;
        if (isDark) return selected ? 0.98 : 0.62;
        return 0.76;
      };
      const restingStroke = (selected: boolean) => {
        if (areaFocused && !selected) {
          return { color: isDark ? "rgba(226,238,231,.10)" : "rgba(23,55,45,.16)", weight: 0.6 };
        }
        return isDark
          ? { color: selected ? "#e07a5f" : "rgba(226,238,231,.28)", weight: selected ? 2.6 : 0.9 }
          : { color: selected ? "#102e26" : "rgba(23,55,45,.56)", weight: selected ? 3 : 1.4 };
      };

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
              ...restingStroke(selected),
            fillColor:
              areaFocused && !selected
                ? washToward(changeColour(entry.change, entry.isRaw), isDark ? "#0d1f19" : "#cfe1e6", 0.82)
                : changeColour(entry.change, entry.isRaw),
            fillOpacity: restingOpacity(entry.change, selected),
            className: "reporting-area-cell",
          },
        });
        if (!isNarrow) {
          layer.bindTooltip(tooltip, { sticky: true, direction: "top", opacity: 1, className: "change-tooltip" });
          layer.on("mouseover", () => layer.setStyle({ weight: 3, fillOpacity: 0.9 }));
          layer.on("mouseout", () =>
            layer.setStyle({
              ...restingStroke(selected),
              fillOpacity: restingOpacity(entry.change, selected),
            }),
          );
        }
        layer.on("click", () => selectAreaRef.current(entry.division.id));
        layer.addTo(areaLayer.current!);
      });
    }
    renderDivisionAreas();
  }, [areaFocused, baselineYear, divisionAreaChanges, isDark, isNarrow, mapMode, mapReady, selectedDivisionId, selectedYear]);

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
      // A focused area owns the viewport; refitting the whole geography here
      // would yank the map back out from under the reader on a sheet drag or
      // an orientation change.
      if (areaFocused) return;
      const bounds = mapMode === "station" ? mapBounds : nationalBounds;
      map.fitBounds(
        [
          [bounds[1], bounds[0]],
          [bounds[3], bounds[2]],
        ],
        { padding: [10, 10], animate: false },
      );
    }, 140);
    return () => window.clearTimeout(timeout);
    // `view` too: the map's box changes shape entirely when it moves beside
    // the reporting list, and bounds fitted to the old one leave Ireland
    // cropped.
  }, [areaFocused, isNarrow, mapBounds, mapMode, mapReady, nationalBounds, view]);

  // Zooming to the focused area. Bounds come from the same geometry the map
  // draws — the division polygon, or the Voronoi cell built for a station —
  // so the frame always matches what is highlighted.
  const focusedBounds = useMemo<[[number, number], [number, number]] | null>(() => {
    if (!areaFocused) return null;
    if (mapMode === "station") {
      const station = data.stations.find((entry) => entry.id === selectedStationId);
      if (!station) return null;
      const cell = buildAreaCell(station, data.stations, mapBounds);
      if (cell.length === 0) return null;
      let minLat = Infinity;
      let minLng = Infinity;
      let maxLat = -Infinity;
      let maxLng = -Infinity;
      cell.forEach(([lat, lng]) => {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      });
      return finiteBounds([
        [minLat, minLng],
        [maxLat, maxLng],
      ]);
    }
    const division = data.divisions.find((entry) => entry.id === selectedDivisionId);
    if (!division) return null;
    const [minLng, minLat, maxLng, maxLat] = geometryBounds(division.boundary);
    return finiteBounds([
      [minLat, minLng],
      [maxLat, maxLng],
    ]);
  }, [areaFocused, data.divisions, data.stations, mapBounds, mapMode, selectedDivisionId, selectedStationId]);

  useEffect(() => {
    if (!mapReady || !focusedBounds) return;
    const map = mapInstance.current;
    if (!map) return;
    // The mobile readout and sheet cover the bottom of the map box, so the
    // frame is padded away from the edges the chrome sits over.
    const padding: [number, number] = isNarrow ? [28, 28] : [40, 40];
    // fitBounds, not flyToBounds. The map runs with zoomSnap: 0 so it can fit
    // Ireland to a phone without letterboxing, and Leaflet's fly-to spline
    // divides by zero at fractional zoom — it hands NaN coordinates to
    // setView, which throws "Invalid LatLng object" and unmounts the app.
    // fitBounds animates without that maths.
    map.fitBounds(focusedBounds, {
      padding,
      animate: !reducedMotion,
      duration: 0.7,
      maxZoom: 12,
    });
  }, [focusedBounds, isNarrow, mapReady, reducedMotion]);

  // Leaving focus returns the map to the whole geography, by the same route it
  // arrived, so the zoom out reads as the reverse of the zoom in.
  const wasFocused = useRef(false);
  useEffect(() => {
    if (!mapReady) return;
    const map = mapInstance.current;
    if (map && wasFocused.current && !areaFocused) {
      const bounds = mapMode === "station" ? mapBounds : nationalBounds;
      map.fitBounds(
        [
          [bounds[1], bounds[0]],
          [bounds[3], bounds[2]],
        ],
        // fitBounds for the same reason as the zoom in: see above.
        { padding: [10, 10], animate: !reducedMotion, duration: 0.6 },
      );
    }
    wasFocused.current = areaFocused;
  }, [areaFocused, mapBounds, mapMode, mapReady, nationalBounds, reducedMotion]);

  // One place where "point the whole app at this area" is expressed. Search
  // results always land here, so place and official-area matches cannot drift.
  // Sub-category depth exists only for divisions, so any switch to station
  // geography puts the drill-down away rather than leaving it open over data
  // it cannot describe.
  function setGeography(mode: MapMode) {
    setMapMode(mode);
    // The two geographies do not share an area, so a focus carried across the
    // switch would frame whichever area happened to be selected in the one
    // being entered. Switching starts from the whole map instead.
    if (mode !== mapMode) setAreaFocused(false);
    if (mode !== "division") {
      setMixOpen(false);
      setPickerOpen(false);
    }
  }

  function focusOn(target: {
    geography: MapMode;
    areaId?: string | null;
    categoryId?: string | null;
    year?: number | null;
  }) {
    setGeography(target.geography);
    if (target.year !== null && target.year !== undefined) setSelectedYear(target.year);
    // Arriving from search is as deliberate as tapping the area, so it earns
    // the same frame — set after setGeography, which clears focus on a switch.
    if (target.areaId) setAreaFocused(true);
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
          subtitle: `Dublin station area · ${entry.station.division} · ${
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
          subtitle: `Garda division nationwide · ${
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
      // A place that shares its name with a station area is the station area
      // as far as the reader is concerned — listing both is a false choice.
      if (data.stations.some((station) => normaliseQuery(station.name) === normaliseQuery(place.place))) return;
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

  // Everything recorded in the selected division, group by group and then
  // child by child. Every value here is annualSum over the same quarters the
  // map uses — the drill-down introduces no second way of counting.
  const offenceMix = useMemo(() => {
    const division = selectedDivisionArea?.division;
    if (!division) return [];
    return data.divisionCategories
      .map((group) => {
        const current = annualSum(division, group.id, selectedYear, data.meta.quarters);
        const baseline = hasBaseline
          ? annualSum(division, group.id, baselineYear, data.meta.quarters)
          : null;
        const { change, isRaw } = combinedChange(current, baseline);
        return {
          group,
          current,
          change,
          isRaw,
          children: group.children.map((child) => {
            const childCurrent = annualSum(division, child.id, selectedYear, data.meta.quarters);
            const childBaseline = hasBaseline
              ? annualSum(division, child.id, baselineYear, data.meta.quarters)
              : null;
            const childChange = combinedChange(childCurrent, childBaseline);
            return { child, current: childCurrent, change: childChange.change, isRaw: childChange.isRaw };
          }),
        };
      })
      .sort((a, b) => (b.current ?? -1) - (a.current ?? -1));
  }, [baselineYear, data.divisionCategories, data.meta.quarters, hasBaseline, selectedDivisionArea, selectedYear]);

  const offenceMixTotal = useMemo(
    () => offenceMix.reduce((total, entry) => total + (entry.current ?? 0), 0),
    [offenceMix],
  );
  const offenceMixLargest = useMemo(
    () => offenceMix.reduce((max, entry) => Math.max(max, entry.current ?? 0), 0),
    [offenceMix],
  );

  // Nationwide counts for the sub-category picker, summed across all divisions
  // for the selected group and each of its children.
  const subCategoryRows = useMemo(() => {
    const group = selectedDivisionGroupCopy;
    if (!group) return [];
    const nationwide = (code: string) => {
      let total = 0;
      let any = false;
      data.divisions.forEach((division) => {
        const value = annualSum(division, code, selectedYear, data.meta.quarters);
        if (value !== null) {
          total += value;
          any = true;
        }
      });
      return any ? total : null;
    };
    const groupTotal = nationwide(group.id);
    return [
      { id: null as string | null, label: `All of ${group.shortLabel}`, count: groupTotal, groupTotal },
      ...group.children.map((child) => ({
        id: child.id,
        label: child.label,
        count: nationwide(child.id),
        groupTotal,
      })),
    ];
  }, [data.divisions, data.meta.quarters, selectedDivisionGroupCopy, selectedYear]);

  const closeMix = () => setMixOpen(false);
  useModalBehaviour(mixOpen, closeMix, mixPanel);

  const closeInfo = () => setInfoOpen(false);
  useModalBehaviour(infoOpen, closeInfo, infoPanel);

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

  // The sheet may not grow past the viewport it lives in — 620px is a full
  // sheet on a portrait phone and an impossibility in landscape.
  function sheetLimit() {
    if (typeof window === "undefined") return SHEET_MAX;
    return Math.max(SHEET_MIN, Math.min(SHEET_MAX, window.innerHeight - 170));
  }

  function settleMap() {
    window.setTimeout(() => mapInstance.current?.invalidateSize({ animate: false }), 30);
  }

  function applySheetHeight(height: number) {
    setSheetHeight(height);
    // React skips the re-render when the height is unchanged, which would
    // strand the inline height the drag wrote directly to the node.
    if (sheet.current) sheet.current.style.height = `${height}px`;
  }

  function onSheetPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    sheetDrag.current = { startY: event.clientY, startHeight: sheetHeight, moved: false, height: sheetHeight };
    sheet.current?.classList.add("is-dragging");
  }

  function onSheetPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = sheetDrag.current;
    if (!drag) return;
    const delta = drag.startY - event.clientY;
    if (Math.abs(delta) > 3) drag.moved = true;
    const height = Math.max(SHEET_MIN, Math.min(sheetLimit(), drag.startHeight + delta));
    drag.height = height;
    // Written straight to the node: the drag changes one property and never
    // re-renders the list underneath it.
    if (sheet.current) sheet.current.style.height = `${height}px`;
  }

  function onSheetPointerUp() {
    const drag = sheetDrag.current;
    sheetDrag.current = null;
    sheet.current?.classList.remove("is-dragging");
    if (!drag) return;
    const limit = sheetLimit();
    const detents = DETENTS.map((detent) => Math.min(detent, limit));
    const target = drag.moved
      ? detents.reduce((best, detent) =>
          Math.abs(detent - drag.height) < Math.abs(best - drag.height) ? detent : best,
        )
      : // A tap cycles peek → half → full → peek.
        detents[(detents.findIndex((detent) => Math.abs(detent - drag.height) < 40) + 1) % detents.length];
    applySheetHeight(target);
    settleMap();
  }

  function onSheetKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const limit = sheetLimit();
    const step = (delta: number) =>
      applySheetHeight(Math.max(SHEET_MIN, Math.min(limit, sheetHeight + delta)));
    if (event.key === "ArrowUp") step(40);
    else if (event.key === "ArrowDown") step(-40);
    else if (event.key === "Home") applySheetHeight(Math.min(DETENTS[0], limit));
    else if (event.key === "End") applySheetHeight(Math.min(DETENTS[DETENTS.length - 1], limit));
    else if (event.key === "Enter" || event.key === " ") {
      const detents = DETENTS.map((detent) => Math.min(detent, limit));
      applySheetHeight(detents[(detents.findIndex((d) => Math.abs(d - sheetHeight) < 40) + 1) % detents.length]);
    } else return;
    event.preventDefault();
    settleMap();
  }

  const sheetHint =
    sheetHeight <= DETENTS[0] + 40
      ? `Open optional comparison of all ${areaCount} areas`
      : sheetHeight >= DETENTS[2] - 40
        ? "Drag down for the map"
        : "Drag to resize";

  // Every area, ranked — the sheet is the full list, not the desktop rail's
  // top three. Areas with no comparable change sort to the bottom.
  const moverRows = useMemo(() => {
    const rows =
      mapMode === "station"
        ? areaChanges.map((entry) => ({
            id: entry.station.id,
            name: entry.station.name,
            change: entry.change,
            isRaw: entry.isRaw,
            current: entry.current,
          }))
        : divisionAreaChanges.map((entry) => ({
            id: entry.division.id,
            name: entry.division.name,
            change: entry.change,
            isRaw: entry.isRaw,
            current: entry.current,
          }));
    return rows.sort((a, b) => {
      if (a.change === null) return b.change === null ? a.name.localeCompare(b.name) : 1;
      if (b.change === null) return -1;
      return b.change - a.change;
    });
  }, [areaChanges, divisionAreaChanges, mapMode]);

  const largestMove = useMemo(
    () => moverRows.reduce((max, row) => Math.max(max, row.change === null ? 0 : Math.abs(row.change)), 0),
    [moverRows],
  );

  // Every way a reader can pick an area — a polygon, a station point, a movers
  // row, a search result — goes through here, so the zoom is never something
  // only one of those routes gets.
  // id -> name, so a reporting item can name the Division it belongs to.
  const divisionNames = useMemo(
    () => Object.fromEntries(data.divisions.map((d) => [d.id, d.name])),
    [data.divisions],
  );
  const divisionCounties = useMemo(
    () =>
      Object.fromEntries(
        data.divisions.map((d) => {
          const stem = d.name.replace(" Division", "");
          // The DMR Divisions cover no county a headline would name.
          const counties = stem.startsWith("DMR")
            ? ["Dublin"]
            : stem.split("/").map((part) => part.replace(/\s+(City|North|South|East|West)$/, ""));
          return [d.id, counties];
        }),
      ),
    [data.divisions],
  );
  const groupLabels = useMemo(
    () => Object.fromEntries(data.divisionCategories.map((g) => [g.id, g.shortLabel])),
    [data.divisionCategories],
  );

  // Selecting a Division from an article. Where the map sits beside the list
  // there is nothing to navigate to — moving it in place keeps the reader's
  // position in the list. Below that width the map is not rendered, so the
  // only way to show the geography is to switch to it.
  function focusDivisionFromReporting(id: string) {
    const sideMapVisible =
      typeof window !== "undefined" && window.matchMedia("(min-width: 1101px)").matches;
    if (!sideMapVisible) setView("map");
    setGeography("division");
    setSelectedDivisionId(id);
    setAreaFocused(true);
  }

  function selectArea(id: string) {
    if (mapMode === "station") setSelectedStationId(id);
    else setSelectedDivisionId(id);
    setAreaFocused(true);
  }

  function clearAreaFocus() {
    setAreaFocused(false);
  }

  useEffect(() => {
    selectAreaRef.current = selectArea;
  });

  function selectMobileGroup(id: string) {
    if (mapMode === "station") {
      setSelectedCategory(id);
      return;
    }
    setSelectedDivisionGroup(id);
    setSelectedDivisionDetail(null);
  }

  // The map is declared once and placed by whichever view is showing. Two
  // copies would mean two Leaflet instances fighting over one ref.
  const mapPanel = (
        <section
          className={`district-map-panel${mapMode === "station" ? " ns-station-view" : ""}`}
          aria-label={mapMode === "station" ? "Dublin station-area recorded-crime map" : "Garda-division recorded-crime map of Ireland"}
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
            aria-label={mapMode === "station" ? "Map of Dublin station-area recorded-crime reporting geographies" : "Map of Garda divisions nationwide"}
          />

          {mapMode === "station" && availableChanges.length === 0 && (
            <div className="map-no-data">No comparable area data for this selection.</div>
          )}
          {mapMode === "division" && availableDivisionChanges.length === 0 && (
            <div className="map-no-data">No comparable area data for this selection.</div>
          )}

          {mapMode === "station" && (
            <p className="ns-map-caveat">Cells approximate areas from station points — not official boundaries.</p>
          )}

          {/* The way back out of a focused area. Only rendered while a focus is
              held, so it never occupies the map when it would do nothing. The
              visible label shortens on a phone, where the caveat chip shares
              this row, so the full wording lives on the button itself and stays
              the accessible name at every width. */}
          {areaFocused && (
            <button
              type="button"
              className="area-focus-clear"
              onClick={clearAreaFocus}
              aria-label="Return to full map"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span aria-hidden="true">Return to full map</span>
            </button>
          )}

          {/* Nightshift readout. The container never takes a tap — it sits over
              live geography — so it is pointer-events:none and only the
              controls inside it opt back in. */}
          {/* Past the half detent there is too little map left for the full
              readout, so it collapses to the one-line label the sub-category
              screen uses. */}
          <div className={`ns-readout${sheetHeight > DETENTS[1] + 40 ? " is-compact" : ""}`} aria-live="polite">
            <p className="ns-readout-eyebrow">{readoutEyebrow}</p>
            <h2 className="ns-readout-name">{readoutName}</h2>
            <div className="ns-readout-figure">
              <strong className={`tone-${toneOf(readoutChange, readoutIsRaw)}`}>
                {readoutChange === null ? "n/a" : formatSigned(readoutChange, readoutIsRaw)}
              </strong>
              <p>{readoutCounts}</p>
            </div>
            {mapMode === "division" && (
              <button type="button" className="ns-readout-push" onClick={() => setMixOpen(true)}>
                Full offence mix
                <span aria-hidden="true">→</span>
              </button>
            )}
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
  );

  return (
    <main className={`change-map-app${filterSheetOpen ? " ns-behind-sheet" : ""}`}>
      <header className="map-site-header">
        <a href="#atlas" className="map-wordmark" aria-label="Ireland Crime Explorer map">
          <i aria-hidden="true" />
          Ireland Crime Explorer
        </a>
        <p>Official CSO data · through {data.meta.latestCompleteYear}</p>
        <div className="site-header-end">
          <button
            type="button"
            className="theme-toggle"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-pressed={theme === "dark"}
            onClick={toggleTheme}
          >
            {THEME_ICON}
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <a href="#source">Source &amp; limits</a>
        </div>
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
            className="ns-icon-button"
            aria-label="Search for a town, suburb or place"
            onClick={() => setSearchOpen(true)}
          >
            {SEARCH_ICON}
          </button>
          <button
            type="button"
            className="ns-icon-button ns-icon-muted"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-pressed={theme === "dark"}
            onClick={toggleTheme}
          >
            {THEME_ICON}
          </button>
          <button
            type="button"
            className="ns-icon-button ns-icon-muted"
            aria-label="Data caveats and sources"
            aria-expanded={infoOpen}
            onClick={() => setInfoOpen(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5.5M12 7.6v.1" />
            </svg>
          </button>
        </div>
      </header>

      <section className="place-entry" aria-labelledby="place-entry-title">
        <div>
          <p>Explore official recorded-crime data</p>
          <h1 id="place-entry-title">Start with a place you know</h1>
          <span>Search a town, suburb, Dublin station area or Garda division.</span>
        </div>
        <button type="button" ref={searchOpener} onClick={() => setSearchOpen(true)}>
          {SEARCH_ICON}
          <span>Search for a town, suburb or place</span>
          <kbd>Search</kbd>
        </button>
      </section>

      <div className="ns-geo" role="group" aria-label="Map geography">
        <button
          type="button"
          className={view === "map" && mapMode === "station" ? "is-active" : ""}
          aria-pressed={view === "map" && mapMode === "station"}
          onClick={() => { setView("map"); setGeography("station"); }}
        >
          Dublin station areas
          <small>{data.stations.length} areas · annual</small>
        </button>
        <button
          type="button"
          className={view === "map" && mapMode === "division" ? "is-active" : ""}
          aria-pressed={view === "map" && mapMode === "division"}
          onClick={() => { setView("map"); setGeography("division"); }}
        >
          Garda divisions nationwide
          <small>{data.divisions.length} areas · quarterly</small>
        </button>
        <button
          type="button"
          className={view === "reporting" ? "is-active" : ""}
          aria-pressed={view === "reporting"}
          onClick={() => setView("reporting")}
        >
          Recent reporting
          <small>what outlets published</small>
        </button>
      </div>

      <div className="mobile-period-controls" aria-label="Time period">
        <label>
          Year
          <select value={selectedYear} onChange={(event) => setSelectedYear(Number(event.target.value))}>
            {[...data.meta.years].reverse().map((year) => <option value={year} key={year}>{year}</option>)}
          </select>
        </label>
        <label>
          Compare with
          <select value={baselineYear} onChange={(event) => setSelectedBaselineYear(Number(event.target.value))}>
            {comparisonYears.map((year) => <option value={year} key={year}>{year}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => setFilterSheetOpen(true)}>All filters</button>
      </div>

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
              className={view === "map" && mapMode === "station" ? "active" : ""}
              onClick={() => { setView("map"); setGeography("station"); }}
            >
              Dublin station areas <small>{data.stations.length} areas · annual</small>
            </button>
            <button
              type="button"
              className={view === "map" && mapMode === "division" ? "active" : ""}
              onClick={() => { setView("map"); setGeography("division"); }}
            >
              Garda divisions nationwide <small>{data.divisions.length} official areas · quarterly</small>
            </button>
            <button
              type="button"
              className={view === "reporting" ? "active" : ""}
              onClick={() => setView("reporting")}
            >
              Recent reporting <small>what outlets published</small>
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
              value={baselineYear}
              onChange={(event) => setSelectedBaselineYear(Number(event.target.value))}
            >
              {comparisonYears.map((year) => <option value={year} key={year}>{year}</option>)}
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
                    setGeography("division");
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

      {view === "reporting" ? (
        <div className="reporting-layout">
          <ReportingView
            divisionNames={divisionNames}
            divisionCounties={divisionCounties}
            groupLabels={groupLabels}
            onSelectDivision={focusDivisionFromReporting}
          />
          {/* The same map, alongside rather than instead of the list. Clicking a
              Division in an article moves it here, so the geography a headline
              names stays visible while reading. Hidden below the breakpoint —
              mobile keeps the list on its own for now. */}
          <aside className="reporting-map" aria-label="Recorded-crime map">
            {mapPanel}
          </aside>
        </div>
      ) : (
        <>
        <section className="result-summary" aria-labelledby="result-summary-title" aria-live="polite">
          <div className="result-summary-copy">
            <p>{mapMode === "station" ? "Dublin station area" : "Garda division nationwide"}</p>
            <h2 id="result-summary-title">{readoutName}</h2>
            <span>{readoutEyebrow}</span>
          </div>
          <div className="result-summary-figure">
            <strong className={`tone-${toneOf(readoutChange, readoutIsRaw)}`}>
              {readoutChange === null ? "Not comparable" : formatSigned(readoutChange, readoutIsRaw)}
            </strong>
            <span>{readoutCounts}</span>
          </div>
          <p className="result-summary-note">
            These are recorded incidents, not total crime or a safety score.
            {mapMode === "station" && " Station-area cells are approximate, not official neighbourhood boundaries."}
          </p>
          <button type="button" onClick={() => setInfoOpen(true)}>How to read this result</button>
        </section>

        {/* Reporting sits beneath the numbers by construction: a reader has to
            have passed the result summary to reach it. Division only — see the
            note in RecentReporting. Articles are classified to CJQ06 groups, so
            a selected sub-category is narrowed to its parent rather than
            matching nothing. */}
        {mapMode === "division" && (
          <RecentReporting
            divisionId={selectedDivisionArea?.division.id ?? null}
            divisionName={selectedDivisionArea?.division.name ?? ""}
            group={selectedDivisionGroupCopy?.id ?? null}
            groupLabel={selectedDivisionGroupCopy?.shortLabel ?? "this offence group"}
          />
        )}

        <section className="dashboard-body" id="atlas">
          <aside className="movers-rail" aria-label="Optional area comparison">
            {mapMode === "station" ? (
              <>
                <div>
                  <p>Compare areas · increases</p>
                  {rankedIncreases.slice(0, 3).map((entry) => (
                    <button type="button" key={entry.station.id} onClick={() => selectArea(entry.station.id)}>
                      <span>{entry.station.name}</span><strong>{formatSigned(entry.change, entry.isRaw)}</strong>
                    </button>
                  ))}
                </div>
                <div>
                  <p>Compare areas · decreases</p>
                  {rankedDecreases.slice(0, 3).map((entry) => (
                    <button type="button" key={entry.station.id} onClick={() => selectArea(entry.station.id)}>
                      <span>{entry.station.name}</span><strong>{formatSigned(entry.change, entry.isRaw)}</strong>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div>
                  <p>Compare areas · increases</p>
                  {rankedDivisionIncreases.slice(0, 3).map((entry) => (
                    <button type="button" key={entry.division.id} onClick={() => selectArea(entry.division.id)}>
                      <span>{entry.division.name}</span><strong>{formatSigned(entry.change, entry.isRaw)}</strong>
                    </button>
                  ))}
                </div>
                <div>
                  <p>Compare areas · decreases</p>
                  {rankedDivisionDecreases.slice(0, 3).map((entry) => (
                    <button type="button" key={entry.division.id} onClick={() => selectArea(entry.division.id)}>
                      <span>{entry.division.name}</span><strong>{formatSigned(entry.change, entry.isRaw)}</strong>
                    </button>
                  ))}
                </div>
              </>
            )}
          </aside>

          {mapPanel}
        </section>

        <section
          className="ns-sheet"
          ref={sheet}
          style={{ height: sheetHeight }}
          aria-label="Optional comparison of areas by change"
          onTransitionEnd={(event) => {
            if (event.propertyName === "height") mapInstance.current?.invalidateSize({ animate: false });
          }}
        >
          {/* A resize grip is a separator, not a button: it has a value (the
              height) rather than an action. That is what ARIA's separator role
              is for, and it has to be focusable to be operable by keyboard, so
              the two rules below are answered by the role itself. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div
            className="ns-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the area comparison sheet"
            aria-valuenow={sheetHeight}
            aria-valuemin={SHEET_MIN}
            aria-valuemax={SHEET_MAX}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            onPointerDown={onSheetPointerDown}
            onPointerMove={onSheetPointerMove}
            onPointerUp={onSheetPointerUp}
            onPointerCancel={onSheetPointerUp}
            onKeyDown={onSheetKeyDown}
          >
            <i aria-hidden="true" />
            <span>{sheetHint}</span>
          </div>

          {pickerOpen ? (
            <div className="ns-sheet-head">
              <button
                type="button"
                className="ns-icon-button"
                aria-label="Back to the movers list"
                onClick={() => setPickerOpen(false)}
              >
                {BACK_ICON}
              </button>
              <strong>
                <span className="ns-crumb">{selectedDivisionGroupCopy?.shortLabel}</span>
                {selectedDivisionDetailCopy ? ` › ${selectedDivisionDetailCopy.label}` : " › All of this group"}
              </strong>
            </div>
          ) : (
            <div className="ns-sheet-head">
              <strong>Compare areas · {activeGroupLabel}</strong>
            </div>
          )}

          {pickerOpen && (
            <div className="ns-sheet-body">
              <p className="ns-eyebrow">Sub-categories · nationwide {selectedYear}</p>
              {subCategoryRows.map((row) => {
                const selected = selectedDivisionDetail === row.id;
                const share =
                  row.count === null || !row.groupTotal ? 0 : Math.min(100, (row.count / row.groupTotal) * 100);
                return (
                  <button
                    key={row.id ?? "all"}
                    type="button"
                    className={`ns-pick${selected ? " is-selected" : ""}`}
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setSelectedDivisionDetail(row.id)}
                  >
                    <span className={`ns-radio${selected ? " is-selected" : ""}`} aria-hidden="true" />
                    <span className="ns-pick-label">
                      {row.label}
                      <i aria-hidden="true" style={{ width: `${Math.max(3, share)}%` }} />
                    </span>
                    <span className="ns-pick-value">
                      <b>{row.count === null ? "n/a" : numberFormat.format(row.count)}</b>
                      <small>{row.count === null || !row.groupTotal ? "—" : `${Math.round(share)}%`}</small>
                    </span>
                  </button>
                );
              })}
              {selectedDivisionGroupCopy?.children.length === 0 && (
                <p className="ns-note ns-sheet-note">
                  The CSO publishes no sub-categories for this group — {selectedDivisionGroupCopy.label} is the
                  finest level available.
                </p>
              )}
              {selectedDivisionGroup === "09" && <p className="ns-note ns-note-warning">{data.meta.fraudNote}</p>}
              <p className="ns-note ns-sheet-note">
                Where the earlier count is too small for a percentage to carry meaning, the change is reported as a
                raw difference — +3 rather than +150%.
              </p>
            </div>
          )}

          <div className="ns-sheet-body" hidden={pickerOpen}>
            {moverRows.map((row, index) => (
              <button
                key={row.id}
                type="button"
                className="ns-mover"
                onClick={() => selectArea(row.id)}
              >
                <span className="ns-mover-rank">{index + 1}</span>
                <span className="ns-mover-name">
                  {row.name}
                  <i
                    aria-hidden="true"
                    style={{
                      width:
                        largestMove === 0 || row.change === null
                          ? 0
                          : `${Math.max(4, (Math.abs(row.change) / largestMove) * 100)}%`,
                      background: changeColour(row.change, row.isRaw),
                    }}
                  />
                </span>
                <span className="ns-mover-value">
                  <b className={`tone-${toneOf(row.change, row.isRaw)}`}>
                    {row.change === null ? "n/a" : formatSigned(row.change, row.isRaw)}
                  </b>
                  <small>{row.current === null ? "no count" : numberFormat.format(row.current)}</small>
                </span>
              </button>
            ))}

            {mapMode === "station" && (
              <p className="ns-note ns-sheet-note">
                CJA11 publishes 14 broad groups per station area and no finer detail — sub-categories, and homicide
                and sexual-offence figures, are Division-only.{" "}
                <button
                  type="button"
                  className="ns-inline-link"
                  onClick={() => {
                    setGeography("division");
                    setSelectedDivisionGroup("01");
                    setSelectedDivisionDetail(null);
                  }}
                >
                  See them in Division view
                </button>
                .
              </p>
            )}
          </div>
        </section>

        {infoOpen && (
          <div
            className="ns-overlay ns-info"
            ref={infoPanel}
            role="dialog"
            aria-modal="true"
            aria-label="What this data is, and is not"
          >
            <div className="ns-mix-head">
              <button type="button" className="ns-icon-button" aria-label="Back to the map" onClick={closeInfo}>
                {BACK_ICON}
              </button>
              <div>
                <strong>What this shows</strong>
                <small>Official CSO data · through {data.meta.latestCompleteYear}</small>
              </div>
            </div>

            <div className="ns-mix-body">
              <p className="ns-eyebrow">Read this first</p>
              <p className="ns-note ns-note-warning">{data.meta.dataNote}</p>
              <p className="ns-note">{data.meta.geographyNote}</p>
              <p className="ns-note">{data.meta.divisionGeographyNote}</p>
              <p className="ns-note">{data.meta.fraudNote}</p>
              <p className="ns-note">{data.meta.vehicleNote}</p>
              <p className="ns-note">
                Homicide and sexual-offence detail, and the 84 official sub-categories, are published for Garda
                Divisions only — never for a station area.
              </p>

              <p className="ns-eyebrow">Data source</p>
              <div className="ns-source">
                <strong>
                  {mapMode === "station"
                    ? "Central Statistics Office · CJA11"
                    : "Central Statistics Office · CJQ06"}
                </strong>
                <p>
                  {mapMode === "station"
                    ? "Values are exact station/sub-district records. Filled cells are approximate areas derived from station locations — not official boundary polygons."
                    : "Division boundaries are official CSO polygons; offence counts are exact quarterly records."}
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
              </div>
            </div>
          </div>
        )}

        {mixOpen && (
          <div className="ns-overlay ns-mix" ref={mixPanel} role="dialog" aria-modal="true" aria-label="Offence mix">
            <div className="ns-mix-head">
              <button type="button" className="ns-icon-button" aria-label="Back to the map" onClick={closeMix}>
                {BACK_ICON}
              </button>
              <div>
                <strong>{selectedDivisionArea?.division.name}</strong>
                <small>
                  {offenceMixTotal === 0
                    ? "No comparable counts for this year"
                    : `${numberFormat.format(offenceMixTotal)} recorded incidents`}{" "}
                  · {selectedYear} vs {baselineYear}
                </small>
              </div>
            </div>

            <div className="ns-mix-body">
              <p className="ns-eyebrow">Offence mix · official CJQ06 groups</p>
              {offenceMix.map((entry) => {
                const open = openMixGroup === entry.group.id;
                const share = offenceMixTotal === 0 ? 0 : ((entry.current ?? 0) / offenceMixTotal) * 100;
                const barWidth = offenceMixLargest === 0 ? 0 : ((entry.current ?? 0) / offenceMixLargest) * 100;
                return (
                  <div key={entry.group.id} className={`ns-mix-group${open ? " is-open" : ""}`}>
                    <button
                      type="button"
                      className="ns-mix-row"
                      aria-expanded={open}
                      onClick={() => setOpenMixGroup(open ? null : entry.group.id)}
                    >
                      <span className="ns-mix-label">
                        {entry.group.shortLabel}
                        <i
                          aria-hidden="true"
                          style={{ width: `${Math.max(3, barWidth)}%`, background: changeColour(entry.change, entry.isRaw) }}
                        />
                        <small>{offenceMixTotal === 0 ? "no share" : `${Math.round(share)}% of all recorded`}</small>
                      </span>
                      <span className="ns-mix-value">
                        <b>{entry.current === null ? "n/a" : numberFormat.format(entry.current)}</b>
                        <em className={`tone-${toneOf(entry.change, entry.isRaw)}`}>
                          {entry.change === null ? "n/a" : formatSigned(entry.change, entry.isRaw)}
                        </em>
                      </span>
                      <span className="ns-mix-chevron" aria-hidden="true">
                        {CHEVRON_ICON}
                      </span>
                    </button>

                    {open &&
                      (entry.children.length === 0 ? (
                        <p className="ns-note">
                          The CSO publishes no sub-categories for this group — {entry.group.label} is the finest
                          level available.
                        </p>
                      ) : (
                        entry.children.map((child) => (
                          <button
                            key={child.child.id}
                            type="button"
                            className="ns-mix-child"
                            onClick={() => {
                              // Picking a child both filters the map and takes
                              // the reader to the picker, so the recolouring is
                              // visible rather than happening behind a screen.
                              setSelectedDivisionGroup(entry.group.id);
                              setSelectedDivisionDetail(child.child.id);
                              setMixOpen(false);
                              setPickerOpen(true);
                              applySheetHeight(Math.min(DETENTS[1], sheetLimit()));
                            }}
                          >
                            <span className="ns-mix-label">
                              {child.child.label}
                              <i
                                aria-hidden="true"
                                style={{
                                  width: `${
                                    entry.current
                                      ? Math.max(3, ((child.current ?? 0) / entry.current) * 100)
                                      : 3
                                  }%`,
                                  background: changeColour(child.change, child.isRaw),
                                }}
                              />
                            </span>
                            <span className="ns-mix-value">
                              <b>{child.current === null ? "n/a" : numberFormat.format(child.current)}</b>
                              <em className={`tone-${toneOf(child.change, child.isRaw)}`}>
                                {child.change === null ? "n/a" : formatSigned(child.change, child.isRaw)}
                              </em>
                            </span>
                          </button>
                        ))
                      ))}
                  </div>
                );
              })}

              <p className="ns-note">
                This depth is Division-only. CJA11 publishes 14 broad groups per Dublin station area and never
                splits them, so the same breakdown cannot be shown for a station.
              </p>
              <p className="ns-note">{data.meta.fraudNote}</p>
            </div>
          </div>
        )}

        {filterSheetOpen && (
          <div className="ns-scrim">
            <button type="button" className="ns-scrim-dismiss" aria-label="Close the filter sheet" onClick={closeFilterSheet} />
            <div className="ns-filter-sheet" ref={filterSheet} role="dialog" aria-modal="true" aria-label="Filter">
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
                  {comparisonYears.map((year) => (
                    <button
                      key={year}
                      type="button"
                      className={`ns-period${baselineYear === year ? " is-selected" : ""}`}
                      aria-pressed={baselineYear === year}
                      onClick={() => setSelectedBaselineYear(year)}
                    >
                      {year}
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
                        ) : hit.change === null ? (
                          // Places have no series of their own, and an area with
                          // no comparable baseline has no figure to show. Neither
                          // gets a number invented for it.
                          <span className="ns-match-change tone-flat" aria-hidden="true">
                            →
                          </span>
                        ) : (
                          <span className={`ns-match-change tone-${toneOf(hit.change, hit.isRaw)}`}>
                            {formatSigned(hit.change, hit.isRaw)}
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

        </>
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
