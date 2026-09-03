<img src="public/logo-full.png" alt="" width="180" align="left">

# Ireland Crime Explorer

A map-first explorer of official recorded-crime incidents. Two geographies —
28 national Garda Divisions, and the 41 Dublin Metropolitan Region station
areas — compared between any two years, with one offence control that doubles
as the offence breakdown.

The product is deliberately neutral. It shows counts, mix, trend and relative
position, and it does not invent a neighbourhood "safety score".

Areas are drawn as proportional symbols rather than shaded territory. Garda
station catchments are not published at all, and the Division polygons in
circulation describe the 2011/2013 structure, so shading either would assert a
boundary the source cannot support. A symbol locates an area without claiming
where it ends.

## What is implemented

- CSO CJA11 annual data for all 41 Dublin Metropolitan Region station rows
- CSO CJQ06 quarterly data for all 28 national Garda Divisions — 16 offence
  groups and their 69 official sub-categories, 85 codes in all — back to 2003
- any-year-to-any-year comparison; areas with fewer than ten incidents in the
  baseline year are left blank rather than shown as a large swing
- one offence control that filters the map and doubles as the breakdown,
  drilling into the official sub-categories
- proportional-symbol map on real Natural Earth coastline, with a zoomable
  Dublin station view and a merged Dublin symbol that opens the six DMR
  Divisions
- authoritative Dublin City Council station points (not fabricated catchments)
- contextual distortion flags, rankings, and a quiet disclosure view
- light and dark themes, following the system preference until told otherwise
- recent reporting from a curated allowlist of Irish publisher RSS feeds,
  pinned to Divisions
- reproducible Python fetch, clean and validation scripts

## Refresh the official data

```bash
pip3 install -r scripts/requirements.txt
python3 scripts/fetch_cso_data.py
python3 scripts/clean_crime_data.py
python3 scripts/validate_data.py
```

The fetch script stores source files unchanged. The cleaning script creates:

- `data/processed/dublin_crime_canonical.csv` — long-form official CJA11 records
- `data/processed/dashboard.json` — compact application data (station and
  division level)
- `public/data/dashboard.json` — public application-data artifact
- `data/geography/garda_divisions.geojson` — reprojected national Division
  boundary reference (also embedded per-division in dashboard.json)

Curated context remains separate in `data/geography/station_metadata.csv` and
`data/geography/place_lookup.csv`.

## Recent reporting

News coverage of a selected Division, from a curated allowlist of Irish
publisher RSS feeds. It is coverage *of* crime, never a record of it:
newsrooms cluster in cities and cover what is notable, so the section never
shows an article count and never ranks areas by how much press they attract.

Fetching is automatic and needs no secrets — a scheduled GitHub Action adds to
the archive daily, which matters because most feeds expose only 30–90 days.
Classification is done by hand in batches, because at roughly twenty
candidates a day a person reading them is more accurate than a small model and
costs nothing.

```bash
python3 scripts/fetch_news.py                    # usually CI's job
python3 scripts/classify_news.py --pending       # the review queue
# add entries to tests/fixtures/news_labelled.json
python3 scripts/classify_news.py --from-labels
python3 scripts/validate_news.py
```

An unlabelled article is fetched but invisible: the site shows only what has
been placed. `validate_news.py` guards the prefilter against a fixture of real
articles and, when a model run produced the artifact, scores it against the
hand labels — failing below 90% precision on Division. The bar is precision,
not recall: a missed article costs nothing, an article filed under the wrong
county is a false statement about a real place.

The design and its decision log are in
[`docs/recent-reporting-spec.md`](docs/recent-reporting-spec.md).

An API path remains in `classify_news.py` for when volume outgrows hand
labelling; the labelled fixture is what would prove a model accurate enough to
hand over to.

## Run the site

```bash
npm install
npm run dev
```

For production validation:

```bash
npm run build
npm test
```

Node.js 22.13 or later is required.

## Primary sources

- [CSO CJA11 JSON-stat API](https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/CJA11/JSON-stat/2.0/en)
- [CSO Recorded Crime background notes](https://www.cso.ie/en/releasesandpublications/ep/p-rc/recordedcrimeq12026/backgroundnotes/)
- [Dublin Garda station points](https://data.gov.ie/dataset/87ce5c48-d0de-4968-b596-4002d156105d/resource/54c2e63b-8c9e-4b49-bf49-7d3a1ba499d4)
- [Garda organisational structure](https://www.garda.ie/en/about-us/organisational-structure/organisation.html)

## Important limitations

- This is recorded crime, not the total prevalence of crime.
- News coverage is not crime. An absence of reporting for an area means no
  outlet in the feed list covered it, which is not the same as nothing having
  happened.
- Station/sub-district names are not suburb boundaries.
- The current Garda operating model is division-based; a current district layer
  is not used.
- Current public station-catchment polygons were not found, and the official
  Garda polygons available from CSO describe the 2011/2013 structure. The map
  therefore locates every area as a symbol and shades no territory at all.
- CJA11 station detail excludes homicide and sexual-offence groups — that
  data isn't missing from the app, it's only available in Division view
  (CJQ06 code `01`/`02`, including Murder/Manslaughter/Infanticide detail).
  CSO's separate CJA08 murder-analysis table was evaluated and skipped: it's
  national-only, annual, with no area breakdown — strictly less detailed
  than what CJQ06 already provides here, aside from a population-rate figure
  we don't otherwise have.
- Fraud is non-comparable in 2023 and unavailable at station level from 2024.
- CJA11 does not split broad theft into vehicle theft, shop theft and other theft
  at station level.
- Closed-station incidents are reassigned to the station geography that assumed
  responsibility, and COVID restrictions affect 2020–2022 comparisons.
- CJQ06 (Division level) fraud/deception counts stop from 2023Q3 for the same
  financial-institution reporting-backlog reason as the CJA11 fraud gap.
- Division geography (28 national areas, 6 of them covering Dublin) is much
  coarser than station geography (41 Dublin areas); it trades area detail for
  real boundaries, the full 85-category offence breakdown and a quarterly
  cadence. Station-level detail (CJA11) is Dublin-only — CSO does not publish
  it nationally.
