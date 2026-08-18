"use client";

import type { LayerGroup, Map as LeafletMap } from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";

type Category = {
  id: string;
  label: string;
  shortLabel: string;
  codes: string[];
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
  address: string;
  flags: string[];
  contextNote: string;
  places: string[];
  series: Record<string, Array<number | null>>;
};

type Place = {
  place: string;
  stationIds: string[];
  confidence: "high" | "medium" | "low";
  note: string;
};

type DashboardData = {
  meta: {
    title: string;
    sourceTable: string;
    sourceLabel: string;
    latestCompleteYear: number;
    years: number[];
    geography: string;
    geographyNote: string;
    dataNote: string;
    fraudNote: string;
    vehicleNote: string;
  };
  categories: Category[];
  stations: Station[];
  places: Place[];
};

type Metric = "raw" | "share" | "change" | "percentile";

const numberFormat = new Intl.NumberFormat("en-IE");
const oneDecimal = new Intl.NumberFormat("en-IE", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const metricCopy: Record<Metric, { label: string; short: string; note: string }> = {
  raw: {
    label: "Raw recorded incidents",
    short: "Recorded count",
    note: "Absolute incident count; catchment sizes and footfall differ.",
  },
  share: {
    label: "% of area’s recorded total",
    short: "Share of area total",
    note: "Selected incidents as a share of all CJA11 categories published for the station.",
  },
  change: {
    label: "Change since 2019",
    short: "Change since 2019",
    note: "Percentage change is withheld where the 2019 baseline is below 10 incidents.",
  },
  percentile: {
    label: "Dublin percentile",
    short: "Dublin percentile",
    note: "Relative position among the 41 DMR station geographies for the selected count.",
  },
};

const contextLabels: Record<string, string> = {
  high_footfall: "High footfall",
  retail: "Major retail",
  transport: "Transport hub",
  nightlife: "Nightlife",
  large_catchment: "Large catchment",
};

const comparisonRows = ["03", "06", "07", "08", "10", "12", "13"];

async function loadLeaflet() {
  const leafletModule = await import("leaflet");
  return (
    (leafletModule as typeof leafletModule & { default?: typeof leafletModule }).default ??
    leafletModule
  );
}

function markerColour(value: number, min: number, max: number) {
  const ratio = max === min ? 0.5 : (value - min) / (max - min);
  if (ratio > 0.8) return "#9b3e2f";
  if (ratio > 0.6) return "#c46b3c";
  if (ratio > 0.4) return "#db9c55";
  if (ratio > 0.2) return "#8aa382";
  return "#4d745f";
}

function percentageChange(current: number | null, baseline: number | null) {
  if (current === null || baseline === null || baseline < 10) return null;
  return ((current - baseline) / baseline) * 100;
}

function formatSigned(value: number) {
  return `${value > 0 ? "+" : ""}${oneDecimal.format(value)}%`;
}

function TrendChart({
  values,
  years,
  label,
}: {
  values: Array<number | null>;
  years: number[];
  label: string;
}) {
  const available = values
    .map((value, index) => ({ value, index }))
    .filter((item): item is { value: number; index: number } => item.value !== null);
  if (available.length < 2) {
    return <div className="trend-empty">Not enough comparable years to draw a trend.</div>;
  }
  const width = 300;
  const height = 110;
  const insetX = 10;
  const insetY = 16;
  const maximum = Math.max(...available.map((item) => item.value));
  const minimum = Math.min(...available.map((item) => item.value));
  const range = Math.max(1, maximum - minimum);
  const points = available.map((item) => ({
    ...item,
    x: insetX + (item.index / (years.length - 1)) * (width - insetX * 2),
    y: insetY + ((maximum - item.value) / range) * (height - insetY * 2),
  }));
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");

  return (
    <div className="trend-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label} trend from ${years[0]} to ${years.at(-1)}`}>
        <line x1="10" x2="290" y1="55" y2="55" className="trend-grid" />
        <path d={path} className="trend-line" />
        {points.map((point) => (
          <circle key={point.index} cx={point.x} cy={point.y} r="3.5" className="trend-point">
            <title>{`${years[point.index]}: ${numberFormat.format(point.value)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="trend-axis">
        <span>{years[0]}</span>
        <strong>{numberFormat.format(points[0].value)} → {numberFormat.format(points.at(-1)!.value)}</strong>
        <span>{years.at(-1)}</span>
      </div>
    </div>
  );
}

export function CrimeExplorer({ data }: { data: DashboardData }) {
  const [selectedCategory, setSelectedCategory] = useState("07");
  const [selectedYear, setSelectedYear] = useState(data.meta.latestCompleteYear);
  const [selectedMetric, setSelectedMetric] = useState<Metric>("raw");
  const [selectedStationId, setSelectedStationId] = useState("65102");
  const [comparisonIds, setComparisonIds] = useState<string[]>(["65102"]);
  const [selectedPlaceName, setSelectedPlaceName] = useState("");
  const [lookupResult, setLookupResult] = useState<Place | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const mapElement = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<LeafletMap | null>(null);
  const markerLayer = useRef<LayerGroup | null>(null);

  const stationsById = useMemo(
    () => new Map(data.stations.map((station) => [station.id, station])),
    [data.stations],
  );
  const categoriesById = useMemo(
    () => new Map(data.categories.map((category) => [category.id, category])),
    [data.categories],
  );
  const yearIndex = data.meta.years.indexOf(selectedYear);
  const selectedStation = stationsById.get(selectedStationId) ?? data.stations[0];
  const selectedCategoryCopy = categoriesById.get(selectedCategory) ?? data.categories[0];
  const rawValue = selectedStation.series[selectedCategory][yearIndex];
  const baselineValue = selectedStation.series[selectedCategory][0];
  const trendChange = percentageChange(rawValue, baselineValue);
  const areaTotal = selectedStation.series.all[yearIndex];
  const areaShare =
    rawValue !== null && areaTotal ? (rawValue / areaTotal) * 100 : null;

  const rawEntries = useMemo(
    () =>
      data.stations
        .map((station) => ({
          station,
          value: station.series[selectedCategory][yearIndex],
        }))
        .filter((item): item is { station: Station; value: number } => item.value !== null),
    [data.stations, selectedCategory, yearIndex],
  );

  const metricEntries = useMemo(() => {
    if (selectedMetric === "raw") return rawEntries;
    if (selectedMetric === "share") {
      return rawEntries
        .map(({ station, value }) => ({
          station,
          value: station.series.all[yearIndex]
            ? (value / station.series.all[yearIndex]!) * 100
            : null,
        }))
        .filter((item): item is { station: Station; value: number } => item.value !== null);
    }
    if (selectedMetric === "change") {
      return rawEntries
        .map(({ station, value }) => ({
          station,
          value: percentageChange(value, station.series[selectedCategory][0]),
        }))
        .filter((item): item is { station: Station; value: number } => item.value !== null);
    }
    const ordered = [...rawEntries].sort((a, b) => a.value - b.value);
    return ordered.map((item, index) => ({
      station: item.station,
      value: ((index + 1) / ordered.length) * 100,
    }));
  }, [rawEntries, selectedCategory, selectedMetric, yearIndex]);

  const metricByStation = useMemo(
    () => new Map(metricEntries.map((item) => [item.station.id, item.value])),
    [metricEntries],
  );
  const selectedMetricValue = metricByStation.get(selectedStation.id) ?? null;
  const rawPercentile = useMemo(() => {
    if (rawValue === null || rawEntries.length === 0) return null;
    const atOrBelow = rawEntries.filter((item) => item.value <= rawValue).length;
    return (atOrBelow / rawEntries.length) * 100;
  }, [rawEntries, rawValue]);

  const crimeMix = useMemo(() => {
    return data.categories
      .filter((category) => category.kind === "official")
      .map((category) => ({
        category,
        value: selectedStation.series[category.id][yearIndex],
      }))
      .filter((item): item is { category: Category; value: number } => item.value !== null)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }, [data.categories, selectedStation, yearIndex]);

  const sortedPlaces = useMemo(
    () => [...data.places].sort((a, b) => a.place.localeCompare(b.place, "en-IE")),
    [data.places],
  );

  const ranked = useMemo(
    () => [...metricEntries].sort((a, b) => b.value - a.value),
    [metricEntries],
  );

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
        preferCanvas: false,
      });
      mapInstance.current = map;
      leaflet
        .tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "&copy; OpenStreetMap contributors",
          maxZoom: 18,
        })
        .addTo(map);
      new leaflet.Control.Zoom({ position: "bottomright" }).addTo(map);
      map.fitBounds(
        leaflet.latLngBounds(data.stations.map((station) => [station.lat, station.lng])),
        { padding: [22, 22] },
      );
      markerLayer.current = leaflet.layerGroup().addTo(map);
      setMapReady(true);
    }
    initialiseMap();
    return () => {
      cancelled = true;
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
        markerLayer.current = null;
      }
    };
  }, [data.stations]);

  useEffect(() => {
    async function renderMarkers() {
      if (!mapReady || !mapInstance.current || !markerLayer.current) return;
      const leaflet = await loadLeaflet();
      markerLayer.current.clearLayers();
      const values = metricEntries.map((entry) => entry.value);
      if (values.length === 0) return;
      const min = Math.min(...values);
      const max = Math.max(...values);
      metricEntries.forEach(({ station, value }) => {
        const selected = station.id === selectedStationId;
        const marker = leaflet.circleMarker([station.lat, station.lng], {
          radius: selected ? 12 : 7,
          color: selected ? "#f6f1e7" : "#17372d",
          weight: selected ? 3 : 1.5,
          fillColor: markerColour(value, min, max),
          fillOpacity: 0.94,
        });
        marker.bindTooltip(
          `<strong>${station.name}</strong><br>${formatMetricValue(value, selectedMetric)}`,
          { direction: "top", offset: [0, -8] },
        );
        marker.on("click", () => {
          setSelectedStationId(station.id);
          setLookupResult(null);
          setSelectedPlaceName("");
        });
        marker.addTo(markerLayer.current!);
        const element = marker.getElement();
        if (element) {
          element.setAttribute("tabindex", "0");
          element.setAttribute("role", "button");
          element.setAttribute("aria-label", `${station.name}: ${formatMetricValue(value, selectedMetric)}`);
          element.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setSelectedStationId(station.id);
            }
          });
        }
      });
    }
    renderMarkers();
  }, [mapReady, metricEntries, selectedMetric, selectedStationId]);

  useEffect(() => {
    if (!mapReady || !mapInstance.current) return;
    mapInstance.current.panTo([selectedStation.lat, selectedStation.lng], { animate: true });
  }, [mapReady, selectedStation]);

  useEffect(() => {
    if (selectedCategory === "all" && selectedMetric === "share") {
      setSelectedMetric("raw");
    }
  }, [selectedCategory, selectedMetric]);

  useEffect(() => {
    if (lookupResult && !lookupResult.stationIds.includes(selectedStationId)) {
      setLookupResult(null);
      setSelectedPlaceName("");
    }
  }, [lookupResult, selectedStationId]);

  function selectPlace(place: Place) {
    setSelectedPlaceName(place.place);
    setLookupResult(place);
    setSelectedStationId(place.stationIds[0]);
  }

  function toggleComparison(stationId: string) {
    setComparisonIds((current) => {
      if (current.includes(stationId)) return current.filter((id) => id !== stationId);
      if (current.length >= 3) return [...current.slice(1), stationId];
      return [...current, stationId];
    });
  }

  function formatMetricValue(value: number, metric: Metric) {
    if (metric === "raw") return `${numberFormat.format(Math.round(value))} incidents`;
    if (metric === "share") return `${oneDecimal.format(value)}% of area total`;
    if (metric === "change") return `${formatSigned(value)} since 2019`;
    return `${Math.round(value)}th percentile`;
  }

  return (
    <main className="explorer-shell">
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Dublin Crime Explorer home">
          <span className="wordmark-dot" />
          Dublin Crime Explorer
        </a>
        <nav aria-label="Page sections">
          <a href="#atlas">Atlas</a>
          <a href="#compare">Compare</a>
          <a href="#rankings">Rankings</a>
        </nav>
        <a className="method-button" href="#methodology">Method & limits</a>
      </header>

      <section className="hero-strip" id="top">
        <div>
          <p className="eyebrow">A clearer view of recorded crime</p>
          <h1>What was recorded<br />across Dublin?</h1>
        </div>
        <div className="hero-copy">
          <p>
            Compare Garda reporting geographies by offence, year and trend—without
            mistaking raw station totals for a neighbourhood safety score.
          </p>
          <span>Official CSO CJA11 · Annual data to 2025</span>
        </div>
      </section>

      <section className="dashboard-frame" id="atlas" aria-label="Crime explorer dashboard">
        <aside className="filter-rail">
          <div className="rail-heading">
            <span>Explore the data</span>
            <span className="live-pill">41 stations</span>
          </div>

          <div className="search-block">
            <label htmlFor="area-search">Search Dublin area</label>
            <select
              id="area-search"
              className="area-select"
              value={selectedPlaceName}
              onChange={(event) => {
                const place = data.places.find((item) => item.place === event.target.value);
                if (place) selectPlace(place);
              }}
            >
              <option value="">Choose a Dublin area…</option>
              {sortedPlaces.map((place) => (
                <option key={place.place} value={place.place}>{place.place}</option>
              ))}
            </select>
          </div>

          {lookupResult && (
            <div className={`lookup-card confidence-${lookupResult.confidence}`}>
              <div>
                <span>{lookupResult.place}</span>
                <small>{lookupResult.confidence} mapping confidence</small>
              </div>
              <p>{lookupResult.note}</p>
              <strong>Relevant published geography</strong>
              <div className="lookup-stations">
                {lookupResult.stationIds.map((id) => {
                  const station = stationsById.get(id)!;
                  return (
                    <button
                      type="button"
                      key={id}
                      className={id === selectedStationId ? "active" : ""}
                      onClick={() => setSelectedStationId(id)}
                    >
                      {station.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <label>
            Crime view
            <select
              value={selectedCategory}
              onChange={(event) => setSelectedCategory(event.target.value)}
            >
              <optgroup label="Useful groupings">
                {data.categories
                  .filter((category) => category.kind === "grouped")
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.shortLabel}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Official CJA11 categories">
                {data.categories
                  .filter((category) => category.kind === "official")
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.shortLabel}
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>
          <label>
            Year
            <select
              value={selectedYear}
              onChange={(event) => setSelectedYear(Number(event.target.value))}
            >
              {[...data.meta.years].reverse().map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
          </label>
          <label>
            Map measure
            <select
              value={selectedMetric}
              onChange={(event) => setSelectedMetric(event.target.value as Metric)}
            >
              {(Object.keys(metricCopy) as Metric[]).map((metric) => (
                <option key={metric} value={metric} disabled={metric === "share" && selectedCategory === "all"}>
                  {metricCopy[metric].label}
                </option>
              ))}
            </select>
          </label>
          <p className="filter-explainer">{selectedCategoryCopy.description}</p>
          {selectedCategoryCopy.availabilityNote && (
            <div className="data-warning">{selectedCategoryCopy.availabilityNote}</div>
          )}
          <div className="rail-callout">
            <span className="callout-icon">i</span>
            <p>{data.meta.geographyNote}</p>
          </div>
        </aside>

        <div className="map-stage">
          <div className="map-heading">
            <div>
              <span className="map-kicker">Dublin · {selectedYear}</span>
              <h2>{selectedCategoryCopy.shortLabel}</h2>
              <p>{metricCopy[selectedMetric].short}</p>
            </div>
            <div className="map-legend" aria-label="Map colour scale">
              <span>Lower recorded</span>
              <i /><i /><i /><i /><i />
              <span>Higher</span>
            </div>
          </div>
          <div ref={mapElement} className="leaflet-map" aria-label="Map of Dublin Garda station locations" />
          {metricEntries.length === 0 && (
            <div className="map-empty">No comparable station-level data for this selection.</div>
          )}
          <div className="map-caption">
            <span>Point markers, not catchment polygons</span>
            {metricCopy[selectedMetric].note}
          </div>
        </div>

        <aside className="area-panel" aria-live="polite">
          <div className="panel-topline">
            <span>{selectedStation.division}</span>
            <span>{selectedYear}</span>
          </div>
          <h2>{selectedStation.name}</h2>
          <p className="station-label">Garda station / sub-district geography</p>
          <div className="primary-stat">
            <strong>
              {selectedMetricValue === null
                ? "—"
                : selectedMetric === "raw"
                  ? numberFormat.format(Math.round(selectedMetricValue))
                  : selectedMetric === "percentile"
                    ? `${Math.round(selectedMetricValue)}th`
                    : selectedMetric === "change"
                      ? formatSigned(selectedMetricValue)
                      : `${oneDecimal.format(selectedMetricValue)}%`}
            </strong>
            <span>{metricCopy[selectedMetric].short.toLowerCase()}</span>
          </div>
          <div className="mini-metrics">
            <div>
              <span>Dublin percentile</span>
              <strong>{rawPercentile === null ? "—" : `${Math.round(rawPercentile)}th`}</strong>
            </div>
            <div>
              <span>Since 2019</span>
              <strong>{trendChange === null ? "n/a" : formatSigned(trendChange)}</strong>
            </div>
            <div>
              <span>Area share</span>
              <strong>{areaShare === null ? "—" : `${oneDecimal.format(areaShare)}%`}</strong>
            </div>
          </div>
          <button
            type="button"
            className={comparisonIds.includes(selectedStation.id) ? "compare-button active" : "compare-button"}
            onClick={() => toggleComparison(selectedStation.id)}
          >
            {comparisonIds.includes(selectedStation.id) ? "✓ In comparison" : "+ Add to comparison"}
          </button>

          <section className="panel-section">
            <div className="panel-section-heading">
              <h3>Trend</h3>
              <span>2019–2025</span>
            </div>
            <TrendChart
              values={selectedStation.series[selectedCategory]}
              years={data.meta.years}
              label={`${selectedStation.name} ${selectedCategoryCopy.shortLabel}`}
            />
          </section>

          <section className="panel-section">
            <div className="panel-section-heading">
              <h3>Crime mix</h3>
              <span>% of published total</span>
            </div>
            <div className="mix-list">
              {crimeMix.map(({ category, value }) => {
                const share = areaTotal ? (value / areaTotal) * 100 : 0;
                return (
                  <div className="mix-row" key={category.id}>
                    <div><span>{category.shortLabel}</span><strong>{oneDecimal.format(share)}%</strong></div>
                    <i><b style={{ width: `${Math.min(100, share)}%` }} /></i>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel-section context-section">
            <h3>Context</h3>
            {selectedStation.flags.length > 0 && (
              <div className="flag-list">
                {selectedStation.flags.map((flag) => <span key={flag}>{contextLabels[flag]}</span>)}
              </div>
            )}
            <p>{selectedStation.contextNote || data.meta.dataNote}</p>
          </section>
        </aside>
      </section>

      <section className="comparison-section" id="compare">
        <div className="section-intro">
          <div>
            <p className="eyebrow">Side by side</p>
            <h2>Compare reporting geographies</h2>
          </div>
          <p>Counts are shown for {selectedYear}. The final row follows your selected crime view and compares change since 2019.</p>
        </div>
        <div className="comparison-toolbar">
          <div className="comparison-pills">
            {comparisonIds.map((id) => {
              const station = stationsById.get(id)!;
              return (
                <button type="button" key={id} onClick={() => toggleComparison(id)}>
                  {station.name}<span aria-label={`Remove ${station.name}`}>×</span>
                </button>
              );
            })}
          </div>
          <label>
            Add area
            <select
              value=""
              onChange={(event) => {
                if (event.target.value) toggleComparison(event.target.value);
              }}
            >
              <option value="">Choose a station…</option>
              {data.stations
                .filter((station) => !comparisonIds.includes(station.id))
                .map((station) => <option value={station.id} key={station.id}>{station.name}</option>)}
            </select>
          </label>
        </div>
        {comparisonIds.length > 0 ? (
          <div className="comparison-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recorded category</th>
                  {comparisonIds.map((id) => <th key={id}>{stationsById.get(id)!.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((categoryId) => (
                  <tr key={categoryId}>
                    <th>{categoriesById.get(categoryId)!.shortLabel}</th>
                    {comparisonIds.map((id) => {
                      const value = stationsById.get(id)!.series[categoryId][yearIndex];
                      return <td key={id}>{value === null ? "—" : numberFormat.format(value)}</td>;
                    })}
                  </tr>
                ))}
                <tr className="trend-comparison-row">
                  <th>{selectedCategoryCopy.shortLabel} · change since 2019</th>
                  {comparisonIds.map((id) => {
                    const series = stationsById.get(id)!.series[selectedCategory];
                    const change = percentageChange(series[yearIndex], series[0]);
                    return <td key={id}>{change === null ? "n/a" : formatSigned(change)}</td>;
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="comparison-empty">Add up to three stations from an area panel or the selector above.</div>
        )}
        <p className="table-note">Raw-count comparison only. Different station catchments are not equally sized and can have very different footfall.</p>
      </section>

      <section className="rankings-section" id="rankings">
        <div className="section-intro">
          <div>
            <p className="eyebrow">Dublin-wide position</p>
            <h2>Rankings, with the measure attached</h2>
          </div>
          <p>These are not “safest place” lists. They order station geographies only by your current category and map measure.</p>
        </div>
        <div className="ranking-grid">
          <div className="ranking-card">
            <div className="ranking-title"><span>Higher recorded level</span><small>{metricCopy[selectedMetric].short}</small></div>
            <ol>
              {ranked.slice(0, 5).map((entry) => (
                <li key={entry.station.id}>
                  <button type="button" onClick={() => setSelectedStationId(entry.station.id)}>
                    <span>{entry.station.name}</span>
                    <strong>{formatMetricValue(entry.value, selectedMetric)}</strong>
                  </button>
                </li>
              ))}
            </ol>
          </div>
          <div className="ranking-card">
            <div className="ranking-title"><span>Lower recorded level</span><small>{metricCopy[selectedMetric].short}</small></div>
            <ol>
              {[...ranked].reverse().slice(0, 5).map((entry) => (
                <li key={entry.station.id}>
                  <button type="button" onClick={() => setSelectedStationId(entry.station.id)}>
                    <span>{entry.station.name}</span>
                    <strong>{formatMetricValue(entry.value, selectedMetric)}</strong>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section className="methodology-section" id="methodology">
        <div className="methodology-heading">
          <p className="eyebrow">Read before interpreting</p>
          <h2>Method & limitations</h2>
          <p>Transparent caveats are part of the product, not fine print.</p>
        </div>
        <div className="method-grid">
          <article>
            <span>01</span><h3>Recorded, not total prevalence</h3>
            <p>{data.meta.dataNote}</p>
          </article>
          <article>
            <span>02</span><h3>Station geography, not suburb</h3>
            <p>{data.meta.geographyNote}</p>
          </article>
          <article>
            <span>03</span><h3>No current catchment polygons</h3>
            <p>The map uses published station locations. The available Garda boundary files describe the 2011/2013 structure and are not presented as current.</p>
          </article>
          <article>
            <span>04</span><h3>Category gaps</h3>
            <p>{data.meta.fraudNote} Homicide and sexual-offence groups are also not published in CJA11 station detail.</p>
          </article>
          <article>
            <span>05</span><h3>Vehicle crime is not separable</h3>
            <p>{data.meta.vehicleNote}</p>
          </article>
          <article>
            <span>06</span><h3>Historical caution</h3>
            <p>Closed-station incidents are reassigned to the station geography that assumed responsibility. COVID restrictions materially affected 2020–2022 patterns.</p>
          </article>
        </div>
        <div className="source-bar">
          <div><span>Primary source</span><strong>Central Statistics Office · CJA11</strong></div>
          <a href="https://data.gov.ie/en_GB/dataset/cja11-recorded-crime-incidents-new-garda-operating-model" target="_blank" rel="noreferrer">Open official dataset ↗</a>
        </div>
      </section>

      <footer>
        <span>Dublin Crime Explorer</span>
        <p>Neutral, reproducible exploration of official recorded-crime data.</p>
        <a href="#top">Back to top ↑</a>
      </footer>
    </main>
  );
}
