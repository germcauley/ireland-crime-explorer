export type Category = {
  id: string;
  label: string;
  shortLabel: string;
  kind: "grouped" | "official";
  description: string;
  availabilityNote?: string;
};

export type Station = {
  id: string;
  name: string;
  division: string;
  lat: number;
  lng: number;
  contextNote: string;
  series: Record<string, Array<number | null>>;
};

export type DivisionCategoryChild = { id: string; label: string };
export type DivisionCategory = {
  id: string;
  label: string;
  shortLabel: string;
  children: DivisionCategoryChild[];
};

export type GeoJSONGeometry = {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown;
};

export type Division = {
  id: string;
  name: string;
  boundary: GeoJSONGeometry;
  series: Record<string, Array<number | null>>;
};

export type DashboardData = {
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
