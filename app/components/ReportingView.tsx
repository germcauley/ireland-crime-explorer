"use client";

import { useMemo, useState } from "react";
import { getAllNews, getNewsMeta } from "../lib/news";

/**
 * Reporting as a peer of the statistics, not a footnote to them.
 *
 * The two answer different questions and neither is subordinate. CJQ06 says how
 * much was recorded, in which Division, and which way it moved — quarterly,
 * aggregated, ending 2025Q4. Reporting says what happened, in a named town,
 * last week. Trying to make the second explain the first never worked: a few
 * dozen articles cannot account for a trend, and anything that could would be
 * a feature, not a police blotter.
 *
 * The guardrail that still matters is narrower than the one we started with:
 * coverage is not crime. Newsrooms cluster in cities and cover what is
 * notable, so this list is chronological and never ranked, counts of articles
 * are never shown as a measure of anywhere, and the outlets searched are one
 * click away — an absence here means nobody in that list wrote it up.
 */

function formatDate(value: string | null): string {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-IE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function ReportingView({
  divisionNames,
  divisionCounties,
  groupLabels,
  onSelectDivision,
}: {
  divisionNames: Record<string, string>;
  /** Division id -> the counties it covers, for the county filter. */
  divisionCounties: Record<string, string[]>;
  groupLabels: Record<string, string>;
  onSelectDivision: (id: string) => void;
}) {
  const [county, setCounty] = useState("");
  const [group, setGroup] = useState("");
  const [query, setQuery] = useState("");
  const [feedsOpen, setFeedsOpen] = useState(false);

  const meta = getNewsMeta();
  const everything = useMemo(() => getAllNews(), []);

  // Only offer a filter value that some article actually has. Offering the
  // full list of counties or offence groups would imply coverage that does
  // not exist, and most selections would return nothing.
  const counties = useMemo(() => {
    const present = new Set<string>();
    for (const article of everything) {
      for (const name of divisionCounties[article.divisionId ?? ""] ?? []) present.add(name);
    }
    return Array.from(present).sort((a, b) => a.localeCompare(b));
  }, [everything, divisionCounties]);

  const groups = useMemo(() => {
    const present = new Set<string>();
    for (const article of everything) if (article.group) present.add(article.group);
    return Array.from(present).sort();
  }, [everything]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return everything.filter((article) => {
      if (group && article.group !== group) return false;
      if (county) {
        const covered = divisionCounties[article.divisionId ?? ""] ?? [];
        if (!covered.includes(county)) return false;
      }
      if (needle) {
        const haystack = `${article.title} ${article.description} ${article.town ?? ""} ${
          divisionNames[article.divisionId ?? ""] ?? ""
        }`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [everything, group, county, query, divisionCounties, divisionNames]);

  const filtered = Boolean(county || group || query.trim());

  return (
    <section className="reporting-view" aria-labelledby="reporting-view-title">
      <div className="reporting-view-head">
        <div>
          <h2 id="reporting-view-title">Recent reporting</h2>
          <p>
            What Irish outlets have published in the last {meta.windowMonths} months, newest
            first. Coverage is not crime — newsrooms cluster in cities and cover what is
            notable, so this is no measure of where offences happen.
          </p>
        </div>
        <button
          type="button"
          className="reporting-view-feeds-toggle"
          aria-expanded={feedsOpen}
          onClick={() => setFeedsOpen((value) => !value)}
        >
          {feedsOpen ? "Hide outlets" : `${meta.feeds.length} outlets`}
        </button>
      </div>

      {feedsOpen && (
        <div className="reporting-feeds">
          <p>
            Nothing here means no outlet in this list covered it, which is not the
            same as nothing having happened.
          </p>
          <ul>
            {meta.feeds.map((feed) => (
              <li key={feed.url}>
                {feed.name} <span>{feed.scope}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="reporting-view-filters">
        <label>
          <span>Search</span>
          <input
            type="search"
            value={query}
            placeholder="Town, outlet or wording"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span>County</span>
          <select value={county} onChange={(event) => setCounty(event.target.value)}>
            <option value="">Anywhere</option>
            {counties.map((name) => (
              <option value={name} key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Offence group</span>
          <select value={group} onChange={(event) => setGroup(event.target.value)}>
            <option value="">Any offence</option>
            {groups.map((id) => (
              <option value={id} key={id}>{groupLabels[id] ?? id}</option>
            ))}
          </select>
        </label>
        {filtered && (
          <button
            type="button"
            className="reporting-view-clear"
            onClick={() => {
              setCounty("");
              setGroup("");
              setQuery("");
            }}
          >
            Clear
          </button>
        )}
      </div>

      {shown.length > 0 ? (
        <ul className="reporting-view-list">
          {shown.map((article) => (
            <li key={article.id}>
              <a href={article.url} target="_blank" rel="noreferrer nofollow">
                {article.title}
              </a>
              <p className="reporting-view-meta">
                {/* The Division is always present and always a way back to the
                    statistics, so no headline stands free of its geography. */}
                <button
                  type="button"
                  className="reporting-jump"
                  onClick={() => onSelectDivision(article.divisionId as string)}
                >
                  {divisionNames[article.divisionId ?? ""] ?? "Unknown Division"}
                </button>
                {article.town && <> · {article.town}</>}
                {article.group && <> · {groupLabels[article.group] ?? article.group}</>}
                {" · "}
                {article.source}
                {article.publishedAt && <> · {formatDate(article.publishedAt)}</>}
                {article.alsoCoveredBy.length > 0 && (
                  <> · also covered by {article.alsoCoveredBy.length} other{article.alsoCoveredBy.length > 1 ? " outlets" : " outlet"}</>
                )}
              </p>
              {article.description && (
                <p className="reporting-view-snippet">{article.description}</p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="reporting-empty">
          {filtered
            ? "Nothing matched those filters."
            : "No reporting has been matched yet."}
        </p>
      )}
    </section>
  );
}
