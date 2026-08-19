#!/usr/bin/env python3
"""Transform the official JSON-stat cube into canonical and UI datasets."""

from __future__ import annotations

import csv
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RAW_PATH = ROOT / "data" / "raw" / "cja11.json"
CJQ06_PATH = ROOT / "data" / "raw" / "cjq06.json"
POINTS_PATH = ROOT / "data" / "geography" / "dublin_garda_stations.geojson"
DIVISION_ZIP_PATH = ROOT / "data" / "geography" / "garda_divisions.zip"
DIVISION_GEOJSON_PATH = ROOT / "data" / "geography" / "garda_divisions.geojson"
METADATA_PATH = ROOT / "data" / "geography" / "station_metadata.csv"
PLACES_PATH = ROOT / "data" / "geography" / "place_lookup.csv"
PROCESSED_DIR = ROOT / "data" / "processed"
PUBLIC_DATA_DIR = ROOT / "public" / "data"

OFFENCE_DIMENSION = "C02480V03003"
STATION_DIMENSION = "C03037V05454"
YEAR_DIMENSION = "TLIST(A1)"

DIVISION_DIMENSION = "C02481V03160"
QUARTER_DIMENSION = "TLIST(Q1)"

IRISH_GRID_EPSG = "EPSG:29903"
WGS84_EPSG = "EPSG:4326"

def normalise_division_label(label: str) -> str:
    """CJQ06 division label -> canonical name.

    Matches the CJA11 station "division" field and (after stripping
    " Division") the CSO boundary shapefile's DIVISION field. CJQ06 spells
    the DMR divisions "Northern"/"Southern"/"Eastern"/"Western"; CJA11 and
    the boundary file use "North"/"South"/"East"/"West".
    """
    name = re.sub(r"\s*Garda Division\s*$", "", label).strip()
    name = name.replace("D.M.R.", "DMR")
    name = name.replace("Northern", "North").replace("Southern", "South")
    name = name.replace("Eastern", "East").replace("Western", "West")
    return f"{name} Division"


def read_division_code_map() -> dict[str, str]:
    """All 28 national CJQ06 division codes -> canonical name."""
    cube = json.loads(CJQ06_PATH.read_text(encoding="utf-8"))
    dimension = cube["dimension"][DIVISION_DIMENSION]
    codes = ordered_codes(dimension)
    labels = dimension["category"]["label"]
    return {code: normalise_division_label(labels[code]) for code in codes}

OFFICIAL_CATEGORY_COPY = {
    "03": ("Assaults, threats & harassment", "Assaults / threats"),
    "04": ("Dangerous or negligent acts", "Dangerous acts"),
    "05": ("Kidnapping and related offences", "Kidnapping"),
    "06": ("Robbery, extortion & hijacking", "Robbery"),
    "07": ("Burglary and related offences", "Burglary"),
    "08": ("Theft and related offences", "Theft"),
    "09": ("Fraud, deception & related offences", "Fraud"),
    "10": ("Controlled drug offences", "Drugs"),
    "11": ("Weapons and explosives offences", "Weapons"),
    "12": ("Damage to property & environment", "Criminal damage"),
    "13": ("Public order & social code offences", "Public order"),
    "14": ("Road and traffic offences", "Road & traffic"),
    "15": ("Government, justice & organised crime offences", "Justice offences"),
    "16": ("Offences not elsewhere classified", "Other offences"),
}

# CJQ06 (division level) publishes two extra top-level groups that CJA11
# excludes at station level entirely.
DIVISION_ONLY_CATEGORY_COPY = {
    "01": ("Homicide & related offences", "Homicide"),
    "02": ("Sexual offences", "Sexual offences"),
}
DIVISION_TOP_LEVEL_COPY = {**DIVISION_ONLY_CATEGORY_COPY, **OFFICIAL_CATEGORY_COPY}

