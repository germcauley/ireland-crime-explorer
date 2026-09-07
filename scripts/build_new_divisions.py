#!/usr/bin/env python3
"""Build boundaries for the 21 Garda Divisions of the current operating model.

CJQ06 was archived in June 2026 and replaced by CJQ10, which reports on the
Divisional structure implemented by May 2025: 21 Divisions where the 2011/2013
structure had 28. The CSO publishes a boundary file for the old set only, so
the new set is assembled from it.

Nineteen of the twenty-one are exact unions of old Divisions. The exception is
old Kilkenny/Carlow, which splits: Carlow joins Kildare, Kilkenny joins
Waterford. That one cut needs county geometry, taken from OpenStreetMap — the
same source the gazetteer already depends on — and intersected with the CSO
polygon so the coastline and the outer edges stay the CSO's rather than OSM's.

Nothing here asserts a boundary the app then shades. The polygons exist to
place a symbol and to decide which Division a town sits in.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from shapely.geometry import LineString, mapping, shape
from shapely.ops import linemerge, polygonize, unary_union

ROOT = Path(__file__).resolve().parents[1]
OLD_GEOJSON = ROOT / "data" / "geography" / "garda_divisions.geojson"
OUT = ROOT / "data" / "geography" / "garda_divisions_2025.geojson"
# Two endpoints: the main one returns 504 under load often enough that a
# single-host retry loop just fails slower.
OVERPASS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)

# CJQ10's Garda Division codes -> the old Divisions that make them up.
# "+county" marks the one cut that old polygons cannot express.
NEW_DIVISIONS: dict[str, tuple[str, list[str]]] = {
    "100": ("Louth/Cavan/Monaghan", ["Louth", "Cavan/Monaghan"]),
    "110": ("Donegal", ["Donegal"]),
    "120": ("Galway", ["Galway"]),
    "130": ("Mayo/Roscommon/Longford", ["Mayo", "Roscommon/Longford"]),
    "140": ("Sligo/Leitrim", ["Sligo/Leitrim"]),
    "200": ("Cork City", ["Cork City"]),
    "210": ("Cork County", ["Cork North", "Cork West"]),
    "220": ("Kerry", ["Kerry"]),
    "230": ("Limerick", ["Limerick"]),
    "240": ("Clare/Tipperary", ["Clare", "Tipperary"]),
    "300": ("Kildare/Carlow", ["Kildare", "+Carlow"]),
    "310": ("Waterford/Kilkenny", ["Waterford", "+Kilkenny"]),
    "320": ("Laois/Offaly", ["Laois/Offaly"]),
    "330": ("Meath/Westmeath", ["Meath", "Westmeath"]),
    "340": ("Wexford/Wicklow", ["Wexford", "Wicklow"]),
    "400": ("DMR South Central", ["DMR South Central"]),
    "410": ("DMR North Central", ["DMR North Central"]),
    "420": ("DMR North", ["DMR North"]),
    "430": ("DMR South", ["DMR South"]),
    "440": ("DMR East", ["DMR East"]),
    "450": ("DMR West", ["DMR West"]),
}

# The old Division whose area the county cut divides.
SPLIT_PARENT = "Kilkenny/Carlow"


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def county_polygon(name: str):
    """The administrative county boundary, from OSM."""
    query = f"""
[out:json][timeout:180];
area["ISO3166-1"="IE"][admin_level=2]->.ie;
relation(area.ie)["boundary"="administrative"]["admin_level"="6"]["name"="County {name}"];
out geom;
"""
    body = urllib.parse.urlencode({"data": query}).encode()
    payload = None
    last_error = None
    for endpoint in OVERPASS:
        for attempt in range(3):
            try:
                request = urllib.request.Request(
                    endpoint,
                    data=body,
                    headers={"User-Agent": "IrelandCrimeExplorer/1.0 (boundaries)"},
                )
                with urllib.request.urlopen(request, timeout=240) as response:
                    payload = json.load(response)
                break
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
                last_error = error
                time.sleep(15 * (attempt + 1))
        if payload is not None:
            break
    if payload is None:
        fail(f"Overpass unavailable for County {name}: {last_error}")

    lines = [
        LineString([(point["lon"], point["lat"]) for point in member["geometry"]])
        for element in payload.get("elements", [])
        for member in element.get("members", [])
        if member.get("role") == "outer" and "geometry" in member
    ]
    if not lines:
        fail(f"no outer ways returned for County {name}")

    # The relation arrives as unordered ways. linemerge stitches them back into
    # rings and polygonize fills them — buffering the lines instead gives a
    # ribbon around the county rather than the county.
    polygons = list(polygonize(linemerge(lines)))
    if not polygons:
        fail(f"County {name}'s boundary ways do not close into a ring")
    return max(polygons, key=lambda polygon: polygon.area)


def main() -> None:
    if not OLD_GEOJSON.exists():
        fail(f"{OLD_GEOJSON} missing — run clean_crime_data.py first")

    old = json.loads(OLD_GEOJSON.read_text())
    by_name = {
        feature["properties"]["division"].replace(" Division", ""): shape(feature["geometry"])
        for feature in old["features"]
    }
    print(f"old boundaries: {len(by_name)} Divisions")

    needed = {p.lstrip("+") for _, parts in NEW_DIVISIONS.values() for p in parts}
    counties = {p for p in needed if p in ("Carlow", "Kilkenny")}
    missing = needed - counties - set(by_name)
    if missing:
        fail(f"old boundary file is missing: {sorted(missing)}")

    parent = by_name.get(SPLIT_PARENT)
    if parent is None:
        fail(f"{SPLIT_PARENT} Division not in the old boundary file")

    cuts = {}
    for county in sorted(counties):
        print(f"fetching County {county} from OSM…")
        piece = parent.intersection(county_polygon(county))
        if piece.is_empty:
            fail(f"County {county} does not intersect {SPLIT_PARENT}")
        cuts[county] = piece
        print(f"  {county}: {piece.area / parent.area:.0%} of {SPLIT_PARENT}")

    covered = sum(p.area for p in cuts.values())
    share = covered / parent.area
    if not 0.9 <= share <= 1.05:
        fail(f"the two county cuts cover {share:.0%} of {SPLIT_PARENT} — expected ~100%")
    print(f"  the cut accounts for {share:.0%} of {SPLIT_PARENT}")

    features = []
    for code, (name, parts) in NEW_DIVISIONS.items():
        pieces = [cuts[p[1:]] if p.startswith("+") else by_name[p] for p in parts]
        geometry = unary_union(pieces).buffer(0)
        # The centroid reads better as a symbol position, but a concave
        # Division (Kerry's peninsulas, Cork's harbour) can put it outside the
        # land it labels; representative_point is guaranteed inside.
        centroid = geometry.centroid
        if not geometry.contains(centroid):
            centroid = geometry.representative_point()
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "id": code,
                    "division": f"{name} Division",
                    "builtFrom": parts,
                    "lat": round(centroid.y, 5),
                    "lng": round(centroid.x, 5),
                },
                "geometry": mapping(geometry),
            }
        )
        print(f"{code} {name:<26} <- {', '.join(parts)}")

    OUT.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"\nwrote {OUT.relative_to(ROOT)} — {len(features)} Divisions")


if __name__ == "__main__":
    main()
