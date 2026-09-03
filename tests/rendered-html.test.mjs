import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the crime explorer and social metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Ireland Crime Explorer<\/title>/i);
  assert.match(html, /Ireland Crime Explorer/);
  // The shell must server-render: both geographies reachable, the comparison
  // and offence controls present, and the disclosure link offered.
  // React splits interpolated text with <!-- --> markers, so these match the
  // literal halves rather than the rendered sentence.
  assert.match(html, /Nationwide ·/);
  assert.match(html, /Divisions/);
  assert.match(html, /Dublin ·/);
  assert.match(html, /station areas/);
  // The control bar carries the offence and the period; both open a panel, so
  // only the bar's own labels are in the server HTML.
  assert.match(html, /class="pill"/);
  assert.match(html, /All crime/);
  assert.match(html, /Find a Division/);
  assert.match(html, /What was recorded there/);
  assert.match(html, /What this is, and is not/);
  // Recorded-not-prevalence has to reach a reader who never runs any script.
  assert.match(html, /Recorded incidents are not total crime/);
  assert.doesNotMatch(html, /Crime Bot/);
  assert.match(html, /http:\/\/localhost\/og\.png/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|Your site is taking shape/);
});

test("processed dashboard preserves key official-data checks", async () => {
  const payload = JSON.parse(
    await readFile(new URL("../data/processed/dashboard.json", import.meta.url), "utf8"),
  );
  assert.equal(payload.meta.sourceTable, "CSO CJA11");
  assert.equal(payload.meta.latestCompleteYear, 2025);
  assert.equal(payload.stations.length, 41);
  assert.equal(payload.categories.length, 21);

  const dundrum = payload.stations.find((station) => station.id === "65102");
  const latestIndex = payload.meta.years.indexOf(2025);
  assert.equal(dundrum.series.all[latestIndex], 2791);
  assert.equal(dundrum.series["08"][latestIndex], 1338);
  assert.ok(
    Math.abs(
      dundrum.series["08"][latestIndex] / dundrum.series.all[latestIndex] -
        0.4794,
    ) < 0.001,
  );

  const castleknock = payload.places.find((place) => place.place === "Castleknock");
  assert.deepEqual(castleknock.stationIds, ["66101"]);
  assert.match(castleknock.note, /not Castleknock-only/i);

  const fraud = payload.categories.find((category) => category.id === "09");
  assert.match(fraud.availabilityNote, /unavailable.*2024/i);
});

test("generated social card is present", async () => {
  const card = await readFile(new URL("../public/og.png", import.meta.url));
  assert.ok(card.length > 50_000);
});