GROUPS = [
    {
        "id": "all",
        "label": "All published station categories",
        "shortLabel": "All recorded",
        "codes": list(OFFICIAL_CATEGORY_COPY),
        "description": (
            "Sum of the categories published in CJA11 for this station and year. "
            "Fraud is unavailable from 2024, so recent totals exclude it."
        ),
    },
    {
        "id": "personal",
        "label": "Personal / violent crime",
        "shortLabel": "Personal / violent",
        "codes": ["03", "06", "11"],
        "description": "Assaults/threats, robbery and weapons offences.",
    },
    {
        "id": "home",
        "label": "Home safety",
        "shortLabel": "Home safety",
        "codes": ["07"],
        "description": (
            "Burglary and related offences. CJA11 does not separate residential "
            "from non-residential burglary at station level."
        ),
    },
    {
        "id": "property",
        "label": "Property crime",
        "shortLabel": "Property",
        "codes": ["07", "12"],
        "description": "Burglary plus damage to property and the environment.",
    },
    {
        "id": "disorder",
        "label": "Disorder",
        "shortLabel": "Disorder",
        "codes": ["11", "12", "13"],
        "description": "Weapons, criminal damage and public-order offences.",
    },
    {
        "id": "drugs",
        "label": "Recorded drug activity",
        "shortLabel": "Drugs",
        "codes": ["10"],
        "description": "Strongly affected by policing and enforcement activity.",
    },
    {
        "id": "theft_retail",
        "label": "Theft / retail",
        "shortLabel": "Theft",
        "codes": ["08"],
        "description": (
            "All theft and related offences. CJA11 does not separate shop theft "
            "or vehicle theft at station level."
        ),
    },
]

POINT_ALIASES = {
    "irishown": "irishtown",
    "mountjy": "mountjoy",
    "bridewell": "bridewell dublin",
    "blackrock": "blackrock co dublin",
}


def ordered_codes(dimension: dict[str, Any]) -> list[str]:
    index = dimension["category"]["index"]
    if isinstance(index, list):
        return index
    return [code for code, _ in sorted(index.items(), key=lambda item: item[1])]


def normalise(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    value = value.casefold().replace("co.", "co")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value).split())


def parse_station_label(label: str) -> tuple[str, str]:
    match = re.match(r"^(.*), (D\.M\.R\. .* Division) \(\d+\)$", label)
    if not match:
        raise ValueError(f"Unexpected DMR station label: {label}")
    name = match.group(1)
    division = match.group(2).replace("D.M.R.", "DMR").replace(" Eastern", " East").replace(" Western", " West")
    return name, division


def read_cube() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    cube = json.loads(RAW_PATH.read_text(encoding="utf-8"))
    years = ordered_codes(cube["dimension"][YEAR_DIMENSION])
    stations = ordered_codes(cube["dimension"][STATION_DIMENSION])
    offences = ordered_codes(cube["dimension"][OFFENCE_DIMENSION])
    station_labels = cube["dimension"][STATION_DIMENSION]["category"]["label"]
    offence_labels = cube["dimension"][OFFENCE_DIMENSION]["category"]["label"]
    values = cube["value"]
    sizes = cube["size"]

    rows: list[dict[str, Any]] = []
    for year_index, year in enumerate(years):
        for station_index, station_code in enumerate(stations):
            station_label = station_labels[station_code]
            if "D.M.R." not in station_label:
                continue
            station_name, division = parse_station_label(station_label)
            for offence_index, offence_code in enumerate(offences):
                flat_index = (
                    (year_index * sizes[2] + station_index) * sizes[3]
                    + offence_index
                )
                value = values[flat_index]
                rows.append(
                    {
                        "year": int(year),
                        "division": division,
                        "station": station_name,
                        "station_code": station_code,
                        "offence_code": offence_code,
                        "offence_category": offence_labels[offence_code],
                        "offence_group": OFFICIAL_CATEGORY_COPY[offence_code][0],
                        "incident_count": "" if value is None else int(value),
                    }
                )
    return cube, rows


