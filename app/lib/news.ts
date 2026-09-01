import newsArtifact from "@/data/processed/news.json";

/**
 * The one place news is read.
 *
 * Components must not import the artifact directly. Today this opens a
 * committed JSON file; when the archive outgrows that it becomes a query
 * against a store, and the swap is confined to this module. The shape below
 * is the contract that makes that possible.
 */

export type NewsCluster = {
  id: string;
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string | null;
  /** Other outlets that carried the same story. The canonical entry is the earliest. */
  alsoCoveredBy: string[];
  divisionId: string | null;
  /** A town the article itself named. Never inferred. */
  town: string | null;
  /** CJQ06 offence group, never a sub-category. */
  group: string | null;
  confidence: number;
  reasoning: string | null;
};

export type NewsFeed = { name: string; scope: string; url: string };

export type NewsFilters = {
  divisionId?: string | null;
  /** CJQ06 group. A sub-category code is narrowed to its parent by the caller. */
  group?: string | null;
  town?: string | null;
  county?: string | null;
  /** Months back from now. Defaults to the artifact's own window. */
  windowMonths?: number;
};

type Artifact = {
  meta: {
    generatedAt: string;
    windowMonths: number;
    model: string | null;
    articlesConsidered: number;
    candidates: number;
    unclassified: number;
    feeds: NewsFeed[];
  };
  clusters: NewsCluster[];
};

const artifact = newsArtifact as unknown as Artifact;

export function getNewsMeta() {
  return artifact.meta;
}

/**
 * Articles for a selection, newest first.
 *
 * Only articles placed in a Division are ever returned: an unplaced article
 * has no honest area to appear under. Filters narrow, they never widen — when
 * nothing matches the answer is an empty list, and the caller says so rather
 * than reaching for something looser.
 */
export function getNews(filters: NewsFilters = {}): NewsCluster[] {
  const windowMonths = filters.windowMonths ?? artifact.meta.windowMonths;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - windowMonths);

  return artifact.clusters
    .filter((cluster) => {
      if (!cluster.divisionId) return false;
      if (filters.divisionId && cluster.divisionId !== filters.divisionId) return false;
      if (filters.group && cluster.group !== filters.group) return false;
      if (filters.town && cluster.town !== filters.town) return false;
      if (cluster.publishedAt && new Date(cluster.publishedAt) < cutoff) return false;
      return true;
    })
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
}

/**
 * Towns named by the articles in a Division, for the filter control.
 *
 * Derived from what the articles actually said, so the control can only ever
 * offer a place some article named — never the full gazetteer, which would
 * imply coverage that does not exist.
 */
export function getNewsTowns(divisionId: string | null): string[] {
  if (!divisionId) return [];
  const towns = new Set<string>();
  for (const cluster of artifact.clusters) {
    if (cluster.divisionId === divisionId && cluster.town) towns.add(cluster.town);
  }
  return Array.from(towns).sort((a, b) => a.localeCompare(b));
}

/**
 * Every placed article, newest first, regardless of Division.
 *
 * The browse case: a reader who wants to know what has been reported cannot be
 * expected to guess which of 28 Divisions has coverage. Each item still names
 * its own Division, so nothing appears without the geography it belongs to,
 * and the list is chronological — never ranked by how much coverage an area
 * attracts, which would turn press attention into an apparent crime measure.
 */
export function getAllNews(windowMonths?: number): NewsCluster[] {
  return getNews({ windowMonths });
}

/** Division ids that have at least one placed article, for labelling. */
export function getNewsDivisionIds(): Set<string> {
  const ids = new Set<string>();
  for (const cluster of artifact.clusters) {
    if (cluster.divisionId) ids.add(cluster.divisionId);
  }
  return ids;
}
