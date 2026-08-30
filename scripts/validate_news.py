"""Guard the news pipeline. Exits non-zero so CI fails rather than publishes.

Three things are checked:

1. The prefilter still behaves on a fixture of real articles. Every "reject"
   case is a bug that actually occurred — Northern Ireland stories arriving
   with no Division to belong to, and village names that are ordinary English
   words ("Hospital", "Street") matching prose.

2. news.json is structurally sound: no article claims a Division that does not
   exist, no article is published with a confidence below the threshold, and
   nothing carries a town without a Division.

3. Health signals worth seeing rather than failing on — how much of the
   archive is unclassified, and which Divisions have no coverage at all.

The bar is precision, not recall. A missed article costs nothing. An article
filed under the wrong county is a false statement about a real place.

    python3 scripts/validate_news.py
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
NEWS = ROOT / "data" / "processed" / "news.json"
GAZETTEER = ROOT / "data" / "geography" / "division_places.json"
FIXTURE = ROOT / "tests" / "fixtures" / "news_prefilter_cases.json"
LABELS = ROOT / "tests" / "fixtures" / "news_labelled.json"

# Precision, not recall. Missing an article costs nothing; placing one in the
# wrong county is a false statement about a real place.
MIN_PRECISION = 0.9

MAX_UNCLASSIFIED_SHARE = 0.95

failures: list[str] = []
notes: list[str] = []


def load(path: pathlib.Path):
    if not path.exists():
        print(f"error: {path.relative_to(ROOT)} missing — run the pipeline first", file=sys.stderr)
        raise SystemExit(1)
    return json.loads(path.read_text())


def load_classifier():
    spec = importlib.util.spec_from_file_location("classify_news", ROOT / "scripts" / "classify_news.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_prefilter(classifier, gazetteer) -> None:
    fixture = load(FIXTURE)
    index = classifier.build_place_index(gazetteer)
    wrong = 0
    for case in fixture["cases"]:
        article = {"title": case["title"], "description": case["description"]}
        is_candidate, _hits, _divisions = classifier.prefilter(article, index)
        if is_candidate != case["expectCandidate"]:
            wrong += 1
            expected = "candidate" if case["expectCandidate"] else "rejected"
            failures.append(
                f"prefilter: expected {expected} but got the opposite\n"
                f"    {case['title'][:70]}\n"
                f"    reason on file: {case['why']}"
            )
    print(f"prefilter fixture: {len(fixture['cases']) - wrong}/{len(fixture['cases'])} correct")


def check_structure(news, gazetteer) -> None:
    valid_divisions = {d["id"] for d in gazetteer["divisions"]}
    clusters = news["clusters"]
    threshold = 0.6

    for cluster in clusters:
        for field in ("id", "title", "url", "source", "divisionId", "confidence"):
            if field not in cluster:
                failures.append(f"structure: cluster missing '{field}': {cluster.get('title', '?')[:50]}")

        division = cluster.get("divisionId")
        if division is not None and division not in valid_divisions:
            failures.append(f"structure: unknown division '{division}' on {cluster['title'][:50]}")

        if division and cluster.get("confidence", 0) < threshold:
            failures.append(
                f"structure: published below confidence threshold "
                f"({cluster['confidence']}): {cluster['title'][:50]}"
            )

        if cluster.get("town") and not division:
            failures.append(
                f"structure: town '{cluster['town']}' without a Division — "
                f"a town must never be shown unattached: {cluster['title'][:50]}"
            )

        if not cluster.get("url", "").startswith("http"):
            failures.append(f"structure: article has no usable link: {cluster['title'][:50]}")

    ids = [c["id"] for c in clusters]
    if len(ids) != len(set(ids)):
        failures.append("structure: duplicate cluster ids")

    print(f"structure: {len(clusters)} clusters checked")


def report_health(news, gazetteer) -> None:
    clusters = news["clusters"]
    if not clusters:
        notes.append("archive is empty — nothing has been classified yet")
        return

    placed = [c for c in clusters if c.get("divisionId")]
    share_unclassified = 1 - (len(placed) / len(clusters))
    print(f"health: {len(placed)}/{len(clusters)} placed ({share_unclassified:.0%} unclassified)")

    if news["meta"].get("model") and share_unclassified > MAX_UNCLASSIFIED_SHARE:
        failures.append(
            f"health: {share_unclassified:.0%} unclassified after a model run — "
            "the prefilter, gazetteer or prompt has drifted"
        )

    covered = {c["divisionId"] for c in placed}
    missing = [d["name"] for d in gazetteer["divisions"] if d["id"] not in covered]
    if missing:
        notes.append(f"{len(missing)} Division(s) have no reporting: {', '.join(missing[:6])}"
                     + (" …" if len(missing) > 6 else ""))


def score_against_labels(news) -> None:
    """Compare a model run against the hand-reviewed labels.

    Skipped when the artifact was itself built from those labels — scoring
    labels against themselves proves nothing.
    """
    if not LABELS.exists():
        notes.append("no labelled fixture — stage 2 accuracy is unmeasured")
        return
    if news["meta"].get("model") in (None, "hand-reviewed"):
        notes.append(
            "artifact was not produced by a model run — classification accuracy not scored"
        )
        return

    labels = {entry["id"]: entry for entry in load(LABELS)["labels"]}
    by_id = {cluster["id"]: cluster for cluster in news["clusters"]}

    judged = agreed = wrong = 0
    for article_id, label in labels.items():
        cluster = by_id.get(article_id)
        if cluster is None:
            continue
        judged += 1
        predicted = cluster.get("divisionId")
        expected = label["division"]
        if predicted == expected:
            agreed += 1
        elif predicted is not None:
            # Withholding where a label expects a Division costs recall only.
            # Asserting the wrong one is the failure that matters.
            wrong += 1
            failures.append(
                f"classification: placed in {predicted}, labelled {expected or 'unclassified'}\n"
                f"    {cluster['title'][:70]}"
            )

    if not judged:
        notes.append("no labelled articles present in this artifact")
        return

    asserted = agreed + wrong
    precision = agreed / asserted if asserted else 1.0
    print(f"classification: {agreed}/{judged} agree with labels, precision {precision:.0%}")
    if asserted and precision < MIN_PRECISION:
        failures.append(
            f"classification: precision {precision:.0%} is below the {MIN_PRECISION:.0%} bar"
        )


def main() -> None:
    news = load(NEWS)
    gazetteer = load(GAZETTEER)
    classifier = load_classifier()

    check_prefilter(classifier, gazetteer)
    check_structure(news, gazetteer)
    score_against_labels(news)
    report_health(news, gazetteer)

    for note in notes:
        print(f"note: {note}")

    if failures:
        print(f"\n{len(failures)} failure(s):", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        raise SystemExit(1)

    print("\nvalidation passed")


if __name__ == "__main__":
    main()