def read_points() -> dict[str, dict[str, Any]]:
    geojson = json.loads(POINTS_PATH.read_text(encoding="utf-8"))
    points: dict[str, dict[str, Any]] = {}
    for feature in geojson["features"]:
        key = normalise(feature["properties"]["Station"])
        key = POINT_ALIASES.get(key, key)
        longitude, latitude = feature["geometry"]["coordinates"]
        points[key] = {
            "lat": latitude,
            "lng": longitude,
            "address": ", ".join(
                part.strip()
                for part in [
                    feature["properties"].get("Address1", ""),
                    feature["properties"].get("Address2", ""),
                    feature["properties"].get("Address3", ""),
                ]
                if part.strip()
            ),
        }
    return points


def read_csv_by_key(path: Path, key: str) -> dict[str, dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return {normalise(row[key]): row for row in csv.DictReader(handle)}


def convert_division_boundaries(division_code_map: dict[str, str]) -> dict[str, dict[str, Any]]:
    """Reproject the CSO Garda Division shapefile to WGS84 GeoJSON.

    Returns canonical division name -> GeoJSON geometry for all 28 national
    divisions, and also writes the full FeatureCollection to data/geography
    for reference/QA.
    """
    import shapefile
    from pyproj import Transformer
    from shapely.geometry import mapping, shape
    from shapely.ops import transform as shapely_transform

    transformer = Transformer.from_crs(IRISH_GRID_EPSG, WGS84_EPSG, always_xy=True)
    reader = shapefile.Reader(str(DIVISION_ZIP_PATH))

    geometries: dict[str, dict[str, Any]] = {}
    features = []
    for shape_record in reader.shapeRecords():
        record = shape_record.record
        raw_geometry = shape(shape_record.shape.__geo_interface__).simplify(60, preserve_topology=True)
        geometry = shapely_transform(transformer.transform, raw_geometry)
        geojson_geometry = mapping(geometry)
        division_name = f"{record['DIVISION']} Division"
        geometries[division_name] = geojson_geometry
        features.append(
            {
                "type": "Feature",
                "properties": {"division": division_name},
                "geometry": geojson_geometry,
            }
        )

    expected_names = set(division_code_map.values())
    if set(geometries) != expected_names:
        missing = expected_names - set(geometries)
        extra = set(geometries) - expected_names
        raise ValueError(f"division boundary mismatch: missing={missing} extra={extra}")

    DIVISION_GEOJSON_PATH.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False),
        encoding="utf-8",
    )
    return geometries


def clean_offence_label(label: str) -> str:
    return re.sub(r"\s*\(\d[\d,]*\)\s*$", "", label).strip()


def read_cjq06_cube(division_code_map: dict[str, str]) -> tuple[list[str], dict[str, Any]]:
    """Parse CJQ06 into division-code -> {offence_code: {quarter: count}}."""
    cube = json.loads(CJQ06_PATH.read_text(encoding="utf-8"))
    quarters = ordered_codes(cube["dimension"][QUARTER_DIMENSION])
    divisions = ordered_codes(cube["dimension"][DIVISION_DIMENSION])
    offences = ordered_codes(cube["dimension"][OFFENCE_DIMENSION])
    offence_labels = cube["dimension"][OFFENCE_DIMENSION]["category"]["label"]
    values = cube["value"]
    sizes = cube["size"]

    quarter_labels = [
        cube["dimension"][QUARTER_DIMENSION]["category"]["label"][code] for code in quarters
    ]

    by_division: dict[str, dict[str, dict[str, int | None]]] = {
        code: {offence: {} for offence in offences} for code in division_code_map
    }
    for quarter_index, quarter_label in enumerate(quarter_labels):
        for division_index, division_code in enumerate(divisions):
            if division_code not in division_code_map:
                continue
            for offence_index, offence_code in enumerate(offences):
                flat_index = (
                    (quarter_index * sizes[2] + division_index) * sizes[3] + offence_index
                )
                value = values[flat_index]
                by_division[division_code][offence_code][quarter_label] = (
                    None if value is None else int(value)
                )

    return quarter_labels, {
        "by_division": by_division,
        "offence_labels": {code: clean_offence_label(offence_labels[code]) for code in offences},
        "offence_codes": offences,
    }


