"use client";

import type { LayerGroup, Map as LeafletMap } from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";

type Category = {
  id: string;
  label: string;
  shortLabel: string;
  kind: "grouped" | "official";
  description: string;
  availabilityNote?: string;
};

type Station = {
  id: string;
  name: string;
  division: string;
  lat: number;
  lng: number;
  contextNote: string;
  series: Record<string, Array<number | null>>;
};

type DivisionCategoryChild = { id: string; label: string };
type DivisionCategory = {
  id: string;
  label: string;
  shortLabel: string;
  children: DivisionCategoryChild[];
};

type GeoJSONGeometry = {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown;
};

type Division = {
  id: string;
  name: string;
  boundary: GeoJSONGeometry;
  series: Record<string, Array<number | null>>;
};

type DashboardData = {
  meta: {
    latestCompleteYear: number;
    years: number[];
    quarters: string[];
    defaultQuarterStartIndex: number;
    dataNote: string;
    geographyNote: string;
    divisionGeographyNote: string;
  };
  categories: Category[];
  divisionCategories: DivisionCategory[];
  stations: Station[];
  divisions: Division[];
};

type MapMode = "station" | "division";
type TrendPeriod = "year_on_year" | "three_year" | "since_2019";
type Point = { x: number; y: number };
type AreaChange = {
  station: Station;
  current: number | null;
  baseline: number | null;
  change: number | null;
};
type DivisionAreaChange = {
  division: Division;
  current: number | null;
  baseline: number | null;
  change: number | null;
};

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

function percentageChange(current: number | null, baseline: number | null) {
  if (current === null || baseline === null || baseline < 10) return null;
  return ((current - baseline) / baseline) * 100;
}

function quarterYear(quarter: string) {
  return Number(quarter.slice(0, 4));
}

function annualSum(
  division: Division,
  code: string,
  year: number,
  quarters: string[],
): number | null {
  const series = division.series[code];
  if (!series) return null;
  let total = 0;
  let any = false;
  quarters.forEach((quarter, index) => {
    if (quarterYear(quarter) !== year) return;
    const value = series[index];
    if (value !== null) {
      total += value;
      any = true;
    }
  });
  return any ? total : null;
}

function formatSigned(value: number) {
  return `${value > 0 ? "+" : ""}${oneDecimal.format(value)}%`;
}

