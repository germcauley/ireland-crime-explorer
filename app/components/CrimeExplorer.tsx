"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { geoCentroid } from "d3-geo";
import { percentageChange } from "../lib/analytics";
import type { DashboardData, Division, Station } from "../lib/dashboard-types";
import { CrimeMap, type MapPoint, type MapView } from "./CrimeMap";
import { RecentReporting } from "./RecentReporting";

/**
 * The explorer: two geographies, one comparison, one offence control.
 *
 * Everything on screen answers "how did recorded crime change between two
 * years, and where". The offence control doubles as the breakdown, so there is
 * no separate tab restating the same numbers, and there is no count/share/
 * percentile switch — a single encoding the reader can trust beats three they
 * have to keep straight.
 */

const numberFormat = new Intl.NumberFormat("en-IE");
const ALL_CRIME = "all";
const TOP_GROUPS = 6;
/** The national map merges the six DMR Divisions into one symbol. */
const DUBLIN_AGGREGATE = "dublin-aggregate";

type Theme = "light" | "dark";
const THEME_EVENT = "crime-explorer-theme";

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function setStoredTheme(next: Theme) {
  try {
    window.localStorage.setItem("theme", next);
  } catch {
    // A blocked store costs persistence, not the toggle.
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

function formatChange(change: number | null): string {
  if (change === null) return "no comparable baseline";
  const rounded = Math.round(change);
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded)}%`;
}

function toneOf(change: number | null): "up" | "down" | "flat" {
  if (change === null) return "flat";
  if (change > 0) return "up";
  if (change < 0) return "down";
  return "flat";
}

/** Station names carry words the map has no room for. */
function shortenStation(name: string): string {
  return name
    .replace(/ Street$/, " St")
    .replace(/^Dublin Airport$/, "Airport")
    .replace(/^Bridewell Dublin$/, "Bridewell")
    .replace(/, Co Dublin$/, "");
}

function yearTotal(series: Record<string, Array<number | null>>, code: string, index: number) {
  const values = series[code];
  if (!values) return null;
  const value = values[index];
  return value === undefined ? null : value;
}

export function CrimeExplorer({ data }: { data: DashboardData }) {
  const years = data.meta.years;
  const latest = years[years.length - 1];

  const [view, setView] = useState<"atlas" | "dublin" | "about">("atlas");
  const [fromYear, setFromYear] = useState(years[0]);
  const [toYear, setToYear] = useState(latest);
  const [group, setGroup] = useState(ALL_CRIME);
  const [sub, setSub] = useState<string | null>(null);
  const [moreGroups, setMoreGroups] = useState(false);
  // Null is a real state, not a placeholder: the reader lands on the whole
  // country and can get back to it. Clicking the selected symbol again clears,
  // the same way clicking the open offence group clears back to all crime.
  const [selectedDivision, setSelectedDivision] = useState<string | null>(null);
  const [selectedStation, setSelectedStation] = useState<string | null>(null);
  // Clicking the merged Dublin symbol zooms the national frame into the city
  // without leaving the nationwide tab — the station view is the other tab's job.
  const [dublinZoom, setDublinZoom] = useState(false);

  const theme = useSyncExternalStore(subscribeToTheme, readTheme, () => "light" as const);
  const isDark = theme === "dark";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const root = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  // Watches the component's own root rather than the window, so it behaves the
  // same embedded as it does standalone.
  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 720));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fromIndex = years.indexOf(fromYear);
  const toIndex = years.indexOf(toYear);
  const stationMode = view === "dublin";

  const divisionCentroids = useMemo(() => {
    const out: Record<string, [number, number]> = {};
    data.divisions.forEach((division) => {
      const [lng, lat] = geoCentroid(division.boundary as never);
      out[division.id] = [lat, lng];
    });
    return out;
  }, [data.divisions]);

  const dmrIds = useMemo(
    () => new Set(data.divisions.filter((d) => d.name.startsWith("DMR")).map((d) => d.id)),
    [data.divisions],
  );

  /** The offence code in play: a sub-category if chosen, else the group. */
  const activeCode = stationMode ? (group === ALL_CRIME ? "all" : group) : sub ?? (group === ALL_CRIME ? null : group);

  const divisionValue = (division: Division, index: number) => {
    if (index < 0) return null;
    if (activeCode === null) {
      // "All crime" nationally is the sum of the official groups.
      let total = 0;
      let any = false;
      data.divisionCategories.forEach((category) => {
        const value = yearTotal(division.series, category.id, index);
        if (value !== null) {
          total += value;
          any = true;
        }
      });
      return any ? total : null;
    }
    return yearTotal(division.series, activeCode, index);
  };

  const stationValue = (station: Station, index: number) =>
    index < 0 ? null : yearTotal(station.series, group === ALL_CRIME ? "all" : group, index);

  const areas = useMemo(() => {
    if (stationMode) {
      return data.stations.map((station) => {
        const to = stationValue(station, toIndex);
        const from = stationValue(station, fromIndex);
        return {
          id: station.id,
          name: station.name,
          shortName: shortenStation(station.name),
          lat: station.lat,
          lng: station.lng,
          to,
          from,
          change: percentageChange(to, from),
        };
      });
    }
    return data.divisions.map((division) => {
      const to = divisionValue(division, toIndex);
      const from = divisionValue(division, fromIndex);
      const [lat, lng] = divisionCentroids[division.id] ?? [null, null];
      return {
        id: division.id,
        name: division.name.replace(/ Division$/, ""),
        shortName: division.name.replace(/ Division$/, "").replace("DMR ", ""),
        lat,
        lng,
        to,
        from,
        change: percentageChange(to, from),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, stationMode, toIndex, fromIndex, activeCode, group, divisionCentroids]);

  /** The six DMR Divisions summed, so the national map shows one Dublin. */
  const dublinAggregate = useMemo(() => {
    const parts = areas.filter((a) => dmrIds.has(a.id));
    if (stationMode || parts.length === 0) return null;
    const sum = (key: "to" | "from") =>
      parts.reduce<number | null>((total, part) => {
        if (part[key] === null) return total;
        return (total ?? 0) + (part[key] as number);
      }, null);
    const to = sum("to");
    const from = sum("from");
    return {
      id: DUBLIN_AGGREGATE,
      name: "Dublin",
      shortName: "Dublin",
      lat: 53.3498,
      lng: -6.2603,
      to,
      from,
      change: percentageChange(to, from),
    };
  }, [areas, dmrIds, stationMode]);

  const mapView: MapView = stationMode ? "stations" : dublinZoom ? "dublin" : "national";

  const mapPoints: MapPoint[] = useMemo(() => {
    const source = stationMode
      ? areas
      : dublinZoom
        ? areas.filter((a) => dmrIds.has(a.id))
        : [...areas.filter((a) => !dmrIds.has(a.id)), ...(dublinAggregate ? [dublinAggregate] : [])];
    return source.map((area) => ({
      id: area.id,
      name: area.name,
      shortName: area.shortName,
      lat: area.lat,
      lng: area.lng,
      value: area.to ?? 0,
      change: area.change,
      valueLabel:
        area.to === null
          ? "no comparable count"
          : `${numberFormat.format(area.to)} incidents, ${formatChange(area.change)} on ${fromYear}`,
    }));
  }, [areas, dublinAggregate, dublinZoom, dmrIds, fromYear, stationMode]);

  const selectedId = stationMode ? selectedStation : selectedDivision;

  /** With nothing selected the readout describes the whole geography. */
  const wholeGeography = useMemo(() => {
    const sum = (key: "to" | "from") =>
      areas.reduce<number | null>((total, area) => {
        if (area[key] === null) return total;
        return (total ?? 0) + (area[key] as number);
      }, null);
    const to = sum("to");
    const from = sum("from");
    return {
      id: "",
      name: stationMode ? "All 41 station areas" : "All of Ireland",
      shortName: "",
      lat: null,
      lng: null,
      to,
      from,
      change: percentageChange(to, from),
    };
  }, [areas, stationMode]);

  const selectedArea =
    selectedId === null
      ? wholeGeography
      : selectedId === DUBLIN_AGGREGATE
        ? dublinAggregate ?? wholeGeography
        : areas.find((a) => a.id === selectedId) ?? wholeGeography;

  /** Rankings never include the Dublin aggregate — it is not one of the 28. */
  const ranked = useMemo(
    () =>
      areas
        .slice()
        .sort((a, b) => {
          if (a.change === null) return 1;
          if (b.change === null) return -1;
          return a.change - b.change;
        }),
    [areas],
  );

  // The offence control doubles as the breakdown, so it is scoped to the
  // selected area rather than the country.
  const offenceRows = useMemo(() => {
    const index = toIndex;
    if (stationMode) {
      const stations =
        selectedId === null ? data.stations : data.stations.filter((s) => s.id === selectedId);
      if (stations.length === 0) return [];
      return data.categories
        .filter((category) => category.kind === "official")
        .map((category) => ({
          id: category.id,
          label: category.shortLabel,
          count: stations.reduce(
            (sum, station) => sum + (yearTotal(station.series, category.id, index) ?? 0),
            0,
          ),
          children: [] as { id: string; label: string; count: number }[],
        }))
        .sort((a, b) => b.count - a.count);
    }
    // Nothing selected means the whole country, so the breakdown describes
    // what it is sitting next to rather than emptying out.
    const division =
      selectedId === null || selectedId === DUBLIN_AGGREGATE
        ? null
        : data.divisions.find((d) => d.id === selectedId);
    const members =
      selectedId === null
        ? data.divisions
        : selectedId === DUBLIN_AGGREGATE
          ? data.divisions.filter((d) => dmrIds.has(d.id))
          : division
            ? [division]
            : [];
    if (members.length === 0) return [];
    const total = (code: string) =>
      members.reduce((sum, member) => sum + (yearTotal(member.series, code, index) ?? 0), 0);
    return data.divisionCategories
      .map((category) => ({
        id: category.id,
        label: category.shortLabel,
        count: total(category.id),
        children: category.children.map((child) => ({
          id: child.id,
          label: child.label,
          count: total(child.id),
        })),
      }))
      .sort((a, b) => b.count - a.count);
  }, [data, dmrIds, selectedId, stationMode, toIndex]);

  const offenceMax = Math.max(1, ...offenceRows.map((row) => row.count));
  const allCrimeCount = offenceRows.reduce((sum, row) => sum + row.count, 0);
  const visibleRows = moreGroups ? offenceRows : offenceRows.slice(0, TOP_GROUPS);

  const activeLabel =
    group === ALL_CRIME
      ? "all crime"
      : (sub
          ? offenceRows.find((r) => r.id === group)?.children.find((c) => c.id === sub)?.label
          : offenceRows.find((r) => r.id === group)?.label) ?? "all crime";

  const selectedCount = selectedArea?.to ?? null;
  const share =
    group !== ALL_CRIME && selectedCount !== null && allCrimeCount > 0
      ? Math.round((selectedCount / allCrimeCount) * 100)
      : null;

  /** Reporting is pinned to Divisions; the station view pools all six DMR. */
  const reportingDivisionIds = useMemo(() => {
    if (stationMode) return Array.from(dmrIds);
    if (selectedId === DUBLIN_AGGREGATE) return Array.from(dmrIds);
    // Nothing selected pools the country, so the landing view still offers the
    // reporting rather than hiding it until an area is picked.
    if (selectedId === null) return data.divisions.map((d) => d.id);
    return [selectedId];
  }, [data.divisions, dmrIds, selectedId, stationMode]);

  const reportingName =
    stationMode || selectedId === DUBLIN_AGGREGATE
      ? "Dublin"
      : selectedId === null
        ? "Ireland"
        : selectedArea?.name ?? "";

  function pickYear(which: "from" | "to", year: number) {
    // Clamp rather than refuse: picking a From at or past To pushes To along.
    if (which === "from") {
      setFromYear(year);
      if (year >= toYear) setToYear(years[Math.min(years.length - 1, years.indexOf(year) + 1)]);
    } else {
      setToYear(year);
      if (year <= fromYear) setFromYear(years[Math.max(0, years.indexOf(year) - 1)]);
    }
  }

  function selectFromMap(id: string) {
    if (stationMode) {
      setSelectedStation((current) => (current === id ? null : id));
      return;
    }
    if (id === DUBLIN_AGGREGATE) {
      // Clicking Dublin again steps back out rather than re-zooming.
      if (selectedDivision === DUBLIN_AGGREGATE) {
        setSelectedDivision(null);
        setDublinZoom(false);
        return;
      }
      setSelectedDivision(DUBLIN_AGGREGATE);
      setDublinZoom(true);
      return;
    }
    setSelectedDivision((current) => (current === id ? null : id));
  }

  function switchView(next: "atlas" | "dublin") {
    setView(next);
    setDublinZoom(false);
    setSub(null);
    if (next === "dublin" && !selectedStation) setSelectedStation(data.stations[0]?.id ?? null);
    if (next === "atlas" && selectedDivision === DUBLIN_AGGREGATE) setSelectedDivision(null);
  }

  if (view === "about") {
    return (
      <main className="explorer" ref={root}>
        <Masthead
          latest={latest}
          theme={theme}
          onToggleTheme={() => setStoredTheme(isDark ? "light" : "dark")}
          onOpenAbout={() => setView("atlas")}
          aboutLabel="Back to the explorer"
        />
        <AboutView meta={data.meta} />
      </main>
    );
  }

  return (
    <main className={`explorer${narrow ? " is-narrow" : ""}`} ref={root}>
      <Masthead
        latest={latest}
        theme={theme}
        onToggleTheme={() => setStoredTheme(isDark ? "light" : "dark")}
        onOpenAbout={() => setView("about")}
        aboutLabel="What this is, and is not"
      />

      <nav className="explorer-nav" aria-label="Geography">
        <button
          type="button"
          className={view === "atlas" ? "is-active" : ""}
          aria-current={view === "atlas"}
          onClick={() => switchView("atlas")}
        >
          Nationwide · {data.divisions.length} Divisions
        </button>
        <button
          type="button"
          className={view === "dublin" ? "is-active" : ""}
          aria-current={view === "dublin"}
          onClick={() => switchView("dublin")}
        >
          Dublin · {data.stations.length} station areas
        </button>
      </nav>

      <div className={`explorer-body${stationMode ? " is-stations" : ""}`}>
        <aside className="control-rail" aria-label="Filters">
          <section>
            <h2 className="rail-heading">Compare years</h2>
            <div className="year-row">
              <span className="year-label">From</span>
              <div className="year-chips">
                {years.map((year) => (
                  <button
                    type="button"
                    key={`from-${year}`}
                    className={year === fromYear ? "is-on" : ""}
                    disabled={year === years[years.length - 1]}
                    onClick={() => pickYear("from", year)}
                  >
                    {year}
                  </button>
                ))}
              </div>
            </div>
            <div className="year-row">
              <span className="year-label">To</span>
              <div className="year-chips">
                {years.map((year) => (
                  <button
                    type="button"
                    key={`to-${year}`}
                    className={year === toYear ? "is-on" : ""}
                    disabled={year === years[0]}
                    onClick={() => pickYear("to", year)}
                  >
                    {year}
                  </button>
                ))}
              </div>
            </div>
            <p className="rail-caption">
              Percentage change between {fromYear} and {toYear}. Areas with fewer than ten
              incidents in {fromYear} are left blank rather than shown as a large swing.
            </p>
          </section>

          <section>
            <h2 className="rail-heading">Which crimes?</h2>
            <p className="rail-caption is-italic">
              in {selectedArea?.name ?? "this area"}, {toYear}
            </p>
            <div className="offence-rows">
              <OffenceRow
                label="All crime"
                count={allCrimeCount}
                fraction={1}
                active={group === ALL_CRIME}
                onSelect={() => {
                  setGroup(ALL_CRIME);
                  setSub(null);
                }}
              />
              {visibleRows.map((row) => (
                <div key={row.id}>
                  <OffenceRow
                    label={row.label}
                    count={row.count}
                    fraction={row.count / offenceMax}
                    active={group === row.id}
                    onSelect={() => {
                      // Clicking the open group closes back to all crime.
                      const next = group === row.id ? ALL_CRIME : row.id;
                      setGroup(next);
                      setSub(null);
                    }}
                  />
                  {group === row.id && row.children.length > 0 && !stationMode && (
                    <div className="offence-children">
                      <button
                        type="button"
                        className={sub === null ? "is-on" : ""}
                        onClick={() => setSub(null)}
                      >
                        Whole group
                      </button>
                      {row.children.map((child) => (
                        <button
                          type="button"
                          key={child.id}
                          className={sub === child.id ? "is-on" : ""}
                          onClick={() => setSub(child.id)}
                        >
                          {child.label} <span>{numberFormat.format(child.count)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {offenceRows.length > TOP_GROUPS && (
              <button type="button" className="rail-more" onClick={() => setMoreGroups((v) => !v)}>
                {moreGroups ? "Fewer offence groups" : `All ${offenceRows.length} offence groups`}
              </button>
            )}
          </section>
        </aside>

        <section className="map-column" aria-label="Map">
          <div className="map-head">
            <h2>
              {stationMode
                ? "Dublin station areas"
                : dublinZoom
                  ? "The six Dublin Divisions"
                  : "Recorded crime by Garda Division"}
            </h2>
            <p>
              {stationMode
                ? "Station locations, sized by count · scroll or use + − to zoom, drag to pan"
                : dublinZoom
                  ? "Zoomed to Dublin · pick a Division, or step back out to the whole country"
                  : "Circle area is the recorded count · the Dublin symbol opens its six Divisions"}
            </p>
          </div>

          <div className={`map-frame${stationMode ? " is-stations" : dublinZoom ? " is-dublin" : ""}`}>
            <CrimeMap
              points={mapPoints}
              selected={selectedId}
              view={mapView}
              onSelect={selectFromMap}
              isDark={isDark}
            />
          </div>

          {dublinZoom && !stationMode && (
            <button type="button" className="map-back" onClick={() => setDublinZoom(false)}>
              Back to all of Ireland
            </button>
          )}

          <div className="map-legend">
            <span>Circle area = recorded incidents</span>
            <span><i className="dot-down" /> Down on {fromYear} · {toYear} count</span>
            <span><i className="dot-up" /> Up on {fromYear}</span>
          </div>

          {stationMode && (
            <p className="map-note">
              Each symbol sits at the station itself, not at the centre of the area it
              records — no catchment boundaries are published. Names are shown where they
              fit; zoom in for the rest.
            </p>
          )}
        </section>

        <aside className="readout-rail" aria-label="Selected area">
          <div className="readout">
            <p className="rail-heading">
              {selectedId === null
                ? stationMode
                  ? `All ${data.stations.length} station areas`
                  : `All ${data.divisions.length} Divisions`
                : stationMode
                  ? "Dublin station area"
                  : selectedId === DUBLIN_AGGREGATE
                    ? "Dublin Metropolitan Region"
                    : "Garda Division"}{" "}
              · {toYear}
            </p>
            <h2>{selectedArea?.name ?? "—"}</h2>
            <p className="readout-count">
              {selectedCount === null ? "—" : numberFormat.format(selectedCount)}
            </p>
            <p className="readout-caption">
              recorded incidents of {activeLabel}
              {share !== null && <> — {share}% of everything recorded there</>}
            </p>
            <p className={`readout-change tone-${toneOf(selectedArea?.change ?? null)}`}>
              {selectedArea?.change === null || selectedArea?.change === undefined
                ? "No comparable baseline"
                : `${formatChange(selectedArea.change)} on ${fromYear} (${numberFormat.format(selectedArea.from ?? 0)})`}
            </p>
          </div>

          <RecentReporting
            key={reportingDivisionIds.join(",")}
            divisionIds={reportingDivisionIds}
            areaName={reportingName}
          />

          <div className="rankings">
            <div className="rankings-head">
              <h2 className="rail-heading">
                All {stationMode ? data.stations.length : data.divisions.length}{" "}
                {stationMode ? "station areas" : "Divisions"}
              </h2>
              <span>{fromYear} → {toYear}</span>
            </div>
            <ol>
              {ranked.map((area, index) => (
                <li key={area.id}>
                  <button
                    type="button"
                    className={area.id === selectedId ? "is-selected" : ""}
                    onClick={() =>
                      stationMode
                        ? setSelectedStation((current) => (current === area.id ? null : area.id))
                        : setSelectedDivision((current) => (current === area.id ? null : area.id))
                    }
                  >
                    <span className="rank">{index + 1}</span>
                    <span className="rank-name">{area.name}</span>
                    <span className={`rank-change tone-${toneOf(area.change)}`}>
                      {area.change === null ? "—" : formatChange(area.change)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>

      <p className="explorer-footnote">
        Recorded incidents are not total crime. Reporting rates, Garda activity and
        footfall all move these counts independently of how much crime happens.{" "}
        <button type="button" className="text-link" onClick={() => setView("about")}>
          What this is, and is not
        </button>
      </p>
    </main>
  );
}

function Masthead({
  latest,
  theme,
  onToggleTheme,
  onOpenAbout,
  aboutLabel,
}: {
  latest: number;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenAbout: () => void;
  aboutLabel: string;
}) {
  return (
    <header className="masthead">
      <div className="masthead-title">
        {/* The mark only: the wordmark beside it already says the name, and the
            logo's own lettering would repeat it. Two files rather than a CSS
            filter, because inverting would flip the teal and magenta bars —
            the same pair the map uses for down and up. */}
        <img className="masthead-mark is-light" src="/logo-mark.png" alt="" width={52} height={60} />
        <img className="masthead-mark is-dark" src="/logo-mark-dark.png" alt="" width={52} height={60} />
        <div>
          <h1>Ireland Crime Explorer</h1>
          <p className="dateline">
            Official recorded-crime incidents · CSO CJA11 and CJQ06 · 2019–{latest}
          </p>
        </div>
      </div>
      <div className="masthead-actions">
        <button
          type="button"
          className="text-link"
          aria-pressed={theme === "dark"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? "Light" : "Dark"}
        </button>
        <button type="button" className="text-link" onClick={onOpenAbout}>
          {aboutLabel}
        </button>
      </div>
    </header>
  );
}

function OffenceRow({
  label,
  count,
  fraction,
  active,
  onSelect,
}: {
  label: string;
  count: number;
  fraction: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`offence-row${active ? " is-on" : ""}`} onClick={onSelect}>
      <span className="offence-line">
        <span>{label}</span>
        <span className="offence-count">{numberFormat.format(count)}</span>
      </span>
      <span className="offence-track">
        <span className="offence-fill" style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }} />
      </span>
    </button>
  );
}

function AboutView({ meta }: { meta: DashboardData["meta"] }) {
  return (
    <article className="about">
      <p className="about-lede">
        This is a map of what was <em>recorded</em>, not a map of danger. Every number
        here is an incident an An Garda Síochána member entered on PULSE and the CSO
        published. That is a narrower thing than crime, and the gap between them is not
        the same everywhere.
      </p>

      <section>
        <h3>Recorded, not prevalence</h3>
        <p>{meta.dataNote}</p>
      </section>
      <section>
        <h3>Reporting geographies, not neighbourhoods</h3>
        <p>
          Garda Divisions and station areas are administrative units for recording
          incidents. They are not communities, and their names are not the names of the
          places people live in.
        </p>
      </section>
      <section>
        <h3>No current catchment boundaries exist</h3>
        <p>
          Station catchment polygons are not published, and the Division polygons in
          circulation describe an older structure. That is why areas appear here as
          symbols placed at a location, never as shaded territory.
        </p>
      </section>
      <section>
        <h3>Dublin detail is Dublin-only</h3>
        <p>
          Station-level figures exist for the Dublin Metropolitan Region and nowhere
          else. The rest of the country is available at Division level only.
        </p>
      </section>
      <section>
        <h3>Two tables, two shapes</h3>
        <p>
          CJA11 gives 14 broad groups annually by station area. CJQ06 gives 16 groups and
          85 official sub-categories quarterly by Division. They do not line up, so this
          does not pretend they do.
        </p>
      </section>
      <section>
        <h3>Known breaks in the series</h3>
        <p>{meta.fraudNote}</p>
        <p>{meta.divisionGeographyNote}</p>
      </section>
      <section>
        <h3>Sources</h3>
        <p>
          Central Statistics Office, tables CJA11 (recorded crime incidents by Garda
          station) and CJQ06 (recorded crime offences by Garda Division and quarter).
        </p>
      </section>
    </article>
  );
}
