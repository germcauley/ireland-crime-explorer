#!/usr/bin/env python3
"""Validate transformation integrity and print analytical regression checks."""

from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CANONICAL = ROOT / "data" / "processed" / "dublin_crime_canonical.csv"
DASHBOARD = ROOT / "data" / "processed" / "dashboard.json"


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    raise SystemExit(1)


def main() -> None:
    with CANONICAL.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    dashboard = json.loads(DASHBOARD.read_text(encoding="utf-8"))

    expected_rows = 23 * 41 * 14
    if len(rows) != expected_rows:
        fail(f"expected {expected_rows:,} canonical rows, found {len(rows):,}")
    if len(dashboard["stations"]) != 41:
        fail("dashboard must contain all 41 CJA11 DMR stations")

    keys = set()
    for row in rows:
        key = (row["year"], row["station_code"], row["offence_code"])
        if key in keys:
            fail(f"duplicate canonical key {key}")
        keys.add(key)

    station_by_id = {station["id"]: station for station in dashboard["stations"]}
    for station in dashboard["stations"]:
        if not (-6.6 <= station["lng"] <= -6.0 and 53.1 <= station["lat"] <= 53.7):
            fail(f"implausible Dublin coordinate for {station['name']}")
        for series in station["series"].values():
            if len(series) != len(dashboard["meta"]["years"]):
                fail(f"series length mismatch for {station['name']}")

    years = dashboard["meta"]["years"]
    y2025 = years.index(2025)
    y2019 = years.index(2019)

    def value(station_code: str, category: str, year_index: int) -> int:
        result = station_by_id[station_code]["series"][category][year_index]
        assert result is not None
        return result

    # Regression tests from the original exploratory hypotheses, now derived
    # directly from CJA11. These should fail loudly if the official cube changes.
    dundrum_total = value("65102", "all", y2025)
    dundrum_theft = value("65102", "08", y2025)
    dundrum_share = dundrum_theft / dundrum_total
    if not (0.47 <= dundrum_share <= 0.49):
        fail(f"Dundrum theft share shifted unexpectedly: {dundrum_share:.1%}")

    trend_checks = {}
    for code in ["63201", "66103", "64202"]:
        before = value(code, "all", y2019)
        after = value(code, "all", y2025)
        trend_checks[station_by_id[code]["name"]] = (after - before) / before

    # Validate 2025 DMR totals by category against a second aggregation of the
    # canonical long-form file.
    canonical_totals: dict[str, int] = defaultdict(int)
    for row in rows:
        if row["year"] == "2025" and row["incident_count"]:
            canonical_totals[row["offence_code"]] += int(row["incident_count"])
    dashboard_totals = {
        category: sum(
            station["series"][category][y2025] or 0
            for station in dashboard["stations"]
        )
        for category in canonical_totals
    }
    if dict(canonical_totals) != dashboard_totals:
        fail("dashboard totals differ from canonical 2025 totals")

    print("PASS: canonical key uniqueness and 41-station coverage")
    print("PASS: all station points fall within a broad Dublin extent")
    print("PASS: dashboard aggregates reproduce canonical 2025 DMR totals")
    print(
        f"CHECK: Dundrum 2025 theft share = {dundrum_share:.1%} "
        f"({dundrum_theft:,} of {dundrum_total:,})"
    )
    for station, change in trend_checks.items():
        print(f"CHECK: {station} all-published-category change 2019–2025 = {change:+.1%}")
    print("NOTE: fraud is non-comparable in 2023 and absent at station level from 2024")
    print("NOTE: CJA11 station detail excludes homicide and sexual-offence groups")


if __name__ == "__main__":
    main()
