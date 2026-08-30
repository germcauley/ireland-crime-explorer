"""Place fetched articles in a Garda Division and a CJQ06 offence group.

Two stages, per the design in docs/recent-reporting-spec.md.

1. A deterministic prefilter. An article is a candidate only if it mentions a
   gazetteer place (or county) *and* a crime term. This discards sport,
   politics and business for free, so the model only ever sees plausible
   input — which bounds both cost and the blast radius of a bad prompt.

2. An LLM adjudicates the survivors. The prefilter cannot resolve "Cork"
   (a city, a county and three Divisions), cannot tell a sentencing report
   from an incident, and cannot tell an assault from a robbery that involved
   one. That is what the model is for.

The prefilter proposes; it never decides alone. Where the model is
unavailable or unsure, the article lands in the unclassified bucket rather
than being forced into a Division. An unplaced article costs nothing; one
placed in the wrong county is a false statement about a real place.

Set ANTHROPIC_API_KEY to run stage 2. Without it the script still runs and
writes its output, marking every candidate unclassified — useful for
iterating on the prefilter, not for publishing.

Output: data/processed/news.json, committed.

    python3 scripts/classify_news.py [--limit N] [--no-llm]
"""

from __future__ import annotations

import argparse
import datetime as dt
import difflib
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "processed" / "news_raw.json"
GAZETTEER = ROOT / "data" / "geography" / "division_places.json"
DASHBOARD = ROOT / "data" / "processed" / "dashboard.json"
OUT = ROOT / "data" / "processed" / "news.json"
LABELS = ROOT / "tests" / "fixtures" / "news_labelled.json"

MODEL = "claude-haiku-4-5-20251001"
API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"

# Terms that suggest an article concerns a recorded crime. Deliberately broad:
# the prefilter's job is to discard the obviously irrelevant, not to be right.
CRIME_TERMS = {
    "garda", "gardai", "gardaí", "murder", "manslaughter", "homicide", "assault",
    "attack", "stabbing", "stabbed", "shooting", "shot", "robbery", "robbed",
    "burglary", "burgled", "theft", "stolen", "steal", "fraud", "scam",
    "drugs", "cocaine", "cannabis", "heroin", "seizure", "seized", "weapon",
    "firearm", "knife", "arrested", "arrest", "charged", "court", "sentenced",
    "convicted", "trial", "criminal", "crime", "raid", "arson", "kidnap",
    "harassment", "assaulted", "manslaughter", "dangerous driving", "collision",
    "public order", "criminal damage", "vandalism", "threats",
}

# Sport dominates local papers and is full of words like "attack" and "shot".
EXCLUDE_TERMS = {
    "gaa", "hurling", "camogie", "football final", "championship", "league match",
    "transfer window", "kick-off", "half-time", "penalty shootout",
}

# CJQ06 counts the Republic only. Northern Ireland is policed by the PSNI and
# appears nowhere in the statistics, so an article about Tyrone or Belfast has
# no Division to belong to no matter how clearly it reports a crime.
NORTHERN_IRELAND_TERMS = {
    "psni", "northern ireland", "co tyrone", "co. tyrone", "tyrone",
    "belfast", "derry", "londonderry", "co antrim", "co. antrim", "antrim",
    "armagh", "fermanagh", "co down", "co. down", "enniskillen", "omagh",
    "dungannon", "lisburn", "craigavon", "ballymena", "newry", "coleraine",
    "stormont",
}

MIN_CONFIDENCE = 0.6

PROMPT = """You classify Irish news articles against official crime statistics geography.

Return ONLY a JSON object, no prose or fences:
{{"division": <id or null>, "town": <string or null>, "group": <code or null>, "confidence": <0.0-1.0>, "reasoning": "<one short sentence>"}}

Garda Divisions (id — name — counties covered):
{divisions}

CJQ06 offence groups (code — label):
{groups}

Rules:
- "division" is the Garda Division the incident occurred in. Use null if the article names no Irish location, is about national policy, or you cannot tell.
- "town" is a town or area the ARTICLE ITSELF names. Never infer one. Null if none is named.
- "group" is the offence group. Null if the article is not about a specific recorded offence.
- "confidence" reflects how certain you are of the division. Be strict: below 0.6 the article is discarded rather than shown.
- Dublin: the DMR Divisions split the city. Only pick one if the article names a specific Dublin area you can place; otherwise null.
- An article about a court case belongs to the division where the OFFENCE happened, not where the court sits, when the article makes that clear.

Article:
Source: {source}
Headline: {title}
Description: {description}"""


def load_json(path: pathlib.Path):
    if not path.exists():
        print(f"error: {path} missing", file=sys.stderr)
        raise SystemExit(1)
    return json.loads(path.read_text())


