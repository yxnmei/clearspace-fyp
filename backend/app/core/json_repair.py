"""
Pure logic: extract/repair JSON from raw LLM text output. No model calls —
unit-testable in milliseconds against fixture strings in tests/unit/.

Exists as its own module because JSON-validity rate is a first-class §8
evaluation metric ("for the LLM stage specifically — JSON-validity rate
and distribution-vs-target deviation, not just a pass/fail impression").
Centralising the parsing here means every candidate model in
mistral_llm.COMPARISON_MODELS gets scored by exactly the same parser —
a model shouldn't look worse just because a different ad-hoc regex was
used on its output.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

_JSON_BLOCK_RE = re.compile(r"\{.*\}|\[.*\]", re.DOTALL)
# A comma immediately before a closing ] or } (allowing intervening
# whitespace) — invalid JSON, but a common LLM habit. Confirmed in practice:
# phi4-mini reliably appends one when asked for a JSON array containing
# exactly one element, e.g. '[{"item_number": 10, ...},]' — and does it on
# every retry, not just occasionally, since it's a formatting habit, not a
# one-off slip (DEVLOG.md 2026-08-07 completeness-recovery investigation:
# every item that stayed missing after a targeted single-item recovery call
# turned out to have this exact defect in its raw response).
_TRAILING_COMMA_RE = re.compile(r",(\s*[\]}])")


def _strip_trailing_commas(text: str) -> str:
    return _TRAILING_COMMA_RE.sub(r"\1", text)


@dataclass
class JsonExtraction:
    """Same verdict as the (parsed, is_valid) tuple extract_json() returns,
    plus `was_repaired` — whether a clean parse actually needed help.
    `was_repaired` is True for BOTH failure modes extract_json() silently
    recovers from: a trailing-comma fix, and pulling the JSON out of
    surrounding prose/markdown fences (extraction itself counts as a
    repair, even if the extracted block then parses with no further
    fixing needed — the model still didn't produce clean output). Exists
    because item-level ItemValidity (raw_valid vs mechanically_repaired,
    see app.models.mistral_llm) needs this distinction; extract_json()
    itself never did and still doesn't."""

    parsed: dict | list | None
    is_valid: bool
    was_repaired: bool


def _try_parse_detailed(text: str) -> JsonExtraction:
    try:
        return JsonExtraction(json.loads(text), True, False)
    except json.JSONDecodeError:
        pass
    try:
        return JsonExtraction(json.loads(_strip_trailing_commas(text)), True, True)
    except json.JSONDecodeError:
        return JsonExtraction(None, False, False)


def extract_json_detailed(raw_text: str) -> JsonExtraction:
    """
    Same extraction strategy as extract_json() (direct parse -> trailing-
    comma repair -> extract first {...}/[...] block -> trailing-comma
    repair on the block), but reports whether any repair step was needed
    to get there. extract_json() is now a thin wrapper over this — see
    its own docstring; this function is the one place the strategy is
    implemented.
    """
    result = _try_parse_detailed(raw_text)
    if result.is_valid:
        return result

    match = _JSON_BLOCK_RE.search(raw_text)
    if not match:
        return JsonExtraction(None, False, False)

    block_result = _try_parse_detailed(match.group(0))
    if not block_result.is_valid:
        return block_result
    # Extracting from surrounding prose is itself a repair, even when the
    # extracted block then parsed cleanly with no trailing-comma fix.
    return JsonExtraction(block_result.parsed, True, True)


def extract_json(raw_text: str) -> tuple[dict | list | None, bool]:
    """
    Returns (parsed, is_valid). Tries a direct parse first (with a
    trailing-comma repair fallback), then falls back to extracting the
    first {...} or [...] block (models often wrap JSON in prose or
    markdown fences despite instructions not to), repaired the same way.

    Unchanged in signature and behaviour — a thin wrapper over
    extract_json_detailed(), kept so every existing caller (both eval
    scripts, this module's own original test suite) needs zero changes.
    """
    result = extract_json_detailed(raw_text)
    return result.parsed, result.is_valid
