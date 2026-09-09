#!/usr/bin/env python3
"""Pull the CSO's justice-outcome tables and flatten them to CSV.

Recorded crime is the front of the funnel: an incident was written down. These
tables are what happens after — detection, sanction, committal, probation,
re-offending — and nobody publishes them in a form anyone can read.

Everything here is aggregate and official. No table in the CSO catalogue
crosses nationality, ethnicity or names with offending; these are the
demographics the state actually publishes, which is sex and age.

    python3 scripts/fetch_justice_tables.py [--out DIR]
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = "https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/{}/JSON-stat/2.0/en"

TABLES = {
    # Detection and sanction
    "RCD05": "Recorded crime detection rates by quarter",
    "RCD07": "Proportion of crimes reported leading to charge or summons",
    "RCD08": "Detected recorded crime by sex of suspected offenders",
    "RCD09": "Detected recorded crime by age of suspected offenders",
    "RCD10": "Suspected offenders by offence group and sanction type",
    "RCD11": "Fixed payment notices by type of offence",
    # Custody
    "WMI04": "Sentenced committals to prison",
    "WMI05": "Sentenced committals to prison",
    # Probation and re-offending
    "CJA12": "Probation re-offending",
    "CJA17": "Probation offenders with a re-offence within 3 years",
    "CJA23": "One-year re-offenders under 25 by offence and custodial indicator",
    "PRA03": "Fine sentences with 1- and 3-year re-offending indicators",
    "PRA16": "Fine sentences by 1-year re-offending indicator",
}


def fetch(table: str) -> dict:
    request = urllib.request.Request(
        API.format(table), headers={"User-Agent": "IrelandCrimeExplorer/1.0 (public data)"}
    )
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            last_error = error
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"{table}: {last_error}")


def ordered(cube: dict, dimension: str) -> list[str]:
    index = cube["dimension"][dimension]["category"]["index"]
    return sorted(index, key=lambda code: index[code]) if isinstance(index, dict) else list(index)


def flatten(cube: dict) -> tuple[list[str], list[list]]:
    """JSON-stat n-dimensional cube -> one row per cell, labels not codes."""
    dimensions = cube["id"]
    sizes = cube["size"]
    codes = [ordered(cube, d) for d in dimensions]
    labels = [cube["dimension"][d]["category"]["label"] for d in dimensions]
    names = [cube["dimension"][d].get("label", d) for d in dimensions]
    values = cube["value"]

    header = names + ["value"]
    rows = []
    total = 1
    for size in sizes:
        total *= size
    for flat in range(total):
        value = values[flat] if isinstance(values, list) else values.get(str(flat))
        if value is None:
            continue
        remainder = flat
        cell = []
        for axis in range(len(sizes) - 1, -1, -1):
            position = remainder % sizes[axis]
            remainder //= sizes[axis]
            cell.append(labels[axis][codes[axis][position]])
        rows.append(list(reversed(cell)) + [value])
    return header, rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "analysis" / "justice"))
    arguments = parser.parse_args()
    out = Path(arguments.out)
    out.mkdir(parents=True, exist_ok=True)

    index = []
    for table, description in TABLES.items():
        try:
            cube = fetch(table)
        except RuntimeError as error:
            print(f"  {table}: FAILED — {error}", file=sys.stderr)
            continue
        header, rows = flatten(cube)
        path = out / f"{table}.csv"
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(header)
            writer.writerows(rows)
        index.append(
            {
                "table": table,
                "label": cube.get("label", description),
                "updated": cube.get("updated"),
                "archived": cube.get("extension", {}).get("archive"),
                "dimensions": {
                    cube["dimension"][d].get("label", d): len(ordered(cube, d)) for d in cube["id"]
                },
                "rows": len(rows),
                "file": path.name,
            }
        )
        flag = " [ARCHIVED]" if index[-1]["archived"] else ""
        print(f"  {table:<7} {len(rows):>7} rows  {cube.get('label','')[:58]}{flag}")

    (out / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    print(f"\n{len(index)} tables -> {out}")


if __name__ == "__main__":
    main()