def build_place_index(gazetteer):
    """name (lowercased) -> list of division ids that contain a place of that name."""
    index: dict[str, set[str]] = {}
    for division in gazetteer["divisions"]:
        for place in division["places"]:
            index.setdefault(place["name"].lower(), set()).add(division["id"])
        for county in division["counties"]:
            index.setdefault(county.lower(), set()).add(division["id"])
    return index


def prefilter(article, place_index) -> tuple[bool, list[str], list[str]]:
    """Return (is_candidate, matched place names, matched division ids)."""
    text = f"{article['title']} {article['description']}".lower()

    if any(term in text for term in EXCLUDE_TERMS):
        return False, [], []
    if any(term in text for term in NORTHERN_IRELAND_TERMS):
        return False, [], []
    if not any(term in text for term in CRIME_TERMS):
        return False, [], []

    hits: list[str] = []
    divisions: set[str] = set()
    for name, division_ids in place_index.items():
        # Word-boundary match: "Naas" must not fire inside "Naason".
        if re.search(rf"\b{re.escape(name)}\b", text):
            hits.append(name)
            divisions.update(division_ids)

    return bool(hits), sorted(hits), sorted(divisions)


def call_model(article, divisions_text, groups_text, api_key):
    prompt = PROMPT.format(
        divisions=divisions_text,
        groups=groups_text,
        source=article["source"],
        title=article["title"],
        description=article["description"][:400],
    )
    body = json.dumps(
        {
            "model": MODEL,
            "max_tokens": 300,
            "temperature": 0,
            "messages": [{"role": "user", "content": prompt}],
        }
    ).encode()
    request = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": API_VERSION,
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode())
    text = "".join(block.get("text", "") for block in payload.get("content", []))
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("model returned no JSON object")
    return json.loads(text[start : end + 1])


# Words too common in headlines to be evidence that two reports concern the
# same incident.
CLUSTER_STOPWORDS = {
    "the", "a", "an", "of", "in", "on", "at", "to", "after", "as", "for", "and",
    "with", "from", "is", "was", "says", "said", "his", "her", "their", "who",
    "that", "by", "up", "over", "into", "out", "not", "new", "man", "woman",
    "two", "year", "old", "years", "following", "amid", "but", "has", "have",
}
CLUSTER_THRESHOLD = 0.25
CLUSTER_WINDOW_DAYS = 3


def title_tokens(title: str) -> set[str]:
    words = re.findall(r"[a-z0-9\u20ac]+", title.lower())
    return {w for w in words if w not in CLUSTER_STOPWORDS and len(w) > 2}


def same_story(a, b) -> bool:
    """Token overlap, not string similarity.

    Two outlets reporting one incident rewrite the headline entirely — "Pedestrian
    (40s) dies after being struck by his own van in Sligo" and "Man killed after
    being struck by his van in Sligo road crash" share almost no character
    sequence but most of their meaningful words.
    """
    tokens_a, tokens_b = a["_tokens"], b["_tokens"]
    if not tokens_a or not tokens_b:
        return False
    overlap = len(tokens_a & tokens_b) / len(tokens_a | tokens_b)
    if overlap < CLUSTER_THRESHOLD:
        return False
    # Vocabulary alone is not enough: two unconnected assaults months apart can
    # read alike. One incident is reported within days.
    if a["publishedAt"] and b["publishedAt"]:
        try:
            delta = abs(
                dt.datetime.fromisoformat(a["publishedAt"])
                - dt.datetime.fromisoformat(b["publishedAt"])
            )
        except ValueError:
            return True
        return delta.days <= CLUSTER_WINDOW_DAYS
    return True