function changeColour(value: number | null) {
  if (value === null) return "#b9b6ae";
  if (value >= 25) return "#8f2f27";
  if (value >= 10) return "#bd5941";
  if (value > 2) return "#df9870";
  if (value >= -2) return "#e8e1d4";
  if (value >= -10) return "#a8bc96";
  if (value >= -25) return "#6f9674";
  return "#376b54";
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

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function CrimeExplorer({ data }: { data: DashboardData }) {
  const [mapMode, setMapMode] = useState<MapMode>("station");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [selectedDivisionGroup, setSelectedDivisionGroup] = useState(data.divisionCategories[2]?.id ?? "03");
  const [selectedDivisionDetail, setSelectedDivisionDetail] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState(data.meta.latestCompleteYear);
  const [trendPeriod, setTrendPeriod] = useState<TrendPeriod>("year_on_year");
  const [selectedStationId, setSelectedStationId] = useState("65102");
  const [selectedDivisionId, setSelectedDivisionId] = useState(data.divisions[0]?.id ?? "");
  const [quarterRangeExpanded, setQuarterRangeExpanded] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const mapElement = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<LeafletMap | null>(null);
  const areaLayer = useRef<LayerGroup | null>(null);

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
        return {
          station,
          current,
          baseline,
          change: percentageChange(current, baseline),
        };
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
          if (entry.change > 2) result.increased += 1;
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
        return { division, current, baseline, change: percentageChange(current, baseline) };
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
          if (entry.change > 2) result.increased += 1;
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

  useEffect(() => {
    let cancelled = false;
    async function initialiseMap() {
      if (!mapElement.current || mapInstance.current) return;
      const leaflet = await loadLeaflet();
      if (cancelled || !mapElement.current) return;
      const map = leaflet.map(mapElement.current, {
        zoomControl: false,
        attributionControl: true,
        minZoom: 9,
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
    };
  }, [data.stations, mapBounds]);

  useEffect(() => {
    async function renderStationAreas() {
      if (!mapReady || !areaLayer.current || mapMode !== "station") return;
      const leaflet = await loadLeaflet();
      areaLayer.current.clearLayers();

      areaChanges.forEach((entry) => {
        const selected = entry.station.id === selectedStationId;
        const cell = buildAreaCell(entry.station, data.stations, mapBounds);
        const changeLabel = entry.change === null ? "Not available" : formatSigned(entry.change);
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
          color: selected ? "#102e26" : "rgba(23,55,45,.56)",
          weight: selected ? 3 : 1,
          fillColor: changeColour(entry.change),
          fillOpacity: entry.change === null ? 0.48 : 0.76,
          className: "reporting-area-cell",
        });
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
        polygon.on("click", () => setSelectedStationId(entry.station.id));
        polygon.addTo(areaLayer.current!);

        const stationPoint = leaflet.circleMarker([entry.station.lat, entry.station.lng], {
          radius: selected ? 4.5 : 2.6,
          color: "#f8f5ee",
          weight: 1,
          fillColor: "#17372d",
          fillOpacity: 0.9,
        });
        stationPoint.bindTooltip(tooltip, {
          direction: "top",
          opacity: 1,
          className: "change-tooltip",
        });
        stationPoint.on("click", () => setSelectedStationId(entry.station.id));
        stationPoint.addTo(areaLayer.current!);
      });
    }
    renderStationAreas();
  }, [areaChanges, baselineYear, data.stations, mapBounds, mapMode, mapReady, selectedStationId, selectedYear]);

  useEffect(() => {
    async function renderDivisionAreas() {
      if (!mapReady || !areaLayer.current || mapMode !== "division") return;
      const leaflet = await loadLeaflet();
      areaLayer.current.clearLayers();

      divisionAreaChanges.forEach((entry) => {
        const selected = entry.division.id === selectedDivisionId;
        const changeLabel = entry.change === null ? "Not available" : formatSigned(entry.change);
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
            color: selected ? "#102e26" : "rgba(23,55,45,.56)",
            weight: selected ? 3 : 1.4,
            fillColor: changeColour(entry.change),
            fillOpacity: entry.change === null ? 0.48 : 0.76,
            className: "reporting-area-cell",
          },
        });
        layer.bindTooltip(tooltip, { sticky: true, direction: "top", opacity: 1, className: "change-tooltip" });
        layer.on("mouseover", () => layer.setStyle({ weight: 3, fillOpacity: 0.9 }));
        layer.on("mouseout", () =>
          layer.setStyle({
            weight: entry.division.id === selectedDivisionId ? 3 : 1.4,
            fillOpacity: entry.change === null ? 0.48 : 0.76,
          }),
        );
        layer.on("click", () => setSelectedDivisionId(entry.division.id));
        layer.addTo(areaLayer.current!);
      });
    }
    renderDivisionAreas();
  }, [baselineYear, divisionAreaChanges, mapMode, mapReady, selectedDivisionId, selectedYear]);

  return (
    <main className="change-map-app">
      <header className="map-site-header">
        <a href="#atlas" className="map-wordmark" aria-label="Dublin Crime Explorer map">
          <i aria-hidden="true" />
          Dublin Crime Explorer
        </a>
        <p>Official CSO CJA11 data · through {data.meta.latestCompleteYear}</p>
        <a href="#source">Source &amp; limits</a>
      </header>

      <section className="map-workspace" id="atlas">
        <aside className="map-controls">
          <div>
            <p className="map-eyebrow">Recorded crime change</p>
            <h1>See where crime is rising—or falling.</h1>
            <p className="map-intro">
              {mapMode === "station"
                ? "Pick a crime type. Every Dublin station area is coloured by its percentage change, from green decreases to red increases."
                : "Pick an offence type. Each Dublin Garda Division—a real official boundary, not an approximated area—is coloured by its percentage change."}
            </p>
          </div>

          <div className="mode-toggle" role="group" aria-label="Map geography">
            <button
              type="button"
              className={mapMode === "station" ? "active" : ""}
              onClick={() => setMapMode("station")}
            >
              Station view <small>41 areas</small>
            </button>
            <button
              type="button"
              className={mapMode === "division" ? "active" : ""}
              onClick={() => setMapMode("division")}
            >
              Division view <small>6 areas · real boundaries</small>
            </button>
          </div>

          <div className="control-stack">
            {mapMode === "station" ? (
              <label htmlFor="crime-type">
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
              <div className="control-pair">
                <label htmlFor="offence-group">
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
                <label htmlFor="offence-detail">
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
              </div>
            )}
            <div className="control-pair">
              <label htmlFor="map-year">
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
              <label htmlFor="comparison-period">
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
            </div>
          </div>

          {mapMode === "station" ? (
            <>
              <p className="category-description">{selectedCategoryCopy.description}</p>
              {selectedCategoryCopy.availabilityNote && (
                <p className="category-warning">{selectedCategoryCopy.availabilityNote}</p>
              )}
            </>
          ) : (
            <p className="category-description">
              {selectedDivisionDetailCopy?.label ?? `All of: ${selectedDivisionGroupCopy?.label}`}
              {" — official CJQ06 offence code "}
              {selectedDivisionCode}.
            </p>
          )}

          <div
            className="change-counts"
            aria-label={`Area changes from ${baselineYear} to ${selectedYear}`}
          >
            {mapMode === "station" ? (
              <>
                <div><i className="up-dot" /><strong>{summary.increased}</strong><span>increased</span></div>
                <div><i className="down-dot" /><strong>{summary.decreased}</strong><span>decreased</span></div>
                <div><i className="flat-dot" /><strong>{summary.stable}</strong><span>little change</span></div>
              </>
            ) : (
              <>
                <div><i className="up-dot" /><strong>{divisionSummary.increased}</strong><span>increased</span></div>
                <div><i className="down-dot" /><strong>{divisionSummary.decreased}</strong><span>decreased</span></div>
                <div><i className="flat-dot" /><strong>{divisionSummary.stable}</strong><span>little change</span></div>
              </>
            )}
          </div>

          {mapMode === "station" ? (
            <section className="movement-list" aria-label="Largest changes">
              <div>
                <p>Largest increases</p>
                {rankedIncreases.slice(0, 3).map((entry) => (
                  <button type="button" key={entry.station.id} onClick={() => setSelectedStationId(entry.station.id)}>
                    <span>{entry.station.name}</span><strong>{formatSigned(entry.change)}</strong>
                  </button>
                ))}
              </div>
              <div>
                <p>Largest decreases</p>
                {rankedDecreases.slice(0, 3).map((entry) => (
                  <button type="button" key={entry.station.id} onClick={() => setSelectedStationId(entry.station.id)}>
                    <span>{entry.station.name}</span><strong>{formatSigned(entry.change)}</strong>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <section className="movement-list" aria-label="Largest changes">
              <div>
                <p>Largest increases</p>
                {rankedDivisionIncreases.slice(0, 3).map((entry) => (
                  <button type="button" key={entry.division.id} onClick={() => setSelectedDivisionId(entry.division.id)}>
                    <span>{entry.division.name}</span><strong>{formatSigned(entry.change)}</strong>
                  </button>
                ))}
              </div>
              <div>
                <p>Largest decreases</p>
                {rankedDivisionDecreases.slice(0, 3).map((entry) => (
                  <button type="button" key={entry.division.id} onClick={() => setSelectedDivisionId(entry.division.id)}>
                    <span>{entry.division.name}</span><strong>{formatSigned(entry.change)}</strong>
                  </button>
                ))}
              </div>
            </section>
          )}
        </aside>

        <section className="district-map-panel" aria-label="Dublin recorded crime change map">
          <div className="map-panel-heading">
            <div>
              <span>
                {mapMode === "station" ? "All 41 Dublin reporting areas" : "All 6 Dublin Garda Divisions"}
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

          {mapMode === "station" ? (
            <article className="selected-area-card" aria-live="polite">
              <span>{selectedArea.station.division}</span>
              <h2>{selectedArea.station.name}</h2>
              <div>
                <strong>{selectedArea.change === null ? "n/a" : formatSigned(selectedArea.change)}</strong>
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
                    : formatSigned(selectedDivisionArea.change)}
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
