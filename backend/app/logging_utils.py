"""
Structured JSON-lines run logging with per-stage timing.

This exists before any model-calling code is written, on purpose (§3 step 1).
Both the API layer and the evaluation harness (§3 step 3) import `stage_timer`
from here so a single log format backs live requests and batch eval runs —
no separate ad-hoc print()-based timing to reconcile later.

Each call to a model or service stage should be wrapped like:

    with stage_timer(run_id, "grounding_dino_detect") as t:
        result = detect(image)
        t.meta["n_objects"] = len(result.boxes)

which appends one JSON line to logs/runs.jsonl:

    {"run_id": "...", "stage": "grounding_dino_detect", "duration_ms": 812.4,
     "ok": true, "meta": {"n_objects": 21}, "ts": "2026-07-30T20:47:00Z"}

`meta` is free-form per stage — detection stages log object counts,
LLM stages log JSON-validity + token counts, image-gen logs fidelity score
once §3 step 7 is implemented. Keeping it free-form here avoids having to
touch this file every time a new stage wants to record something new.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from app.config import get_settings

_LOGGER_NAME = "clearspace.runs"


def _run_log_path() -> Path:
    settings = get_settings()
    log_dir = Path(settings.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / "runs.jsonl"


def new_run_id() -> str:
    """One run_id per user-facing request (an /upload call, an eval-set image, etc.)."""
    return uuid.uuid4().hex[:12]


@dataclass
class _StageHandle:
    run_id: str
    stage: str
    started_at: float = field(default_factory=time.perf_counter)
    meta: dict[str, Any] = field(default_factory=dict)


def _write_line(record: dict[str, Any]) -> None:
    path = _run_log_path()
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


@contextmanager
def stage_timer(run_id: str, stage: str) -> Iterator[_StageHandle]:
    """
    Context manager wrapping one pipeline stage. Records duration and
    success/failure regardless of whether the stage raises — a failed
    stage is exactly the kind of data point the §8 evaluation work needs
    (JSON-validity rate, timeout rate), not something to silently drop.
    """
    handle = _StageHandle(run_id=run_id, stage=stage)
    ok = True
    error: str | None = None
    try:
        yield handle
    except Exception as exc:  # noqa: BLE001 — intentionally broad, this is a logging boundary
        ok = False
        error = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        duration_ms = (time.perf_counter() - handle.started_at) * 1000
        _write_line(
            {
                "run_id": handle.run_id,
                "stage": handle.stage,
                "duration_ms": round(duration_ms, 2),
                "ok": ok,
                "error": error,
                "meta": handle.meta,
                "ts": datetime.now(timezone.utc).isoformat(),
            }
        )


def configure_logging() -> None:
    """Console logging for human-readable dev output — separate from the JSON-lines run log above."""
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
