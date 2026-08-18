#!/usr/bin/env python3
"""Fetch the official CSO CJA11 cube and Dublin Garda station points.

The script deliberately stores source files unchanged. Run clean_crime_data.py
afterwards to regenerate the application dataset.
"""

from __future__ import annotations

import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"
GEOGRAPHY_DIR = ROOT / "data" / "geography"

CSO_URL = (
    "https://ws.cso.ie/public/api.restful/"
    "PxStat.Data.Cube_API.ReadDataset/CJA11/JSON-stat/2.0/en"
)
STATION_POINTS_URL = (
    "https://data.smartdublin.ie/dataset/87ce5c48-d0de-4968-b596-4002d156105d/"
    "resource/54c2e63b-8c9e-4b49-bf49-7d3a1ba499d4/download/"
    "garda-station-dublin-final.geojson"
)


def fetch_json(url: str) -> object:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "DublinCrimeExplorer/1.0 (public-data refresh)"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def main() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    GEOGRAPHY_DIR.mkdir(parents=True, exist_ok=True)

    cso_payload = fetch_json(CSO_URL)
    station_points = fetch_json(STATION_POINTS_URL)

    write_json(RAW_DIR / "cja11.json", cso_payload)
    write_json(GEOGRAPHY_DIR / "dublin_garda_stations.geojson", station_points)
    write_json(
        RAW_DIR / "source_metadata.json",
        {
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
            "cso_table": "CJA11",
            "cso_url": CSO_URL,
            "station_points_url": STATION_POINTS_URL,
            "classification_mapping_version": "1.0.0",
        },
    )
    print("Fetched CJA11 and Dublin Garda station points.")


if __name__ == "__main__":
    main()
