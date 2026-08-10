"""
Draws Grounding DINO's raw detections (boxes + labels + confidence) onto a
copy of the source image, so detection quality — false positives,
mislabeling, box placement — can be checked visually instead of only
inferred from a label list. Motivated directly by the "clock" mislabel in
bedroom02.jpg (DEVLOG.md, 2026-08-01) — found only because someone happened
to recognize the real object in the photo; a picture makes that kind of
error obvious immediately.

Label styling (2026-08-10 rework, DEVLOG.md same date): the original version
drew tiny default-bitmap-font text in a per-detection-index color (same
class got a different color in every image, sometimes even within one
image) — hard to read and impossible to compare classes across images at a
glance. Now: a large, bold, high-contrast label (solid-fill background,
readable at full-image zoom) and a color keyed to the label text itself via
a deterministic hash, so "photo frame" is (almost always — see
_resolve_color's docstring) the same color everywhere it appears, in any
image, in any run, with no shared state file to keep in sync.

Usage (single image, or every image in a directory — all in one run folder):
    python -m evaluation.scripts.visualize_detections data/test_images/bedroom02.jpg
    python -m evaluation.scripts.visualize_detections data/test_images --label vocab-v2
"""

from __future__ import annotations

import argparse
import zlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from app.models.grounding_dino import detect
from evaluation.scripts.run_dirs import new_run_dir

_IMAGE_GLOBS = ("*.jpg", "*.jpeg", "*.png")

# Categorical palette: the first 8 are the dataviz skill's validated
# light-mode categorical theme (references/palette.md) — CVD/contrast
# checked as an *adjacent* ordering. Slots 9-13 extend it for this tool's
# higher concurrent-category count, chosen and iterated against
# `dataviz/scripts/validate_palette.js --pairs all`, not picked by eye.
#
# 13 is not a target that was hit — it's where legitimate additions ran
# out (DEVLOG.md 2026-08-10): every 14th/15th/16th candidate tried either
# failed the chroma floor (read as gray) or collided with a color already
# in the set. A real cluttered-room photo can have 20+ genuinely distinct
# object classes (confirmed on bedroom02.jpg: 22 raw label strings, only
# 22->21 after label-cleaning collapses phrase-fragment duplicates — this
# is real scene diversity, not a fragmentation artifact) — no palette size
# that stays humanly readable closes that gap. Some color repetition in
# heavily-cluttered images is therefore accepted as inherent, not a defect
# to keep chasing; it's mitigated, not solved, by every box also carrying
# a direct text label (_resolve_color's docstring), so color is never the
# only cue even when two classes in one image do collide.
_LABEL_COLOR_PALETTE: list[tuple[int, int, int]] = [
    (0x2A, 0x78, 0xD6),  # blue
    (0xEB, 0x68, 0x34),  # orange
    (0x1B, 0xAF, 0x7A),  # aqua
    (0xED, 0xA1, 0x00),  # yellow
    (0xE8, 0x7B, 0xA4),  # magenta
    (0x00, 0x83, 0x00),  # green
    (0x4A, 0x3A, 0xA7),  # violet
    (0xE3, 0x49, 0x48),  # red
    (0x0D, 0x8F, 0xA0),  # teal
    (0x9C, 0x85, 0x00),  # olive-gold
    (0xA6, 0x33, 0x9E),  # orchid
    (0x9C, 0x42, 0x21),  # terracotta
    (0xC9, 0x4F, 0x7C),  # rose
]

_LABEL_FONT_PATHS = [
    r"C:\Windows\Fonts\arial.ttf",  # Windows — regular weight (2026-08-10: bold read as too heavy/jarring)
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",  # Linux
    "/System/Library/Fonts/Supplemental/Arial.ttf",  # macOS
]
_font_warning_shown = False


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in _LABEL_FONT_PATHS:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    global _font_warning_shown
    if not _font_warning_shown:
        print(
            "WARNING: no TrueType font found at any of "
            f"{_LABEL_FONT_PATHS} — falling back to PIL's tiny built-in "
            "bitmap font, labels will NOT be readable at full-image zoom."
        )
        _font_warning_shown = True
    return ImageFont.load_default()


def _resolve_color(label: str, used_in_image: dict[str, tuple[int, int, int]]) -> tuple[int, int, int]:
    """
    Deterministic hash of the label text -> palette slot, so a class's color
    doesn't depend on detection order, which other classes appear in the
    same run, or any persisted mapping file. This is the *default* color
    for a label everywhere it's ever drawn.

    Two different classes CAN hash to the same slot (12 colors, ~50+
    vocabulary terms — pigeonhole makes some collision unavoidable at a
    palette size chosen for readability over count, per spec). What must
    not happen is two different classes looking identical *within the same
    image* — so `used_in_image` (reset per image, not shared across the
    run) tracks colors already taken in this image, and a colliding label
    gets linearly probed to the next free slot instead. This means a label
    involved in a same-image collision can render a different color in an
    image where its collision partner isn't present — a deliberate
    trade-off (this image's readability over perfect cross-image identity
    in the rare collision case), not an oversight.
    """
    if label in used_in_image:
        return used_in_image[label]

    start = zlib.crc32(label.encode("utf-8")) % len(_LABEL_COLOR_PALETTE)
    taken = set(used_in_image.values())
    for offset in range(len(_LABEL_COLOR_PALETTE)):
        candidate = _LABEL_COLOR_PALETTE[(start + offset) % len(_LABEL_COLOR_PALETTE)]
        if candidate not in taken:
            used_in_image[label] = candidate
            return candidate

    # Every slot already taken by another class in this image (16+ distinct
    # classes in one photo) — fall back to the plain hash color; a repeat
    # is unavoidable once distinct-classes-in-frame exceeds the palette.
    color = _LABEL_COLOR_PALETTE[start]
    used_in_image[label] = color
    return color


