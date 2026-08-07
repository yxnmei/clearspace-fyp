"""
Draws Grounding DINO's raw detections (boxes + labels + confidence) onto a
copy of the source image, so detection quality — false positives,
mislabeling, box placement — can be checked visually instead of only
inferred from a label list. Motivated directly by the "clock" mislabel in
bedroom02.jpg (DEVLOG.md, 2026-08-01) — found only because someone happened
to recognize the real object in the photo; a picture makes that kind of
error obvious immediately.

Usage (single image, or every image in a directory — all in one run folder):
    python -m evaluation.scripts.visualize_detections data/test_images/bedroom02.jpg
    python -m evaluation.scripts.visualize_detections data/test_images --label vocab-v2
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw

from app.models.grounding_dino import detect
from evaluation.scripts.run_dirs import new_run_dir

_BOX_COLORS = ["red", "lime", "cyan", "yellow", "magenta", "orange", "white", "deepskyblue"]
_IMAGE_GLOBS = ("*.jpg", "*.jpeg", "*.png")


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


def draw_detections(image_path: Path, out_path: Path) -> int:
    image_bytes = image_path.read_bytes()
    detections = detect(image_bytes)

    image = Image.open(image_path).convert("RGB")
    width, height = image.size
    draw = ImageDraw.Draw(image)

    for i, det in enumerate(detections):
        x1, y1, x2, y2 = det.box_xyxy  # normalized [0, 1] — see grounding_dino.RawDetection
        box = (x1 * width, y1 * height, x2 * width, y2 * height)
        color = _BOX_COLORS[i % len(_BOX_COLORS)]
        draw.rectangle(box, outline=color, width=3)
        draw.text((box[0] + 2, max(0, box[1] - 14)), f"{det.label} {det.confidence:.2f}", fill=color)

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
