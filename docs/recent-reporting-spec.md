# Recent reporting — design spec

Status: **built** (branch `feat/recent-reporting`). Supersedes the
`news_mapper` / `news_service` draft.

See "Build notes" at the foot for what changed once it met real data.

## What this is

A section beneath the area readout that shows recent news coverage relating to the
selected Garda Division, so a reader who sees "Clare +16.1%" has somewhere to ask
why.

The statistics answer *how much recorded crime, where, and which way is it moving*.
Reporting answers *what happened to one person, once*. The second is the only one of
those the dataset cannot do, and it is the entire justification for the feature.

## What this is not

The product's central editorial constraint is that recorded incidents are not
prevalence, and a station name is not a suburb boundary. Headlines break both
constraints if handled carelessly: three assault stories under one area name make
that area look dangerous regardless of what its counts say.

News volume tracks newsworthiness and newsroom geography, not crime. Dublin is
covered far more heavily than Leitrim at identical rates. Every design decision below
exists to stop that bias reading as data.

Concretely, the feature must never:

- show a count of articles, or let article volume stand in for crime volume
- rank or compare areas by how much coverage they have
- load or display before the statistics it sits beneath
- attach an article to a place the article does not itself name
- widen a search silently, so that articles appear under a heading they do not belong to

## Geography

**Division level only.** Articles attach to a Garda Division, which is an official
CSO boundary. They are never attached to Dublin station areas, because those are
Voronoi cells derived from station points — the exact geography the app already
tells readers is not a boundary. Pinning "stabbing in Dundrum" to one would assert
precisely what the existing caveat denies.

Locality comes from the article, not from us. Where an article names a town, that
town is displayed, because the article said it. Where it does not, the article still
belongs to its division and is shown there. Nothing is inferred.

The reader can narrow a division's articles by county (derivable from division names
for the 22 non-DMR divisions) or by town, where that data exists. Filtering is
progressive: all of a division's articles by default, narrowed only on request.
Articles with no specific location remain visible in a labelled grouping rather than
being hidden or assigned a guess.

## Sources

A curated allowlist of Irish publisher RSS feeds — roughly 25, national and regional.

National outlets alone (RTÉ, Irish Times, Independent, Journal.ie) skew to Dublin and
to what is nationally notable, which is the coverage bias described above. Regional
titles supply the local texture the feature exists for, but cover the country
unevenly.

**The feed list is shown in the UI.** If a reader can see which outlets were searched,
an absence of Leitrim stories reads as "no title in our list covered it" rather than
"Leitrim is quiet". This converts a hidden bias into a stated limitation, consistent
with how the fraud and boundary caveats already work.

Publisher RSS is used rather than a news API: NewsAPI's free tier prohibits production
use, Google News RSS has no terms permitting programmatic use and returns
publisher-hostile redirect URLs, and paid aggregators reintroduce the recurring-cost
failure that removed Ask Crime Bot.

## Display

Per article: headline, outlet, publication date, RSS description verbatim, and a link
to the publisher. No images — hotlinking serves publisher images on our traffic, and
self-hosting copies their copyrighted work onto our domain, which is worse. Every
article is a click through to the source, which is the arrangement RSS exists for.

Syndicated stories (PA copy, press releases) are clustered by title similarity. The
earliest-published entry is canonical and the cluster is shown as a single item noting
"also covered by N outlets". This solves duplication and, importantly, makes coverage
volume visible as coverage rather than letting it silently inflate the list.

Section heading: **"Recent reporting"**, with a subhead naming the window and
disclaiming the link to the charted period:

> Reporting from the last 12 months. Not a record of the incidents counted above.

"News" would frame the articles as the subject. "Recent reporting" frames them as
coverage *of* the subject, which is the distinction the whole feature's safety margin
rests on.

Placement: a section below the area readout, collapsed by default, labelled as
reporting rather than data. A reader must have passed the statistics to reach it. It
inherits the selected division and offence group as filters.

### Empty results

When the current selection has no matching articles, say so plainly. Do not widen the
search silently.

A clearly separated, explicitly labelled second block may offer other reporting from
the same division. Given the outlet bias, an empty state will often be the truthful
answer and should be treated as a normal outcome rather than a failure.

## Architecture

The pipeline mirrors the existing crime data flow (`fetch_cso_data.py` →
`clean_crime_data.py` → `validate_data.py` → `data/processed/dashboard.json`), because
that is one mental model rather than two.

```
scripts/fetch_news.py       pull the RSS allowlist
scripts/classify_news.py    prefilter, then classify survivors
scripts/validate_news.py    assert quality against a labelled fixture
                            ↓
data/processed/news.json    committed artifact
```

