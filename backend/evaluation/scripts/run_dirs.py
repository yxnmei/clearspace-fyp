"""
Shared helper: one timestamped output folder per evaluation run, under
evaluation/results/ — so a run's outputs (annotated images, result JSON)
are grouped together instead of landing flat in evaluation/results/, where
they either collide with the next run's identically-named file (found in
practice: visualize_detections.py's old default output,
annotated_bedroom01.jpg, silently overwrote on every run, permanently
losing the "before" state) or can only be told apart from each other by a
raw timestamp with no context.

Deliberately NOT a bigger experiment-tracking tree (inputs + outputs +
metadata all duplicated per run) — see DEVLOG.md, decision made when this
was discussed. data/test_images/ doesn't change between runs, so it isn't
duplicated into every run folder; only outputs live here. This also isn't
a substitute for committing code: knowing *which run folder* holds a given
result doesn't tell you which code produced it unless that code was
actually committed around the same time (§3 step 8 — commit per concern,
frequently).

Applies only to runs from this point forward — pre-existing flat files in
evaluation/results/ (e.g. compare_llm_reasoning_20260805_202154.json) are
untouched, not migrated into this structure.
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

_RESULTS_ROOT = Path("evaluation/results")
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(label: str) -> str:
    return _SLUG_RE.sub("-", label.strip().lower()).strip("-")


def new_run_dir(label: str | None = None, root: Path = _RESULTS_ROOT) -> Path:
    """
    Creates and returns evaluation/results/<timestamp>[_<label>]/ — call
    once per script invocation (not once per image or per model), so
    everything that run produces lands together in one folder. `label` is
    a short free-text description (e.g. "vocab-v2", "json-fix-verify");
    slugified so it's filesystem-safe on Windows too.
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    name = timestamp if not label else f"{timestamp}_{_slugify(label)}"
    run_dir = root / name
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir
