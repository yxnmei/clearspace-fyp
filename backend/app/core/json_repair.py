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


def _try_parse(text: str) -> tuple[dict | list | None, bool]:
    try:
        return json.loads(text), True
    except json.JSONDecodeError:
        pass
    try:
        return json.loads(_strip_trailing_commas(text)), True
    except json.JSONDecodeError:
        return None, False


def extract_json(raw_text: str) -> tuple[dict | list | None, bool]:
    """
    Returns (parsed, is_valid). Tries a direct parse first (with a
    trailing-comma repair fallback), then falls back to extracting the
    first {...} or [...] block (models often wrap JSON in prose or
    markdown fences despite instructions not to), repaired the same way.
    """
    parsed, ok = _try_parse(raw_text)
    if ok:
        return parsed, ok

    match = _JSON_BLOCK_RE.search(raw_text)
    if not match:
        return None, False

    return _try_parse(match.group(0))