A GitHub Action runs the pipeline **daily**, commits the artifact, and the commit
triggers a Vercel deploy. Nothing in the feature is time-critical: the crime data
updates quarterly, and a day-old article inside a 12-month window is
indistinguishable from a fresh one.

No database. `db/index.ts` requires a Cloudflare D1 binding via `cloudflare:workers`;
`.openai/hosting.json` has `"d1": null`, and deployment is Vercel, where that import
does not exist. The committed artifact avoids needing one.

### Read seam

Components must **not** import `news.json` directly, the way `page.tsx` currently
imports `dashboard.json`. All reads go through a single function:

```ts
getNews(filters): NewsCluster[]
```

Today it opens the committed file. Later it queries a store. The JSON shape is the
contract, and the swap is a one-file change. This is the whole abstraction — a
repository interface with pluggable backends would be architecture for a problem that
does not exist yet.

### Archive growth

Articles accumulate indefinitely; nothing is pruned. At roughly 50 articles a day the
artifact reaches ~18k entries a year, which is comfortable as JSON for two to three
years.

**Outgrowing the file is the migration trigger** — the concrete signal to move behind
the seam above, rather than a threshold guessed at now. Pruning early would discard
the archive value that motivated accumulating in the first place.

## Matching

### Gazetteer

Town candidates are derived from data, then trimmed by hand.

Source: the CSO settlement list, falling back to OpenStreetMap (`place=town|village`
nodes within each division polygon, ODbL, attribution required) for coverage gaps. CSO
is preferred because it is the same statistical universe as CJQ06, so towns are
defined consistently with the crime data, and no new attribution obligation arises.

Derived candidates are sorted by population, the top handful per division kept, and
the result reviewed once. Deriving alone yields every townland and hamlet, which is
noise; hand-authoring 250 names from scratch is 250 unchecked judgement calls.

Note that county-name matching alone fails for the six DMR divisions, which have no
county and where "Dublin" matches everything.

### Two-stage classification

1. **Deterministic prefilter.** Does the text contain a gazetteer place *and* a crime
   term? This discards sport, politics and business for free, so the model only sees
   plausible candidates. Bounds cost and blast radius.

2. **LLM classification** of survivors, returning:

   ```json
   { "division": "...", "town": "... | null", "group": "03", "confidence": 0.0, "reasoning": "..." }
   ```

   Model: `claude-haiku-4-5-20251001`. The provider is isolated behind one function.
   At tens of articles a day this costs cents per month. The `reasoning` field costs
   little and makes bad matches diagnosable.

Low-confidence articles go to an **unclassified** bucket. They are never forced into a
division. An unplaced article is fine; a wrongly-placed one is a false statement about
a real place.

The API key lives as a GitHub Actions secret. It never reaches Vercel or the browser.

### Offence granularity

Articles are classified to the **17 CJQ06 groups only**, never the 84 sub-categories.

Reporting can support group level — "stabbing" is confidently group 03. It cannot
support sub-codes, which turn on charges that reporting rarely states: murder-attempt
(0311) versus assault causing harm (034) is a legal distinction, not a journalistic
one. Classifying some articles precisely and others not, with no visible reason, would
be subtly dishonest. When a reader is viewing a sub-category, the section is labelled
by its parent group.

## Validation

`validate_news.py` asserts classification quality against a hand-labelled fixture of
~100 articles, and **fails the build** below threshold. Without it, prompt and model
changes ship blind.

The bar is set on **precision over recall**. A missed article costs nothing. A Cork
story filed under Kerry is a false statement about a real place.

The proportion of articles landing in `unclassified` is tracked as a health signal —
a sudden rise means the prefilter, the gazetteer or the model has drifted.

## Data shape

```jsonc
{
  "meta": {
    "generatedAt": "2026-08-30T00:00:00Z",
    "windowMonths": 12,
    "feeds": [{ "name": "RTÉ News", "url": "..." }]
  },
  "clusters": [
    {
      "id": "…",
      "title": "…",
      "description": "…",          // RSS description, verbatim
      "url": "…",                  // canonical: earliest published
      "source": "Irish Examiner",
      "publishedAt": "2026-08-29T…",
      "alsoCoveredBy": ["…"],      // other outlets in the cluster
      "divisionId": "…",           // null when unclassified
      "town": "Tuam",              // null when the article names none
      "group": "03",               // CJQ06 group, null when unclassified
      "confidence": 0.0
    }
  ]
}
```

## Roadmap

Deliberately out of scope for v1:

- **User-submitted articles.** Readers propose a link; it enters a moderation queue
  before appearing. Needs a submission path, moderation, and abuse handling — all of
  which want the database that v1 avoids.