def cluster(articles):
    """Group syndicated retellings of one story; keep the earliest as canonical.

    Clustering is transitive: A matching B and B matching C puts all three
    together even where A and C do not match directly, which is what happens
    when three outlets each reword the same wire copy.
    """
    ordered = sorted(articles, key=lambda a: a["publishedAt"] or a["fetchedAt"] or "")
    for article in ordered:
        article["_tokens"] = title_tokens(article["title"])

    clusters: list[list[dict]] = []
    for article in ordered:
        # Join *every* group this article matches, not merely the first. An
        # article often bridges two groups that do not match each other
        # directly — five outlets rewording one wire story produce exactly that
        # shape, and stopping at the first match leaves the story split.
        matched = [g for g in clusters if any(same_story(article, m) for m in g)]
        if not matched:
            clusters.append([article])
            continue
        merged = [article]
        for group in matched:
            merged.extend(group)
            clusters.remove(group)
        merged.sort(key=lambda a: a["publishedAt"] or a["fetchedAt"] or "")
        clusters.append(merged)

    result = []
    for group in clusters:
        canonical = dict(group[0])
        others = []
        for member in group[1:]:
            if member["source"] != canonical["source"] and member["source"] not in others:
                others.append(member["source"])
        canonical["alsoCoveredBy"] = others
        canonical.pop("_tokens", None)
        result.append(canonical)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="classify at most N candidates")
    parser.add_argument("--no-llm", action="store_true", help="prefilter only")
    parser.add_argument(
        "--from-labels",
        action="store_true",
        help="apply the hand-reviewed labels instead of calling the model",
    )
    args = parser.parse_args()

    raw = load_json(RAW)
    gazetteer = load_json(GAZETTEER)
    dashboard = load_json(DASHBOARD)

    place_index = build_place_index(gazetteer)
    divisions_text = "\n".join(
        f"{d['id']} — {d['name']} — {', '.join(d['counties']) or 'Dublin city'}"
        for d in gazetteer["divisions"]
    )
    groups_text = "\n".join(
        f"{g['id']} — {g['label']}" for g in dashboard["divisionCategories"]
    )

    articles = raw["articles"]
    candidates = []
    for article in articles:
        is_candidate, hits, division_hits = prefilter(article, place_index)
        if is_candidate:
            article = dict(article)
            article["_placeHits"] = hits
            article["_divisionHits"] = division_hits
            candidates.append(article)

    print(f"{len(articles)} articles, {len(candidates)} passed the prefilter")

    # Hand-reviewed labels are the same shape as a model verdict, so they flow
    # through the identical validation below. They cover one fetch only — new
    # articles fall through unclassified rather than being guessed at.
    labels = {}
    if args.from_labels:
        if not LABELS.exists():
            print(f"error: {LABELS} missing", file=sys.stderr)
            raise SystemExit(1)
        labels = {entry["id"]: entry for entry in json.loads(LABELS.read_text())["labels"]}
        print(f"applying {len(labels)} hand-reviewed labels")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    use_llm = bool(api_key) and not args.no_llm and not args.from_labels
    if not use_llm and not args.from_labels:
        print("no ANTHROPIC_API_KEY (or --no-llm): every candidate stays unclassified")

    classified, unclassified, errors = [], 0, 0
    to_process = candidates[: args.limit] if args.limit else candidates

    for index, article in enumerate(to_process, 1):
        verdict = labels.get(article["id"])
        if use_llm:
            try:
                verdict = call_model(article, divisions_text, groups_text, api_key)
            except (urllib.error.URLError, ValueError, json.JSONDecodeError, TimeoutError) as error:
                errors += 1
                print(f"  ! {article['id']}: {str(error)[:60]}", file=sys.stderr)
            if index % 25 == 0:
                print(f"  classified {index}/{len(to_process)}")

        entry = {
            "id": article["id"],
            "title": article["title"],
            "description": article["description"],
            "url": article["url"],
            "source": article["source"],
            "publishedAt": article["publishedAt"],
            "alsoCoveredBy": [],
            "divisionId": None,
            "town": None,
            "group": None,
            "confidence": 0.0,
            "reasoning": None,
        }

        if verdict:
            confidence = float(verdict.get("confidence") or 0)
            division = verdict.get("division")
            valid = division in {d["id"] for d in gazetteer["divisions"]}
            if valid and confidence >= MIN_CONFIDENCE:
                entry.update(
                    divisionId=division,
                    town=verdict.get("town"),
                    group=verdict.get("group"),
                    confidence=round(confidence, 2),
                    reasoning=verdict.get("reasoning"),
                )
            else:
                entry["confidence"] = round(confidence, 2)
                entry["reasoning"] = verdict.get("reasoning")

        if entry["divisionId"]:
            classified.append(entry)
        else:
            unclassified += 1
            classified.append(entry)

    clustered = cluster(classified)

    OUT.write_text(
        json.dumps(
            {
                "meta": {
                    "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "windowMonths": 12,
                    "model": MODEL if use_llm else ("hand-reviewed" if args.from_labels else None),
                    "articlesConsidered": len(articles),
                    "candidates": len(candidates),
                    "unclassified": unclassified,
                    "feeds": load_json(ROOT / "data" / "geography" / "news_feeds.json")["feeds"],
                },
                "clusters": sorted(
                    clustered,
                    key=lambda c: c["publishedAt"] or "",
                    reverse=True,
                ),
            },
            indent=1,
            ensure_ascii=False,
        )
        + "\n"
    )

    placed = sum(1 for c in clustered if c["divisionId"])
    print(f"\nclusters {len(clustered)}, placed {placed}, unclassified {unclassified}, errors {errors}")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