def _text_color_for_background(bg: tuple[int, int, int]) -> str:
    """Perceptual luminance (ITU-R BT.601) decides black-on-light vs
    white-on-dark text so the label stays readable against any palette
    color, not just the light or dark half of it."""
    r, g, b = bg
    luminance = 0.299 * r + 0.587 * g + 0.114 * b
    return "black" if luminance > 140 else "white"


def _resolve_image_paths(paths: list[Path]) -> list[Path]:
    """Expands any directory argument to the image files directly inside it —
    lets one invocation cover the whole test set instead of one per image."""
    resolved: list[Path] = []
    for p in paths:
        if p.is_dir():
            for pattern in _IMAGE_GLOBS:
                resolved.extend(sorted(p.glob(pattern)))
        else:
            resolved.append(p)
    return resolved


def _draw_label(
    draw: ImageDraw.ImageDraw,
    box: tuple[float, float, float, float],
    text: str,
    color: tuple[int, int, int],
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    image_size: tuple[int, int],
    placed_rects: list[tuple[float, float, float, float]],
) -> None:
    """Solid-fill label background (readable over any part of the photo,
    per spec) positioned above the box by default, dropped just inside the
    box's top edge if the box is too close to the top of the frame for an
    above-box label to fit. Nudged downward past any already-placed label
    it would otherwise overlap, up to a bounded number of attempts — a
    lightweight de-overlap pass, not a full layout solver."""
    width, height = image_size
    pad = 3
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    text_w, text_h = right - left, bottom - top
    box_w, box_h = pad * 2 + text_w, pad * 2 + text_h

    x = min(box[0], width - box_w)  # clamp so a box near the right edge doesn't push the label off-frame
    x = max(x, 0)  # also clamp the low side, in case box_w alone exceeds the image width
    y = box[1] - box_h - 2
    if y < 0:
        y = box[1] + 2  # box top is near the image edge — label goes just inside instead
    y = min(y, height - box_h)  # clamp so a box hard against the bottom edge doesn't push the label off-frame

    for _ in range(20):
        candidate = (x, y, x + box_w, y + box_h)
        overlaps = any(
            candidate[0] < r[2] and candidate[2] > r[0] and candidate[1] < r[3] and candidate[3] > r[1]
            for r in placed_rects
        )
        if not overlaps:
            break
        y += box_h + 2

    label_rect = (x, y, x + box_w, y + box_h)
    placed_rects.append(label_rect)
    draw.rectangle(label_rect, fill=color)
    draw.text((x + pad, y + pad), text, font=font, fill=_text_color_for_background(color))


def draw_detections(image_path: Path, out_path: Path) -> int:
    image_bytes = image_path.read_bytes()
    detections = detect(image_bytes)

    image = Image.open(image_path).convert("RGB")
    width, height = image.size
    draw = ImageDraw.Draw(image)

    font_size = max(18, height // 40)  # scales with resolution — stays readable at full-image zoom
    font = _load_font(font_size)
    box_outline_width = max(2, min(4, width // 400))

    used_colors_in_image: dict[str, tuple[int, int, int]] = {}
    placed_label_rects: list[tuple[float, float, float, float]] = []

    for det in detections:
        x1, y1, x2, y2 = det.box_xyxy  # normalized [0, 1] — see grounding_dino.RawDetection
        box = (x1 * width, y1 * height, x2 * width, y2 * height)
        color = _resolve_color(det.label, used_colors_in_image)
        draw.rectangle(box, outline=color, width=box_outline_width)
        _draw_label(draw, box, f"{det.label} {det.confidence:.2f}", color, font, (width, height), placed_label_rects)

    image.save(out_path)
    return len(detections)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "image_paths", type=Path, nargs="+",
        help="One or more image files, or a directory of images (e.g. data/test_images)",
    )
    parser.add_argument(
        "--label", type=str, default=None,
        help="Short description appended to the run folder name, e.g. --label vocab-v2",
    )
    parser.add_argument(
        "--out-dir", type=Path, default=None,
        help="Override the run output directory (default: a new evaluation/results/<timestamp>[_label]/ folder)",
    )
    args = parser.parse_args()

    images = _resolve_image_paths(args.image_paths)
    if not images:
        raise SystemExit(f"No images found in {args.image_paths}")

    run_dir = args.out_dir or new_run_dir(label=args.label)
    run_dir.mkdir(parents=True, exist_ok=True)

    for image_path in images:
        out_path = run_dir / f"annotated_{image_path.name}"
        n = draw_detections(image_path, out_path)
        print(f"{image_path.name}: {n} detections drawn -> {out_path}")

    print(f"Done. Run output: {run_dir}")


if __name__ == "__main__":
    main()
