# Roadmap

Ordered by leverage. Each item says what it unlocks and what it depends on, so
the sequence can be argued with rather than just followed.

## The finding that reorders everything

**CJQ06 — the table behind every nationwide figure on the site — was archived
by the CSO on 25 June 2026.** Its own payload says so:

```
extension.archive: true
note: "25 June 2026 - This table was archived and replaced with CJQ10.
       CJQ10 contains recorded crime data based on the updated Garda
       Divisional structure under the new Garda Operating Model which was
       fully implemented by May 2025."
```

It will never gain another quarter. A scheduled job pointed at it would run
forever and fetch nothing. So "auto-pull CSO data on release" is not a cron
job — it is a migration, and the cron is the last step of it.

The successor is **CJQ10**, verified live:

| | CJQ06 (in use) | CJQ10 (successor) |
|---|---|---|
| archived | **yes**, 25 Jun 2026 | no |
| quarters | 92 — 2003Q1…2025Q4 | 93 — 2003Q1…**2026Q1** |
| divisions | 28 (2011/2013 structure) | **21** (current operating model) |
| offence codes | 85 | 85 — identical |

CJQ10 restates the whole series back to 2003Q1 on the new structure, so this is
a source swap, not a history migration: no old figures need remapping.

**A second finding, smaller but wrong on the site today.** CJA11 is not a
Dublin table. It carries **564 Garda stations across all 21 new Divisions**,
annually 2003–2025. The app reads 41 Dublin rows from it and the README tells
readers that station-level detail is "Dublin-only — CSO does not publish it
nationally". That statement is false and should come down whether or not the
station layer is ever widened.

### What the migration costs

- The map goes from 28 areas to 21, with different names and different
  boundaries. Old Kilkenny/Carlow splits across two new Divisions, so the old
  polygons cannot be unioned into the new set cleanly.
- Every `divisionId` in `data/processed/news.json` and in the 290 labels in
  `tests/fixtures/news_labelled.json` points at an old-structure id.
- `data/geography/division_places.json` maps place names to old ids; the
  gazetteer is rebuilt by point-in-polygon against old boundaries.
- The CSO's published boundary file is the 2011 set. Whether the new structure
  has a published boundary file at all is an open question — and if it does
  not, the app's existing editorial position (symbols, never shaded territory)
  is what makes that survivable.

Nothing below is worth building on a frozen table, which is why the migration
sits first.

---

## 0. Migrate the national layer to CJQ10

Unlocks everything else, and gets 2026Q1 — a quarter the site is currently
missing.

- fetch CJQ10 alongside the existing tables *(done — raw archive only)*
- map the 21 new Divisions to map positions; decide the boundary question
- rebuild `dashboard.json` from CJQ10
- remap the news gazetteer and every labelled `divisionId` to new ids
- update the README's claims about geography and station coverage

## 1. Auto-pull on release

The cron, once it has a live table to pull. CSO publishes quarterly; the cube
carries its own `updated` timestamp, so the job can fetch, compare, and commit
only when the data actually moved — no noise commits from the `retrieved_at`
field. Model it on `.github/workflows/news.yml`: no secrets, validate before
committing, and never touch the published artifact if validation fails.

## 2. A URL for every area

`app/page.tsx` is the entire app — one route, all state client-side. Galway is
not linkable, not shareable, and not indexable. Server-render
`/division/<slug>` and `/dublin/<slug>`, with a per-area OG image generated the
way `/og.png` already is. One indexable page becomes ~60.

Depends on 0 only for the slugs to be stable.

## 3. The full series, not seven years

`dashboard.json` already carries every quarter back to 2003 — the browser
downloads them today and the UI shows seven annual points from 2019. A
sparkline per area costs no new data and changes what the app is: from two
numbers and a difference, to the shape of it.

With 90+ quarters it also becomes possible to say whether a quarter sits
outside an area's own normal range, rather than only up or down on a baseline.

## 4. The quarterly release moment

Auto-generate a "what changed this quarter" page from the diff a release
produces — biggest movers, offences that broke pattern, directions that
reversed — and let people subscribe per area by RSS. Four content events a
year that do not depend on anyone remembering the site exists.

Depends on 1.

## 5. Compare two areas

The most common question about any place is "compared to where I used to
live". Two areas, one chart.

## 6. An embeddable widget

One area, one chart, an iframe a local paper can drop into an article. This is
distribution: it is how the app gets cited rather than hoping.

## 7. Seasonality

Twenty-plus years of quarterly data shows real annual patterns. Nobody
publishes that for Irish recorded crime in a readable form.

## 8. Per-capita rates — carefully

Cork City against Cork County by raw count is close to meaningless. There is
no population field in the data, and Division boundaries are administrative
units that Census geography does not align to. Worth doing, worth disclosing
on the page, and worth doing last.

---

## Not building

No safety score, no "is my area safe", no prediction, no shaded danger map.
The app is trustworthy because it states what it does not know; that is also
the only thing it has that a tabloid crime tracker does not.
