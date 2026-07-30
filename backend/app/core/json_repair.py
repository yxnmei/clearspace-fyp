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


def extract_json(raw_text: str) -> tuple[dict | list | None, bool]:
    """
    Returns (parsed, is_valid). Tries a direct parse first, then falls
    back to extracting the first {...} or [...] block (models often wrap
    JSON in prose or markdown fences despite instructions not to).
    """
    try:
        return json.loads(raw_text), True
    except json.JSONDecodeError:
        pass

    match = _JSON_BLOCK_RE.search(raw_text)
    if not match:
        return None, False

    try:
        return json.loads(match.group(0)), True
    except json.JSONDecodeError:
        return None, False
