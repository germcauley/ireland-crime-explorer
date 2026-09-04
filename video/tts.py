#!/usr/bin/env python3
"""Speak each beat of script.json, and measure how long it takes.

The measured lengths are the film's timing source: capture.mjs gives every
beat exactly as long as its own narration line, so the picture follows the
voice instead of a guess at it. Rerun this whenever the wording changes.
"""

import json
import os
import subprocess
import sys

OUT = "out/vo"
script = json.load(open("script.json"))
os.makedirs(OUT, exist_ok=True)

durations = {}
for beat in script["beats"]:
    path = f"{OUT}/{beat['id']}.mp3"
    subprocess.run(
        ["edge-tts", "--voice", script["voice"], f"--rate={script['rate']}",
         "--text", beat["say"], "--write-media", path],
        check=True,
    )
    seconds = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    ).stdout.strip())
    durations[beat["id"]] = round(seconds, 3)
    print(f"{beat['id']:9} {seconds:6.2f}s  {beat['say'][:56]}")

json.dump(durations, open(f"{OUT}/durations.json", "w"), indent=1)
total = sum(durations.values())
print(f"\n{len(durations)} lines, {total:.1f}s of speech")
if total > 85:
    print("note: over 85s of speech — long for a feed", file=sys.stderr)