def build_offence_hierarchy(offence_codes: list[str], offence_labels: dict[str, str]) -> list[dict[str, Any]]:
    children_by_parent: dict[str, list[str]] = defaultdict(list)
    for code in offence_codes:
        if len(code) > 2:
            children_by_parent[code[:2]].append(code)

    hierarchy = []
    for code in sorted(DIVISION_TOP_LEVEL_COPY):
        _, short_label = DIVISION_TOP_LEVEL_COPY[code]
        hierarchy.append(
            {
                "id": code,
                "label": offence_labels.get(code, short_label),
                "shortLabel": short_label,
                "children": [
                    {"id": child_code, "label": offence_labels[child_code]}
                    for child_code in sorted(children_by_parent.get(code, []))
                ],
            }
        )
    return hierarchy


def build_division_records(
    quarter_labels: list[str],
    cjq06: dict[str, Any],
    boundaries: dict[str, dict[str, Any]],
    division_code_map: dict[str, str],
) -> list[dict[str, Any]]:
    records = []
    for division_code, division_name in division_code_map.items():
        boundary = boundaries.get(division_name)
        if boundary is None:
            raise ValueError(f"No boundary geometry matched division {division_name!r}")
        offence_series = cjq06["by_division"][division_code]
        series = {
            code: [quarter_values.get(quarter) for quarter in quarter_labels]
            for code, quarter_values in offence_series.items()
        }
        records.append(
            {
                "id": division_code,
                "name": division_name,
                "boundary": boundary,
                "series": series,
            }
        )
    return records


