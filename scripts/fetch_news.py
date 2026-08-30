"""Fetch the RSS allowlist into a raw article archive.

Only ever adds. Articles already in the archive are left untouched, so the
archive deepens past the 30-90 days most feeds expose, and re-running is
cheap and idempotent.

Nothing here decides what an article is about — that is classify_news.py.
This step is deliberately dumb so that a change in matching never requires
re-fetching, and so a bad classifier run can be redone against the same input.

Output: data/processed/news_raw.json, committed.

    python3 scripts/fetch_news.py
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import email.utils
import hashlib
import html
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
FEEDS = ROOT / "data" / "geography" / "news_feeds.json"
OUT = ROOT / "data" / "processed" / "news_raw.json"

USER_AGENT = "ireland-crime-explorer/1.0 (+https://github.com/germcauley/ireland-crime-explorer)"
TIMEOUT = 20
MAX_DESCRIPTION = 400

NAMESPACES = {
    "content": "http://purl.org/rss/1.0/modules/content/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "atom": "http://www.w3.org/2005/Atom",
}


# WordPress and several CMSs append a self-referential trailer to every RSS
# description. It is noise in a snippet and often repeats the headline.
BOILERPLATE = re.compile(
    r"(The post\s.*?appeared first on.*$"
    r"|The post\s.*$"
    r"|Continue reading.*$"
    r"|Read more.*$"
    r"|\[…\]\s*$)",
    re.IGNORECASE | re.DOTALL,
)


def clean(text: str | None) -> str:
    """RSS descriptions arrive as escaped HTML fragments of varying quality."""
    if not text:
        return ""
    text = html.unescape(text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    text = BOILERPLATE.sub("", text).strip()
    # A description that is only an ellipsis carries nothing.
    return "" if text in {"[…]", "…", "..."} else text


def parse_date(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).isoformat()


def article_id(url: str, title: str) -> str:
    # URL is the natural key, but some feeds append tracking parameters that
    # change between fetches, so the title participates too.
    basis = f"{url.split('?')[0]}|{title.strip().lower()}"
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]


def read_feed(feed: dict) -> list[dict]:
    request = urllib.request.Request(feed["url"], headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            raw = response.read()
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        print(f"  ! {feed['name']}: {str(error)[:70]}", file=sys.stderr)
        return []

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        print(f"  ! {feed['name']}: malformed XML ({str(error)[:50]})", file=sys.stderr)
        return []

    items = root.findall(".//item") or root.findall(".//atom:entry", NAMESPACES)
    articles = []
    for item in items:
        title = clean(item.findtext("title") or item.findtext("atom:title", "", NAMESPACES))

        link = item.findtext("link") or ""
        if not link:
            # Atom puts the URL in an attribute rather than the element text.
            link_element = item.find("atom:link", NAMESPACES)
            if link_element is not None:
                link = link_element.get("href", "")
        link = link.strip()

        description = clean(
            item.findtext("description")
            or item.findtext("atom:summary", "", NAMESPACES)
            or item.findtext("content:encoded", "", NAMESPACES)
        )
        published = parse_date(
            item.findtext("pubDate")
            or item.findtext("dc:date", None, NAMESPACES)
            or item.findtext("atom:published", None, NAMESPACES)
            or item.findtext("atom:updated", None, NAMESPACES)
        )

        if not title or not link:
            continue

        articles.append(
            {
                "id": article_id(link, title),
                "title": title,
                "description": description[:MAX_DESCRIPTION],
                "url": link,
                "source": feed["name"],
                "scope": feed["scope"],
                "publishedAt": published,
                "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            }
        )
    print(f"  {feed['name']}: {len(articles)}")
    return articles


def main() -> None:
    feeds = json.loads(FEEDS.read_text())["feeds"]
    print(f"fetching {len(feeds)} feeds…")

    fetched: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for result in pool.map(read_feed, feeds):
            fetched.extend(result)

    existing = {}
    if OUT.exists():
        for article in json.loads(OUT.read_text()).get("articles", []):
            existing[article["id"]] = article

    added = 0
    for article in fetched:
        if article["id"] in existing:
            continue
        existing[article["id"]] = article
        added += 1

    articles = sorted(
        existing.values(),
        key=lambda a: (a["publishedAt"] or a["fetchedAt"]),
        reverse=True,
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "meta": {
                    "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "feedCount": len(feeds),
                },
                "articles": articles,
            },
            indent=1,
            ensure_ascii=False,
        )
        + "\n"
    )

    dead = sum(1 for f in feeds if not any(a["source"] == f["name"] for a in fetched))
    print(f"\nfetched {len(fetched)}, new {added}, archive {len(articles)}")
    if dead:
        print(f"warning: {dead} feed(s) returned nothing this run")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
