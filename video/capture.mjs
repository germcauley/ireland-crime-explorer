import { chromium } from "playwright-core";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Films the real app.
 *
 * The frames come from a CDP screencast rather than page screenshots, so the
 * capture runs at wall-clock speed and picks up the CSS transitions (the sheet
 * snapping, the map redraw) as a viewer would see them. Screencast only emits
 * on change, so each frame carries its own timestamp and the composer holds
 * the last one through the still stretches.
 *
 * Every beat is paced by the length of its narration line, measured from the
 * generated audio — the picture follows the voice, not a guess.
 */

const CHROME =
  process.env.CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const URL_ = process.env.SITE ?? "http://localhost:3002";
const OUT = "out";
const FRAMES = join(OUT, "frames");
/** 540 CSS px keeps the app in its narrow layout; ×2 gives a 1080-wide frame. */
const VIEWPORT = { width: 540, height: 880 };
const GAP = 0.45;
/**
 * Film slowly, play at speed. The screencast tops out around seven frames a
 * second at this resolution, so the whole performance runs at half pace and the
 * composer plays it back at 2×: the motion arrives at ~14fps without giving up
 * a 1080-wide frame. Every wait here is in real time; SLOW stretches it.
 */
const SLOW = Number(process.env.SLOW ?? 2);

const durations = JSON.parse(
  await import("node:fs").then((fs) => fs.promises.readFile(join(OUT, "vo/durations.json"), "utf8")),
);
const script = JSON.parse(
  await import("node:fs").then((fs) => fs.promises.readFile("script.json", "utf8")),
);

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  // The screencast captures the compositor surface, which is CSS-sized unless
  // the whole browser is scaled: without this the frames come back 540 wide.
  args: [
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    `--force-device-scale-factor=${process.env.DSF ?? 2}`,
  ],
});
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: Number(process.env.DSF ?? 2),
  colorScheme: "dark",
  reducedMotion: "no-preference",
});
// Dark, and settled before first paint: the theme script reads this.
await context.addInitScript(() => {
  try {
    localStorage.setItem("theme", "dark");
  } catch {}
});
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms * SLOW);
await page.goto(URL_, { waitUntil: "networkidle" });
await page.waitForSelector("g.node", { timeout: 20_000 });
await wait(600);

// A pointer the screencast can see. The real cursor is not in the frame.
await page.evaluate((SLOW) => {
  const style = document.createElement("style");
  // The app's own transitions stretch too, so playback restores their real feel.
  style.textContent = `.readout-rail{transition-duration:${0.22 * SLOW}s!important}`;
  document.head.appendChild(style);
  const dot = document.createElement("div");
  dot.id = "vo-cursor";
  dot.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:22px",
    "height:22px",
    "margin:-11px 0 0 -11px",
    "border-radius:50%",
    "border:2px solid rgba(255,255,255,.9)",
    "background:rgba(255,255,255,.22)",
    "box-shadow:0 0 0 1px rgba(0,0,0,.35)",
    "pointer-events:none",
    "z-index:99999",
    "opacity:0",
    "transform:translate3d(-100px,-100px,0)",
    `transition:transform ${0.5 * SLOW}s cubic-bezier(.22,.61,.36,1),opacity ${0.2 * SLOW}s linear`,
  ].join(";");
  document.body.appendChild(dot);
  window.__cursor = (x, y, show = true) => {
    dot.style.opacity = show ? "1" : "0";
    dot.style.transform = `translate3d(${x}px,${y}px,0)`;
  };
  window.__tap = () => {
    dot.animate(
      [{ transform: dot.style.transform + " scale(1)" }, { transform: dot.style.transform + " scale(.6)" }, { transform: dot.style.transform + " scale(1)" }],
      { duration: 260 * SLOW, easing: "ease-out" },
    );
  };
}, SLOW);

const client = await context.newCDPSession(page);
let n = 0;
const frames = [];
let t0 = 0;
// Ack first and buffer in memory: writing each frame to disk inside the
// handler stalls the event loop and the capture drops to a few frames a second.
client.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
  client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  if (!t0) t0 = metadata.timestamp;
  frames.push({ data, t: metadata.timestamp - t0 });
});

async function point(selector, dy = 0) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 + dy };
}

/** Move the drawn pointer, let it travel, then click for real. */
async function tap(selector, { dy = 0, settle = 500 } = {}) {
  const { x, y } = await point(selector, dy);
  await page.evaluate(([x, y]) => window.__cursor(x, y), [x, y]);
  await wait(560);
  await page.evaluate(() => window.__tap());
  await page.mouse.click(x, y);
  await wait(settle);
}

async function hideCursor() {
  await page.evaluate(() => window.__cursor(-100, -100, false));
}

