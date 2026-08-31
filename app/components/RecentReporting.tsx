"use client";

import { useMemo, useState } from "react";
import { getNews, getNewsMeta, getNewsTowns } from "../lib/news";

/**
 * Recent reporting.
 *
 * Coverage *of* crime, never a record of the crime itself. The distinction is
 * the whole point: news volume tracks newsworthiness and where newsrooms are,
 * not where offences happen, so this section is deliberately subordinate to
 * the statistics above it — collapsed by default, never showing an article
 * count, never ranking areas by how much coverage they have.
 *
 * Only appears for Divisions. Dublin station areas are Voronoi cells drawn
 * from station points, which the app already tells readers are not boundaries;
 * pinning an article to one would assert exactly what that caveat denies.
 */

function formatDate(value: string | null): string {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-IE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function RecentReporting({
  divisionId,
  divisionName,
  group,
  groupLabel,
}: {
  divisionId: string | null;
  divisionName: string;
  /** CJQ06 group. Sub-categories are narrowed to their parent before arriving here. */
  group: string | null;
  groupLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [town, setTown] = useState<string | null>(null);
  const [ignoreGroup, setIgnoreGroup] = useState(false);
  const [feedsOpen, setFeedsOpen] = useState(false);

  const meta = getNewsMeta();
  const towns = useMemo(() => getNewsTowns(divisionId), [divisionId]);

  const matching = useMemo(
    () => getNews({ divisionId, group: ignoreGroup ? null : group, town }),
    [divisionId, group, town, ignoreGroup],
  );

  // Kept separate and separately labelled. Widening the search silently is how
  // articles end up under a heading they do not belong to.
  const widerInDivision = useMemo(
    () => (matching.length === 0 ? getNews({ divisionId }) : []),
    [divisionId, matching.length],
  );

  if (!divisionId) return null;

  return (
    <section className="reporting" aria-labelledby="reporting-title">
      <button
        type="button"
        className="reporting-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span id="reporting-title">Recent reporting</span>
        <span className="reporting-chevron" aria-hidden="true" data-open={open}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="reporting-body">
          <p className="reporting-lede">
            Reporting from the last {meta.windowMonths} months on {divisionName}. Not a
            record of the incidents counted above — news coverage follows what is
            newsworthy and where newsrooms are, not where crime happens.
          </p>

          {(towns.length > 0 || group) && (
            <div className="reporting-filters">
              {group && (
                <button
                  type="button"
                  className={ignoreGroup ? "" : "is-active"}
                  onClick={() => setIgnoreGroup((value) => !value)}
                >
                  {groupLabel}
                </button>
              )}
              {towns.length > 0 && (
                <label className="reporting-town">
                  <span className="visually-hidden">Filter by town named in the article</span>
                  <select
                    value={town ?? ""}
                    onChange={(event) => setTown(event.target.value || null)}
                  >
                    <option value="">Any town named</option>
                    {towns.map((name) => (
                      <option value={name} key={name}>{name}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          {matching.length > 0 ? (
            <ul className="reporting-list">
              {matching.map((cluster) => (
                <li key={cluster.id}>
                  <a href={cluster.url} target="_blank" rel="noreferrer nofollow">
                    {cluster.title}
                  </a>
                  <p className="reporting-meta">
                    {cluster.source}
                    {cluster.publishedAt && <> · {formatDate(cluster.publishedAt)}</>}
                    {cluster.town && <> · {cluster.town}</>}
                    {cluster.alsoCoveredBy.length > 0 && (
                      <> · also covered by {cluster.alsoCoveredBy.length} other{cluster.alsoCoveredBy.length > 1 ? " outlets" : " outlet"}</>
                    )}
                  </p>
                  {cluster.description && <p className="reporting-snippet">{cluster.description}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="reporting-empty">
              No reporting from the outlets below matched this selection. That is
              often the honest answer: most incidents are never reported, and
              local coverage is uneven.
            </p>
          )}

          {widerInDivision.length > 0 && (
            <div className="reporting-wider">
              <h3>Other reporting from {divisionName}</h3>
              <p className="reporting-wider-note">
                Not matched to {groupLabel.toLowerCase()} — shown only because nothing
                matched the selection above.
              </p>
              <ul className="reporting-list">
                {widerInDivision.slice(0, 5).map((cluster) => (
                  <li key={cluster.id}>
                    <a href={cluster.url} target="_blank" rel="noreferrer nofollow">
                      {cluster.title}
                    </a>
                    <p className="reporting-meta">
                      {cluster.source}
                      {cluster.publishedAt && <> · {formatDate(cluster.publishedAt)}</>}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            type="button"
            className="reporting-feeds-toggle"
            aria-expanded={feedsOpen}
            onClick={() => setFeedsOpen((value) => !value)}
          >
            {feedsOpen ? "Hide" : "Show"} the {meta.feeds.length} outlets searched
          </button>
          {feedsOpen && (
            <div className="reporting-feeds">
              <p>
                An absence of reporting here means no outlet in this list covered it,
                which is not the same as nothing having happened.
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
        </div>
      )}
    </section>
  );
}