- **Storage migration.** Move `getNews` behind a real store when the artifact
  outgrows a committed file.
- **Coverage-gap reporting.** Surface which divisions have persistently thin coverage,
  as an editorial signal for extending the feed list.

## Decision log

| # | Decision |
|---|---|
| 1 | Purpose is explanation — insight below the division that the statistics cannot give |
| 2 | Constrained display, division-level only; never an article count or a coverage ranking |
| 3 | Curated publisher RSS allowlist, not a news API |
| 4 | Gazetteer derived from boundaries, then hand-trimmed |
| 5 | Article attaches to a division; the town displayed is the one the article names |
| 6 | Classification is offline and batched, never at request time |
| 7 | Committed artifact refreshed by CI; no database |
| 8 | Nationals plus regionals, ~25 feeds, feed list shown in the UI |
| 9 | One `getNews` read function as the swap seam; no direct imports |
| 10 | All division articles by default; progressive filters; unlocated articles stay visible |
| 11 | Section below the readout, collapsed, subordinate to the numbers |
| 12 | Archive accumulates indefinitely; 12-month default view |
| 13 | Two-stage matching: deterministic prefilter, then LLM with confidence |
| 14 | 17 offence groups only, never the 84 sub-categories |
| 15 | Headline, outlet, date, RSS description, link. No images |
| 16 | Cluster syndicated duplicates; earliest canonical; "also covered by N" |
| 17 | Empty results say so; widening is separate and labelled, never silent |
| 18 | `claude-haiku-4-5-20251001`, key in CI secrets only |
| 19 | Hand-labelled fixture asserted in CI; precision over recall |
| 20 | CSO settlements, OSM fallback |
| 21 | "Recent reporting", not "News" |
| 22 | Daily refresh |
| 23 | Never prune; file size is the migration trigger |


## Build notes

What the build changed or discovered, against the agreed design above.

### Feed list: 19, not ~25

Of 32 candidate feeds, 13 were dead or not RSS. Five replacements were found by
probing alternatives. The survivors are 4 national and 15 regional.

**Cork, Kerry, Meath, Kildare, Wexford, Carlow, Westmeath and Louth have no
working regional feed.** Their articles arrive only through national outlets,
so coverage there is measurably thinner. This is recorded in
`news_feeds.json` under `meta.coverageGap` and is exactly the bias the visible
feed list exists to expose.

### Gazetteer

1,402 places across 28 Divisions, no Division empty. OSM settlements placed by
point-in-polygon against the Division boundaries the map already draws, with
Dublin taken from the app's own reviewed place list.

Two corrections were needed once it met real articles:

- **Village names that are ordinary English words.** `Hospital` (Co Limerick),
  `Street` (Co Westmeath), `Recess` (Co Galway), `Grange`, `Newmarket` and
  `Cloghan` matched prose rather than places — "taken to hospital" made every
  medical story a candidate. Found by counting how many articles each
  gazetteer name matched across a real fetch, not by guesswork.
- **County names.** `Cork City`, `Cork North` and `Cork West` are Division
  regions; a headline says "Cork". Now normalised to 25 real counties.

### Northern Ireland

Not in the agreed design, and a genuine correctness gap. CJQ06 counts the
Republic only, so a Tyrone or Belfast story has no Division it could belong to
however clearly it reports a crime. Several were passing the prefilter. Now
excluded explicitly.

### Clustering

Title *sequence* similarity failed on real syndication: five outlets carried
one Sligo van death and none merged, because rewritten headlines share meaning
rather than character sequences. Replaced with token-set overlap (Jaccard ≥
0.25) plus a 3-day window.

A second bug: joining only the *first* matching group left stories split when
an article bridged two groups that did not match each other directly. Clusters
now merge transitively.

### Prefilter yield

413 articles fetched, 22 candidates, 18 clusters. About half the candidates are
genuine crime reporting; the rest — a Leaving Cert editorial, a mayoral debate —
are what the LLM stage exists to reject. The prefilter is deliberately broad:
its job is discarding the obviously irrelevant, not being right.

### Not yet run

**Classification has never executed.** No `ANTHROPIC_API_KEY` was available, so
every article currently sits unclassified and the UI shows its empty state. The
first CI run with the secret set will be the first real test of prompt quality.

The 100-article labelled fixture in the agreed design is **not** built. What
exists is `tests/fixtures/news_prefilter_cases.json` — 14 cases covering the
prefilter, every rejection case being a bug that actually occurred. That guards
stage 1 only. Stage 2 has no accuracy test until classifications exist to
label, and until then precision is unmeasured.
