import type { DashboardData, Division, Station } from "./dashboard-types";

export function percentageChange(current: number | null, baseline: number | null) {
  if (current === null || baseline === null || baseline < 10) return null;
  return ((current - baseline) / baseline) * 100;
}

export function quarterYear(quarter: string) {
  return Number(quarter.slice(0, 4));
}

export function annualSum(
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

// --- Natural-language query resolution -------------------------------------
//
// An LLM turns a free-text question into a QueryFilters struct (crime-type
// text, area text, year, geography). Everything below resolves that struct
// against the REAL dataset and computes the answer directly — the model
// never sees or states a number itself, so a hallucinated figure can't reach
// the user.

export type Geography = "station" | "division";

export type QueryFilters = {
  geography: Geography | null;
  area: string | null;
  category: string;
  year: number | null;
  compareYear: number | null;
};

export type QueryAnswer =
  | {
      ok: true;
      geography: Geography;
      areaLabel: string;
      stationId: string | null;
      divisionId: string | null;
      categoryLabel: string;
      categoryId: string | null;
      year: number;
      count: number | null;
      compareYear: number | null;
      compareCount: number | null;
      changePct: number | null;
    }
  | { ok: false; reason: string };

const ALL_AREA_WORDS = new Set([
  "all",
  "ireland",
  "nationwide",
  "national",
  "country",
  "everywhere",
  "dublin",
  "total",
  "overall",
]);
const ALL_CATEGORY_WORDS = new Set(["all", "total", "overall", "everything", "any"]);

function normalise(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function normaliseStemmed(value: string): string {
  return normalise(value)
    .split(" ")
    .map(stem)
    .join(" ");
}

type Candidate<T> = { id: T; labels: string[]; displayLabel: string };

// Discrete tiers, not a length-weighted score: two candidates that both merely
// "start with" the query are equally ambiguous regardless of how much longer
// one name is than the other, so ties are grouped by tier, not broken by length.
function matchTier(hay: string, needle: string): number {
  if (hay === needle) return 3;
  if (hay.startsWith(needle) || needle.startsWith(hay)) return 2;
  if (hay.includes(needle) || needle.includes(hay)) return 1;
  return 0;
}

function bestMatch<T>(query: string | null, candidates: Candidate<T>[]): { id: T } | { ambiguous: string[] } | null {
  if (!query) return null;
  const needle = normaliseStemmed(query);
  if (!needle) return null;

  const tierById = new Map<T, number>();
  const displayById = new Map<T, string>();
  for (const candidate of candidates) {
    displayById.set(candidate.id, candidate.displayLabel);
    let bestTier = tierById.get(candidate.id) ?? 0;
    for (const label of candidate.labels) {
      const hay = normaliseStemmed(label);
      if (!hay) continue;
      bestTier = Math.max(bestTier, matchTier(hay, needle));
    }
    if (bestTier > 0) tierById.set(candidate.id, bestTier);
  }
  if (tierById.size === 0) return null;

  const topTier = Math.max(...tierById.values());
  const topIds = Array.from(tierById.entries())
    .filter(([, tier]) => tier === topTier)
    .map(([id]) => id);

  // Two ids with the exact same display text (e.g. a "grouped" convenience
  // category and the single official code it wraps) aren't a meaningful
  // choice for the user — collapse to whichever was listed first.
  const seenLabels = new Set<string>();
  const distinctTopIds: T[] = [];
  for (const id of topIds) {
    const label = displayById.get(id) ?? String(id);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    distinctTopIds.push(id);
  }

  if (distinctTopIds.length === 1) return { id: distinctTopIds[0] };
  return { ambiguous: distinctTopIds.slice(0, 6).map((id) => displayById.get(id) ?? String(id)) };
}

function resolveGeography(filters: QueryFilters, data: DashboardData): Geography {
  if (filters.geography === "station" || filters.geography === "division") return filters.geography;
  if (filters.area) {
    const needle = normalise(filters.area);
    if (data.stations.some((station) => normalise(station.name).includes(needle) || needle.includes(normalise(station.name)))) {
      return "station";
    }
    if (data.divisions.some((division) => normalise(division.name).includes(needle) || needle.includes(normalise(division.name)))) {
      return "division";
    }
  }
  return "division";
}

export function computeAnswer(filters: QueryFilters, data: DashboardData): QueryAnswer {
  const geography = resolveGeography(filters, data);

  // -- Area ------------------------------------------------------------
  const areaWord = filters.area ? normalise(filters.area) : "";
  const wantsAllAreas = !filters.area || ALL_AREA_WORDS.has(areaWord);

  let stationMatch: Station | null = null;
  let divisionMatch: Division | null = null;

  if (!wantsAllAreas) {
    if (geography === "station") {
      const match = bestMatch(
        filters.area,
        data.stations.map((station) => ({ id: station, labels: [station.name], displayLabel: station.name })),
      );
      if (!match) return { ok: false, reason: `No Dublin station matches "${filters.area}".` };
      if ("ambiguous" in match) return { ok: false, reason: `"${filters.area}" matches several stations: ${match.ambiguous.join(", ")}. Be more specific.` };
      stationMatch = match.id;
    } else {
      const match = bestMatch(
        filters.area,
        data.divisions.map((division) => ({
          id: division,
          labels: [division.name, division.name.replace(/ Division$/, "")],
          displayLabel: division.name,
        })),
      );
      if (!match) return { ok: false, reason: `No Garda Division matches "${filters.area}".` };
      if ("ambiguous" in match) return { ok: false, reason: `"${filters.area}" matches several divisions: ${match.ambiguous.join(", ")}. Be more specific.` };
      divisionMatch = match.id;
    }
  }

  // -- Category ----------------------------------------------------------
  const categoryWord = normalise(filters.category);
  const wantsAllCategories = ALL_CATEGORY_WORDS.has(categoryWord);

  let stationCategoryId: string | null = null;
  let divisionCategoryId: string | null = null;
  let categoryLabel = filters.category;

  if (geography === "station") {
    if (wantsAllCategories) {
      stationCategoryId = "all";
      categoryLabel = "all recorded crime";
    } else {
      const match = bestMatch(
        filters.category,
        data.categories.map((category) => ({
          id: category.id,
          labels: [category.shortLabel, category.label],
          displayLabel: category.shortLabel,
        })),
      );
      if (!match) return { ok: false, reason: `No CJA11 offence category matches "${filters.category}".` };
      if ("ambiguous" in match) return { ok: false, reason: `"${filters.category}" matches several categories: ${match.ambiguous.join(", ")}. Be more specific.` };
      stationCategoryId = match.id;
      categoryLabel = data.categories.find((category) => category.id === stationCategoryId)?.shortLabel ?? filters.category;
    }
  } else {
    if (wantsAllCategories) {
      divisionCategoryId = "__all__";
      categoryLabel = "all recorded crime";
    } else {
      const candidates = data.divisionCategories.flatMap((group) => [
        { id: group.id, labels: [group.shortLabel, group.label], displayLabel: group.shortLabel },
        ...group.children.map((child) => ({ id: child.id, labels: [child.label], displayLabel: child.label })),
      ]);
      const match = bestMatch(filters.category, candidates);
      if (!match) return { ok: false, reason: `No CJQ06 offence category matches "${filters.category}".` };
      if ("ambiguous" in match) return { ok: false, reason: `"${filters.category}" matches several categories: ${match.ambiguous.join(", ")}. Be more specific.` };
      divisionCategoryId = match.id;
      const group = data.divisionCategories.find((g) => g.id === divisionCategoryId || g.children.some((c) => c.id === divisionCategoryId));
      const child = group?.children.find((c) => c.id === divisionCategoryId);
      categoryLabel = child?.label ?? group?.shortLabel ?? filters.category;
    }
  }

  // -- Year ----------------------------------------------------------------
  const year = filters.year ?? (geography === "station" ? data.meta.latestCompleteYear : quarterYear(data.meta.quarters[data.meta.quarters.length - 1]));
  if (geography === "station" && !data.meta.years.includes(year)) {
    return { ok: false, reason: `Station data only covers ${data.meta.years[0]}–${data.meta.years[data.meta.years.length - 1]}.` };
  }
  const earliestDivisionYear = quarterYear(data.meta.quarters[0]);
  const latestDivisionYear = quarterYear(data.meta.quarters[data.meta.quarters.length - 1]);
  if (geography === "division" && (year < earliestDivisionYear || year > latestDivisionYear)) {
    return { ok: false, reason: `Division data only covers ${earliestDivisionYear}–${latestDivisionYear}.` };
  }

  // -- Compute ---------------------------------------------------------
  function stationValue(code: string, targetYear: number): number | null {
    const yearIndex = data.meta.years.indexOf(targetYear);
    if (yearIndex === -1) return null;
    if (stationMatch) return stationMatch.series[code]?.[yearIndex] ?? null;
    let total = 0;
    let any = false;
    data.stations.forEach((station) => {
      const value = station.series[code]?.[yearIndex];
      if (value !== null && value !== undefined) {
        total += value;
        any = true;
      }
    });
    return any ? total : null;
  }

  function divisionValue(targetYear: number): number | null {
    const targetDivisions = divisionMatch ? [divisionMatch] : data.divisions;
    const codes = divisionCategoryId === "__all__" ? data.divisionCategories.map((group) => group.id) : [divisionCategoryId as string];
    let total = 0;
    let any = false;
    targetDivisions.forEach((division) => {
      codes.forEach((code) => {
        const value = annualSum(division, code, targetYear, data.meta.quarters);
        if (value !== null) {
          total += value;
          any = true;
        }
      });
    });
    return any ? total : null;
  }

  const value = (targetYear: number) => (geography === "station" ? stationValue(stationCategoryId as string, targetYear) : divisionValue(targetYear));

  const count = value(year);
  const compareYear = filters.compareYear;
  const compareCount = compareYear !== null ? value(compareYear) : null;
  const changePct = compareYear !== null ? percentageChange(count, compareCount) : null;

  const areaLabel = stationMatch?.name ?? divisionMatch?.name ?? (geography === "station" ? "all 41 Dublin areas" : "all 28 Divisions nationwide");

  return {
    ok: true,
    geography,
    areaLabel,
    stationId: stationMatch?.id ?? null,
    divisionId: divisionMatch?.id ?? null,
    categoryLabel,
    categoryId: geography === "station" ? stationCategoryId : divisionCategoryId,
    year,
    count,
    compareYear,
    compareCount,
    changePct,
  };
}
