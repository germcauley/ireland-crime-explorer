"use client";

import { useMemo, useState } from "react";
import { getAllNews, getNews, getNewsMeta, getNewsTowns } from "../lib/news";

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
  divisionNames,
  onSelectDivision,
}: {
  divisionId: string | null;
  divisionName: string;
  /** id -> name, so a nationwide item can name the Division it belongs to. */
  divisionNames: Record<string, string>;
  onSelectDivision: (id: string) => void;
  /** CJQ06 group. Sub-categories are narrowed to their parent before arriving here. */
  group: string | null;
  groupLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [town, setTown] = useState<string | null>(null);
  // A Division's whole list is the default view. Narrowing to the selected
  // offence group is something the reader opts into, because at this volume
  // the group filter almost always empties the list — 36 articles across 28
  // Divisions and 17 groups leaves most combinations with nothing in them.
  const [narrowToGroup, setNarrowToGroup] = useState(false);
  const [feedsOpen, setFeedsOpen] = useState(false);
  // Ten of 28 Divisions have no coverage, so a reader hunting for reporting
  // would otherwise have to guess which ones do. This is chronological and
  // every item names its own Division — never a ranking of areas by how much
  // press they attract.
  const [nationwide, setNationwide] = useState(false);

  const meta = getNewsMeta();
  const towns = useMemo(() => getNewsTowns(divisionId), [divisionId]);

  const all = useMemo(() => getNews({ divisionId }), [divisionId]);
  const everywhere = useMemo(() => getAllNews(), []);
  const matching = useMemo(
    () => getNews({ divisionId, group: narrowToGroup ? group : null, town }),
    [divisionId, group, town, narrowToGroup],
  );

  // Only meaningful once the reader has narrowed. Widening back is offered
  // explicitly rather than done silently, so nothing appears under a heading
  // it does not belong to.
  const widerInDivision = useMemo(
    () => (matching.length === 0 && (narrowToGroup || town) ? all : []),
    [all, matching.length, narrowToGroup, town],
  );

  const shown = nationwide ? everywhere : matching;

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
        {/* Binary, never a count: whether this Division has any coverage at all.
            A number here would let article volume stand in for crime volume,
            and would rank Divisions by how much press they attract. */}
        {all.length > 0 && !open && <span className="reporting-has">reporting available</span>}
        <span className="reporting-chevron" aria-hidden="true" data-open={open}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="reporting-body">
          <p className="reporting-lede">
            {nationwide ? (
              <>All reporting from the last {meta.windowMonths} months, everywhere in the State.</>
            ) : (
              <>
                All reporting from the last {meta.windowMonths} months on {divisionName}
                {narrowToGroup && <>, narrowed to {groupLabel.toLowerCase()}</>}.
              </>
            )}{" "}
            Not a record of the incidents counted above — news coverage follows
            what is newsworthy and where newsrooms are, not where crime happens.
          </p>

          <div className="reporting-filters">
            <button
              type="button"
              className={nationwide ? "is-active" : ""}
              aria-pressed={nationwide}
              onClick={() => setNationwide((value) => !value)}
            >
              Everywhere
            </button>
          </div>

          {!nationwide && (towns.length > 0 || group) && (
            <div className="reporting-filters">
              {group && (
                <button
                  type="button"
                  className={narrowToGroup ? "is-active" : ""}
                  aria-pressed={narrowToGroup}
                  onClick={() => setNarrowToGroup((value) => !value)}
                >
                  Only {groupLabel.toLowerCase()}
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

          {shown.length > 0 ? (
            <ul className="reporting-list">
              {shown.map((cluster) => (
                <li key={cluster.id}>
                  <a href={cluster.url} target="_blank" rel="noreferrer nofollow">
                    {cluster.title}
                  </a>
                  <p className="reporting-meta">
                    {/* Nationwide items name their Division, so no headline ever
                        appears detached from the geography it belongs to. */}
                    {nationwide && cluster.divisionId && (
                      <>
                        <button
                          type="button"
                          className="reporting-jump"
                          onClick={() => onSelectDivision(cluster.divisionId as string)}
                        >
                          {divisionNames[cluster.divisionId] ?? "Unknown Division"}
                        </button>
                        {" · "}
                      </>
                    )}
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
              {narrowToGroup || town
                ? "Nothing matched that narrowing. The full list for this Division is below."
                : "No reporting from the outlets below covered this Division in the window. That is often the honest answer: most incidents are never reported, and local coverage is uneven."}
            </p>
          )}

          {!nationwide && widerInDivision.length > 0 && (
            <div className="reporting-wider">
              <h3>Other reporting from {divisionName}</h3>
              <p className="reporting-wider-note">
                The full list for this Division, shown because the narrowing
                above returned nothing.
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