def build_dashboard(rows: list[dict[str, Any]]) -> dict[str, Any]:
    points = read_points()
    metadata = read_csv_by_key(METADATA_PATH, "station")
    with PLACES_PATH.open(newline="", encoding="utf-8") as handle:
        places = list(csv.DictReader(handle))

    division_code_map = read_division_code_map()
    boundaries = convert_division_boundaries(division_code_map)
    quarter_labels, cjq06 = read_cjq06_cube(division_code_map)
    division_categories = build_offence_hierarchy(cjq06["offence_codes"], cjq06["offence_labels"])
    division_records = build_division_records(quarter_labels, cjq06, boundaries, division_code_map)

    years = sorted({row["year"] for row in rows if row["year"] >= 2019})
    station_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["year"] in years:
            station_rows[row["station_code"]].append(row)

    place_records = []
    places_by_station: dict[str, list[str]] = defaultdict(list)
    for place in places:
        station_ids = [value.strip() for value in place["station_codes"].split("|")]
        for station_id in station_ids:
            places_by_station[station_id].append(place["place"])
        place_records.append(
            {
                "place": place["place"],
                "stationIds": station_ids,
                "confidence": place["confidence"],
                "note": place["note"],
            }
        )

    station_records = []
    for station_code, records in sorted(station_rows.items()):
        sample = records[0]
        station_name = sample["station"]
        point_key = normalise(station_name)
        point = points.get(point_key)
        if point is None:
            raise ValueError(f"No authoritative point matched {station_name}")
        station_meta = metadata.get(point_key, {})
        by_code_year: dict[str, dict[int, int | None]] = defaultdict(dict)
        for row in records:
            value = row["incident_count"]
            by_code_year[row["offence_code"]][row["year"]] = (
                None if value == "" else int(value)
            )

        series: dict[str, list[int | None]] = {}
        for code in OFFICIAL_CATEGORY_COPY:
            series[code] = [by_code_year[code].get(year) for year in years]
        for group in GROUPS:
            grouped_series: list[int | None] = []
            for year_index, _year in enumerate(years):
                values = [series[code][year_index] for code in group["codes"]]
                available = [value for value in values if value is not None]
                grouped_series.append(sum(available) if available else None)
            series[group["id"]] = grouped_series

        flags = [
            flag
            for flag in [
                "high_footfall",
                "retail",
                "transport",
                "nightlife",
                "large_catchment",
            ]
            if station_meta.get(flag) == "1"
        ]
        station_records.append(
            {
                "id": station_code,
                "name": station_name,
                "division": sample["division"],
                **point,
                "flags": flags,
                "contextNote": station_meta.get("notes", ""),
                "places": sorted(places_by_station.get(station_code, [])),
                "series": series,
            }
        )

    official_categories = [
        {
            "id": code,
            "label": label,
            "shortLabel": short_label,
            "codes": [code],
            "kind": "official",
            "description": "Official CJA11 offence group.",
            **(
                {
                    "availabilityNote": (
                        "2023 is not comparable; station-level values are unavailable "
                        "from 2024 due to the financial-institution reporting backlog."
                    )
                }
                if code == "09"
                else {}
            ),
        }
        for code, (label, short_label) in OFFICIAL_CATEGORY_COPY.items()
    ]
    grouped_categories = [{**group, "kind": "grouped"} for group in GROUPS]

    return {
        "meta": {
            "title": "Dublin Crime Explorer",
            "sourceTable": "CSO CJA11",
            "sourceLabel": "Central Statistics Office — recorded crime incidents",
            "latestCompleteYear": max(years),
            "years": years,
            "geography": "Garda station / sub-district point",
            "geographyNote": (
                "Markers show authoritative station locations, not catchment boundaries. "
                "A station name must not be read as the boundary of the suburb with the same name."
            ),
            "dataNote": (
                "Recorded incidents are not actual prevalence. Reporting behaviour, Garda "
                "activity, footfall and land use affect comparisons."
            ),
            "fraudNote": (
                "CJA11 station-level fraud data is not comparable for 2023 and is unavailable "
                "from 2024; recent all-category totals therefore exclude fraud."
            ),
            "vehicleNote": (
                "CJA11 only publishes broad theft at station level, so vehicle crime and shop "
                "theft cannot be separated without a different official source."
            ),
            "quarters": quarter_labels,
            "defaultQuarterStartIndex": quarter_labels.index(
                next(q for q in quarter_labels if q >= "2019Q1")
            ),
            "divisionSourceTable": "CSO CJQ06",
            "divisionSourceLabel": (
                "Central Statistics Office — recorded crime incidents by Garda Division and quarter"
            ),
            "divisionGeography": "Garda Division boundary — all 28 national divisions",
            "divisionGeographyNote": (
                "Division boundaries are the official CSO Census 2011 Garda Division polygons "
                "(Nov 2013 revision) — a real geographic boundary, unlike the approximated "
                "station cells. All 28 national Garda Divisions are shown here, coarser than the "
                "41 Dublin station areas but with the full 85-category official offence "
                "breakdown and a quarterly trend."
            ),
        },
        "categories": grouped_categories + official_categories,
        "divisionCategories": division_categories,
        "divisions": division_records,
        "stations": station_records,
        "places": place_records,
    }


def write_canonical(rows: list[dict[str, Any]]) -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    fieldnames = list(rows[0])
    with (PROCESSED_DIR / "dublin_crime_canonical.csv").open(
        "w", newline="", encoding="utf-8"
    ) as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    _cube, rows = read_cube()
    write_canonical(rows)
    dashboard = build_dashboard(rows)
    PUBLIC_DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(dashboard, ensure_ascii=False, separators=(",", ":"))
    (PROCESSED_DIR / "dashboard.json").write_text(payload, encoding="utf-8")
    (PUBLIC_DATA_DIR / "dashboard.json").write_text(payload, encoding="utf-8")
    print(
        f"Wrote {len(rows):,} canonical rows and "
        f"{len(dashboard['stations'])} Dublin station records."
    )


if __name__ == "__main__":
    main()
