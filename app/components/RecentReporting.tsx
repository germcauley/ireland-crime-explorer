"use client";

import { useMemo, useState } from "react";
import { getNews, getNewsMeta } from "../lib/news";

/**
 * Reporting, in the readout rail beside the area it belongs to.
 *
 * It appears only where the selected area has coverage. There is no empty
 * state, no article count and no ranking of areas by how much press they
 * attract — newsrooms cluster in cities and cover what is notable, so any of
 * those would let coverage read as a measure of crime. The "coverage is not
 * crime" caveat lives in the disclosure view rather than repeating here.
 *
 * Articles are pinned to Divisions and never to station areas, which the app
 * already says are not boundaries. The Dublin station view therefore pools the
 * reporting of all six DMR Divisions under one heading.
 */

const VISIBLE = 3;

function formatDate(value: string | null): string {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-IE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function RecentReporting({
  divisionIds,
  areaName,
}: {
  divisionIds: string[];
  areaName: string;
}) {
  const [town, setTown] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const meta = getNewsMeta();

  // The parent keys this component by area, so a new area remounts it and the
  // town filter starts fresh. Resetting in an effect would cascade a render.
  const key = divisionIds.join(",");

  const articles = useMemo(
    () => divisionIds.flatMap((id) => getNews({ divisionId: id })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const towns = useMemo(() => {
    const named = new Set<string>();
    articles.forEach((article) => {
      if (article.town) named.add(article.town);
    });
    return Array.from(named).sort((a, b) => a.localeCompare(b));
  }, [articles]);

  const filtered = useMemo(
    () =>
      articles
        .filter((article) => !town || article.town === town)
        .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")),
    [articles, town],
  );

  // No coverage, no section. An empty state here would be a statement about the
  // area rather than about the outlet list.
  if (articles.length === 0) return null;

  const shown = showAll ? filtered : filtered.slice(0, VISIBLE);

  return (
    <section className="reporting" aria-labelledby="reporting-title">
      <p className="reporting-spot">In the news</p>
      <h2 id="reporting-title">Recent reporting</h2>
      <p className="reporting-lede">
        News articles about {areaName} from local and national outlets, last{" "}
        {meta.windowMonths} months
      </p>

      {towns.length > 1 && (
        <div className="reporting-towns">
          <button type="button" className={town === null ? "is-on" : ""} onClick={() => setTown(null)}>
            Any town
          </button>
          {towns.map((name) => (
            <button
              type="button"
              key={name}
              className={town === name ? "is-on" : ""}
              onClick={() => setTown(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <ul className="reporting-list">
        {shown.map((article) => (
          <li key={article.id}>
            <a href={article.url} target="_blank" rel="noreferrer nofollow">
              {article.title}
            </a>
            <p className="reporting-meta">
              {article.source}
              {article.publishedAt && <> · {formatDate(article.publishedAt)}</>}
              {article.town && <> · {article.town}</>}
            </p>
          </li>
        ))}
      </ul>

      {filtered.length > VISIBLE && (
        <button type="button" className="reporting-more" onClick={() => setShowAll((value) => !value)}>
          {showAll ? "Show fewer" : `All ${filtered.length} items`}
        </button>
      )}
    </section>
  );
}
