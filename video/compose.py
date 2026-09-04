#!/usr/bin/env python3
"""Assemble the captured frames and the narration into one vertical cut.

The capture ran at half speed (see SLOW in capture.mjs), so every timestamp is
divided back down here; the narration is placed at each beat's own start, which
is what keeps the picture on the voice without hand-nudging.

Captions are burned into a band below the phone frame rather than over the app,
because feeds autoplay muted and because covering the readout to explain the
readout is self-defeating.
"""

import json
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

OUT = "out"
W, H = 1080, 1760           # the captured frame
BAND = 160                  # caption strip below it
FPS = 30
BG = "0x121110"             # a shade under the app's own dark ground
RULE = "0x2e2b2a"
INK = "0xf2efec"
FONT = "/System/Library/Fonts/Supplemental/Georgia.ttf"

cap = json.load(open(f"{OUT}/capture.json"))
script = json.load(open("script.json"))
slow = cap.get("slow", 1)
frames = cap["frames"]
marks = {m["id"]: m["at"] / slow for m in cap["marks"]}
order = [b["id"] for b in script["beats"]]
captions = {b["id"]: b["caption"] for b in script["beats"]}
durations = json.load(open(f"{OUT}/vo/durations.json"))

# The screencast stops emitting once the end card has settled, so the last
# frame is not the end of the film: the narration decides that.
last_beat = order[-1]
total = max(frames[-1]["t"] / slow, marks[last_beat] + durations[last_beat]) + 1.0

# 1. Frames -> a variable-rate clip. Screencast only emits on change, so each
#    frame is held until the next one arrives.
concat = [f"ffconcat version 1.0"]
for i, f in enumerate(frames):
    start = f["t"] / slow
    end = frames[i + 1]["t"] / slow if i + 1 < len(frames) else total
    concat.append(f"file '{os.path.abspath(f['file'])}'")
    concat.append(f"duration {max(1 / 60, end - start):.4f}")
concat.append(f"file '{os.path.abspath(frames[-1]['file'])}'")
open(f"{OUT}/frames.ffconcat", "w").write("\n".join(concat) + "\n")

# 2. Caption band. Rendered as images rather than drawn by ffmpeg: this build
#    ships without drawtext, and PIL gives the kerning and the wrap control the
#    band needs anyway.
os.makedirs(f"{OUT}/cap", exist_ok=True)
font = ImageFont.truetype(FONT, 36)


def band(text, path):
    image = Image.new("RGBA", (W, BAND), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    words, lines, line = text.split(), [], ""
    for word in words:
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=font) > W - 96 and line:
            lines.append(line)
            line = word
        else:
            line = trial
    lines.append(line)
    step = 44
    top = (BAND - step * len(lines)) // 2
    for index, one in enumerate(lines):
        width = draw.textlength(one, font=font)
        draw.text(((W - width) / 2, top + index * step), one, font=font, fill=(242, 239, 236, 255))
    image.save(path)


spans = []
for i, beat_id in enumerate(order):
    path = f"{OUT}/cap/{beat_id}.png"
    band(captions[beat_id], path)
    start = marks[beat_id]
    end = marks[order[i + 1]] if i + 1 < len(order) else total
    spans.append((path, start, end))

caption_inputs = []
for path, _, _ in spans:
    caption_inputs += ["-i", path]

steps = [
    f"[0:v]fps={FPS},scale={W}:{H}:flags=lanczos,"
    f"pad={W}:{H + BAND}:0:0:color={BG},"
    f"drawbox=x=0:y={H}:w={W}:h=1:color={RULE}:t=fill[base]"
]
label = "base"
for i, (_, start, end) in enumerate(spans):
    nxt = f"v{i}"
    steps.append(
        f"[{label}][{len(order) + 1 + i}:v]overlay=0:{H}:"
        f"enable='between(t,{start:.2f},{end:.2f})'[{nxt}]"
    )
    label = nxt
steps.append(f"[{label}]null[v]")
video_filter = ";".join(steps)

# 3. Narration: each line delayed to its beat.
audio_inputs = []
audio_parts = []
for i, beat_id in enumerate(order):
    audio_inputs += ["-i", f"{OUT}/vo/{beat_id}.mp3"]
    delay = int(marks[beat_id] * 1000)
    audio_parts.append(f"[{i + 1}:a]adelay={delay}|{delay},apad[a{i}]")
mix = "".join(f"[a{i}]" for i in range(len(order)))
audio_filter = (
    ";".join(audio_parts)
    + f";{mix}amix=inputs={len(order)}:duration=longest:normalize=0,"
    f"atrim=0:{total:.2f},afade=t=out:st={total - 0.6:.2f}:d=0.6[a]"
)

target = sys.argv[1] if len(sys.argv) > 1 else f"{OUT}/ireland-crime-explorer-vertical.mp4"
cmd = (
    ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", f"{OUT}/frames.ffconcat"]
    + audio_inputs
    + caption_inputs
    + [
        "-filter_complex", video_filter + ";" + audio_filter,
        "-map", "[v]", "-map", "[a]",
        "-t", f"{total:.2f}",
        "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-crf", "19", "-preset", "slow", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
        target,
    ]
)
if not shutil.which("ffmpeg"):
    sys.exit("ffmpeg not found")
print(f"{len(frames)} frames, {total:.1f}s -> {target}")
proc = subprocess.run(cmd, capture_output=True, text=True)
if proc.returncode:
    print("\n".join(proc.stderr.strip().splitlines()[-12:]))
    sys.exit(proc.returncode)
print(subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                      "format=duration,size:stream=width,height,codec_name",
                      "-of", "default=nw=1", target],
                     capture_output=True, text=True).stdout)