const marks = [];
const started = Date.now();
const elapsed = () => (Date.now() - started) / 1000;

async function beat(id, body) {
  const at = elapsed();
  marks.push({ id, at });
  const budget = (durations[id] + GAP) * SLOW;
  if (body) await body();
  const left = budget - (elapsed() - at);
  if (left > 0) await page.waitForTimeout(left * 1000);
}

await client.send("Page.startScreencast", {
  format: "jpeg",
  quality: 85,
  maxWidth: VIEWPORT.width * Number(process.env.DSF ?? 2),
  maxHeight: VIEWPORT.height * Number(process.env.DSF ?? 2),
  everyNthFrame: 1,
});
// A beat of stillness so the first narrated word lands on a settled frame.
await wait(700);

await beat("open", async () => {
  await page.evaluate(() => window.__cursor(270, 470));
});

await beat("map", async () => {
  // Drift across the country while the voice describes it.
  await page.evaluate(() => window.__cursor(150, 300));
  await wait(900);
  await page.evaluate(() => window.__cursor(360, 380));
  await wait(900);
  await hideCursor();
});

await beat("select", async () => {
  await tap('g.node[aria-label^="Galway"]', { settle: 900 });
  await hideCursor();
});

await beat("offence", async () => {
  await tap(".pill", { settle: 420 });
  await tap('.panel-list .panel-row:has-text("Theft") > button', { settle: 420 });
  await tap('.panel-sub button:has-text("Theft from shop")', { settle: 700 });
  await hideCursor();
});

await beat("years", async () => {
  await tap(".pill.is-num", { settle: 400 });
  await tap('.panel .year-chips button:has-text("2023")', { settle: 500 });
  await tap('.panel-head .rail-more', { settle: 500 });
  await hideCursor();
});

await beat("news", async () => {
  // Pull the sheet up and scroll the reporting into view.
  await tap(".sheet-handle", { settle: 500 });
  await page.evaluate(() => {
    const rail = document.querySelector(".readout-rail");
    const target = document.querySelector(".reporting");
    if (rail && target) rail.scrollTo({ top: target.offsetTop - rail.offsetTop - 8, behavior: "smooth" });
  });
  await hideCursor();
  await wait(1400);
  await page.evaluate(() => document.querySelector(".readout-rail")?.scrollTo({ top: 0, behavior: "smooth" }));
  await tap(".sheet-handle", { settle: 250 });
  await hideCursor();
});

await beat("dublin", async () => {
  await tap('.explorer-nav button:nth-child(2)', { settle: 900 });
  await hideCursor();
});

await beat("caveat", async () => {
  await tap('.masthead-actions .text-link:last-child', { settle: 900 });
  await hideCursor();
  // Hold on the lede: it is the sentence the whole beat is about.
  await wait(2600);
  await page.evaluate(() => window.scrollTo({ top: 320, behavior: "smooth" }));
});

await beat("end", async () => {
  await page.evaluate((SLOW) => {
    const card = document.createElement("div");
    card.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:99998",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "gap:18px",
      "background:var(--color-bg)",
      "opacity:0",
      `transition:opacity ${0.45 * SLOW}s ease`,
    ].join(";");
    card.innerHTML = `
      <img src="/logo-mark-dark.png" alt="" width="96" style="height:auto">
      <h1 style="margin:0;font-size:36px;line-height:1.1;font-weight:600;text-align:center;letter-spacing:-.015em">Ireland<br>Crime Explorer</h1>
      <p style="margin:0;font-size:19px;font-style:italic;color:var(--color-neutral-700)">Recorded crime, in context.</p>
      <p style="margin:14px 0 0;font-size:18px;color:var(--color-accent-700)">ireland-crime-explorer.vercel.app</p>`;
    document.body.appendChild(card);
    requestAnimationFrame(() => {
      card.style.opacity = "1";
    });
  }, SLOW);
});

await wait(700);
await client.send("Page.stopScreencast");
await wait(200);
await browser.close();

frames.forEach((frame, index) => {
  frame.file = join(FRAMES, `${String(index).padStart(5, "0")}.jpg`);
  writeFileSync(frame.file, Buffer.from(frame.data, "base64"));
  delete frame.data;
});

writeFileSync(
  join(OUT, "capture.json"),
  JSON.stringify({ viewport: VIEWPORT, dsf: Number(process.env.DSF ?? 2), slow: SLOW, frames, marks, total: elapsed() }, null, 1),
);
console.log(`captured ${frames.length} frames over ${elapsed().toFixed(1)}s`);
console.log(marks.map((m) => `${m.id} @ ${m.at.toFixed(1)}s`).join("\n"));
