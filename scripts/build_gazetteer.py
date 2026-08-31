"""Build the town gazetteer used to place news articles in Garda Divisions.

Towns are derived rather than hand-authored: OpenStreetMap place nodes are
fetched once, then assigned to whichever Division polygon contains them. The
Division boundaries come from the same dashboard artifact the map draws, so a
town's Division here is the Division the reader sees.

Dublin is handled separately. The DMR Divisions are small and dense, and the
app already carries a reviewed list of Dublin place names with their station
areas, so those are used instead of OSM's denser and noisier coverage.

Output: data/geography/division_places.json, committed. Re-run only when the
Division boundaries change or the list needs extending.

    python3 scripts/build_gazetteer.py
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DASHBOARD = ROOT / "data" / "processed" / "dashboard.json"
OUT = ROOT / "data" / "geography" / "division_places.json"

OVERPASS = "https://overpass-api.de/api/interpreter"

# Towns and villages carry the local names reporting actually uses. Hamlets are
# excluded: there are thousands, and a hamlet name in a headline is rare enough
# that including them costs more in false matches than it wins in coverage.
QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="IE"][admin_level=2]->.ie;
(
  node["place"~"^(city|town|village)$"](area.ie);
);
out body;
"""

# Very short names, and names that are ordinary English words, match far too
# much prose to be usable as evidence that an article is about a place.
# Real settlements whose names are ordinary English words. Left in, they match
# prose rather than places: "Hospital" (Co Limerick) fires on "taken to
# hospital", "Street" (Co Westmeath) on "street photographer", "Recess"
# (Co Galway) on "recess". Each was found by counting how many articles a name
# matched across a real fetch — see the note in docs/recent-reporting-spec.md.
STOPWORDS = {
    "hospital", "street", "grange", "newmarket", "recess", "cross", "the village",
    "newtown", "green", "bridge", "cove", "hill", "castle", "abbey", "shannon",
    "leap", "ring", "cloon", "gort", "bay", "harbour", "island", "point",
    "mills", "mount", "park", "glen", "village", "commons", "camp", "spa",
    "clash", "cloghan", "bower", "boat", "bush", "hollow", "quay", "mall",
}
MIN_NAME_LENGTH = 5


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_divisions():
    if not DASHBOARD.exists():
        fail(f"{DASHBOARD} missing — run the crime pipeline first")
    data = json.loads(DASHBOARD.read_text())
    return data["divisions"]


def fetch_places() -> list[dict]:
    """Ask Overpass for Irish settlements. One request, retried politely."""
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    last_error = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(
                OVERPASS,
                data=body,
                headers={"User-Agent": "ireland-crime-explorer/gazetteer"},
            )
            with urllib.request.urlopen(request, timeout=240) as response:
                payload = json.loads(response.read().decode())
            return payload.get("elements", [])
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            # Overpass rate-limits aggressively; backing off is expected, not
            # exceptional.
            time.sleep(20 * (attempt + 1))
    fail(f"Overpass unavailable after 3 attempts: {last_error}")
    return []


def build_polygons(divisions):
    from shapely.geometry import shape

    polygons = []
    for division in divisions:
        geometry = shape(
            {
                "type": division["boundary"]["type"],
                "coordinates": division["boundary"]["coordinates"],
            }
        )
        polygons.append((division["id"], division["name"], geometry))
    return polygons


def usable(name: str) -> bool:
    if len(name) < MIN_NAME_LENGTH:
        return False
    if name.lower() in STOPWORDS:
        return False
    # A name that is only an initial or contains digits is a data artefact.
    return name.replace(" ", "").replace("-", "").replace("'", "").isalpha()


def main() -> None:
    divisions = load_divisions()
    dmr_ids = {d["id"] for d in divisions if d["name"].startswith("DMR")}

    print(f"divisions: {len(divisions)} ({len(dmr_ids)} DMR)")
    print("fetching settlements from Overpass…")
    elements = fetch_places()
    print(f"  {len(elements)} place nodes")

    from shapely.geometry import Point

    polygons = build_polygons(divisions)
    by_division: dict[str, list[dict]] = {d["id"]: [] for d in divisions}
    placed = skipped = 0

    for element in elements:
        name = (element.get("tags") or {}).get("name:en") or (element.get("tags") or {}).get("name")
        if not name or not usable(name):
            skipped += 1
            continue
        point = Point(element["lon"], element["lat"])
        for division_id, _division_name, geometry in polygons:
            if not geometry.contains(point):
                continue
            # Dublin's own list is better than OSM's here; see module docstring.
            if division_id in dmr_ids:
                break
            by_division[division_id].append(
                {"name": name, "kind": (element.get("tags") or {}).get("place")}
            )
            placed += 1
            break

    # The app's reviewed Dublin place names, attached to the Division that
    # contains their station area.
    dashboard = json.loads(DASHBOARD.read_text())
    stations = {s["id"]: s for s in dashboard["stations"]}
    division_by_name = {d["name"]: d["id"] for d in divisions}
    dublin_added = 0
    for place in dashboard.get("places", []):
        for station_id in place["stationIds"]:
            station = stations.get(station_id)
            if not station:
                continue
            division_id = division_by_name.get(station["division"])
            if not division_id:
                continue
            entry = {"name": place["place"], "kind": "dublin"}
            if entry not in by_division[division_id]:
                by_division[division_id].append(entry)
                dublin_added += 1

    for division_id in by_division:
        by_division[division_id].sort(key=lambda p: p["name"])

    counties = {}
    for division in divisions:
        # "Cavan/Monaghan Division" covers two counties; the DMR ones cover none
        # that a headline would name.
        stem = division["name"].replace(" Division", "")
        if stem.startswith("DMR"):
            counties[division["id"]] = []
        else:
            # "Cork City", "Cork North" and "Cork West" are Division regions,
            # not counties; a headline says "Cork".
            counties[division["id"]] = [
                re.sub(r"\s+(City|North|South|East|West)$", "", part)
                for part in stem.split("/")
            ]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "meta": {
                    "source": "OpenStreetMap contributors (ODbL) + CSO station geography",
                    "note": "Towns are assigned to the Division polygon containing them.",
                },
                "divisions": [
                    {
                        "id": division["id"],
                        "name": division["name"],
                        "counties": counties[division["id"]],
                        "places": by_division[division["id"]],
                    }
                    for division in divisions
                ],
            },
            indent=1,
            ensure_ascii=False,
        )
        + "\n"
    )

    empty = [d["name"] for d in divisions if not by_division[d["id"]]]
    print(f"placed {placed} OSM settlements, {dublin_added} Dublin places, skipped {skipped}")
    print(f"wrote {OUT.relative_to(ROOT)}")
    if empty:
        print(f"warning: no places for {len(empty)} division(s): {', '.join(empty)}")


if __name__ == "__main__":
    main()
