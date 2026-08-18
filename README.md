# Dublin Crime Explorer

An interactive atlas of official recorded-crime incidents across Dublin Garda
station/sub-district geographies. The product is intentionally neutral: it
shows counts, category mix, trend and relative position without inventing a
neighbourhood “safety score”.

## What is implemented

- CSO CJA11 annual data for all 41 Dublin Metropolitan Region station rows
- 2019–2025 trends, offence filters and transparent derived groupings
- raw count, area share, change-since-2019 and Dublin-percentile map views
- authoritative Dublin City Council station points (not fabricated catchments)
- recognisable-place search with confidence and ambiguity notes
- station detail, contextual distortion flags, comparison and rankings
- reproducible Python fetch, clean and validation scripts

## Refresh the official data

```bash
python3 scripts/fetch_cso_data.py
python3 scripts/clean_crime_data.py
python3 scripts/validate_data.py
```

The fetch script stores source files unchanged. The cleaning script creates:

- `data/processed/dublin_crime_canonical.csv` — long-form official records
- `data/processed/dashboard.json` — compact application data
- `public/data/dashboard.json` — public application-data artifact

Curated context remains separate in `data/geography/station_metadata.csv` and
`data/geography/place_lookup.csv`.

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
- Station/sub-district names are not suburb boundaries.
- The current Garda operating model is division-based; a current district layer
  is not used.
- Current public station-catchment polygons were not found. The official Garda
  polygons available from CSO describe the 2011/2013 structure, so the map uses
  station points instead.
- CJA11 station detail excludes homicide and sexual-offence groups.
- Fraud is non-comparable in 2023 and unavailable at station level from 2024.
- CJA11 does not split broad theft into vehicle theft, shop theft and other theft
  at station level.
- Closed-station incidents are reassigned to the station geography that assumed
  responsibility, and COVID restrictions affect 2020–2022 comparisons.
