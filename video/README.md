# Promo video harness

Films the real app and narrates it. Nothing is recreated or mocked up: the
frames are the running site, and every figure on screen is whatever the app
computes from `dashboard.json` that day.

```bash
npm install                                   # once, in this folder
npm run dev -- --port 3002                    # in the repo root, first
python3 tts.py                                # narration + durations
node capture.mjs                              # films it (~2 min)
python3 compose.py                            # muxes the cut
```

Output lands in `out/`. Neither `out/` nor the finished mp4 is committed —
they are rebuilt from these four files.

## How it fits together

`script.json` is the whole edit: one entry per beat, carrying what the voice
says and what the caption reads. Change the wording there and the timing
re-derives itself — nothing else needs touching.

`tts.py` generates one mp3 per beat with edge-tts and measures each with
ffprobe. Those measured lengths are what pace the film: `capture.mjs` gives
every beat exactly as long as its own line takes to speak, so the picture
follows the voice rather than a guess at it.

`capture.mjs` drives the page with Playwright and records a CDP screencast.
Two things in there are less obvious than they look:

- **The browser is scaled, not the viewport.** The screencast captures the
  compositor surface, which is CSS-sized: without
  `--force-device-scale-factor=2` the frames come back 540 wide however large
  the viewport is.
- **It films at half speed and plays back at 2×.** The screencast tops out
  near seven frames a second at 1080 wide, so the whole performance runs slow
  and `compose.py` divides the timestamps back down — about twelve frames a
  second of motion without dropping to a soft upscale. `SLOW` controls it;
  the app's own transitions and the drawn cursor stretch with it, so playback
  restores their real feel.

`compose.py` holds each frame until the next arrives (the screencast only
emits on change), pads a caption band below the phone frame, and places each
narration line at its beat's start.

## Reusing it

- **Different words:** edit `script.json`, rerun `tts.py` and both scripts.
- **Different flow:** the `beat(...)` calls at the foot of `capture.mjs` are
  the storyboard, one per entry in `script.json`. `tap(selector)` moves the
  drawn pointer, waits for it to travel, then clicks for real.
- **Different shape:** `VIEWPORT` in `capture.mjs` and `W`/`H`/`BAND` in
  `compose.py`. Keep the viewport under 720 CSS px for the app's phone
  layout; anything wider gets the desktop one.
- **Different voice:** `voice` in `script.json`. `edge-tts --list-voices`
  shows what is available.

Captions sit in a band below the frame rather than over the app, because
feeds autoplay muted and covering the readout to explain the readout defeats
itself.

## Requirements

ffmpeg, python3 with Pillow and edge-tts, and a Chrome for Testing binary
(the path is at the top of `capture.mjs`; override with `CHROME`). The
composer renders caption text with Pillow rather than ffmpeg's `drawtext`,
which is absent from the common Homebrew build.
