"""
Extract and repair JSON from raw LLM text.

One shared parser, so every compared model's JSON-validity rate (an
evaluation metric) is scored identically. Handles two observed habits:
JSON wrapped in prose or markdown fences despite instructions (phi4-mini
fenced every response in the 2026-08-21 planner runs), and trailing
commas.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

_JSON_BLOCK_RE = re.compile(r"\{.*\}|\[.*\]", re.DOTALL)
# A comma before a closing ] or }. phi4-mini reliably emits one for a
# single-element array, e.g. '[{"item_number": 10, ...},]', on every
# retry (2026-08-07: every item still missing after single-item recovery
# had this defect).
_TRAILING_COMMA_RE = re.compile(r",(\s*[\]}])")


def _strip_trailing_commas(text: str) -> str:
    return _TRAILING_COMMA_RE.sub(r"\1", text)


@dataclass
class JsonExtraction:
    """extract_json()'s verdict plus `was_repaired`: True after a
    trailing-comma fix or extraction from prose/fences (the model still
    did not produce clean output). Drives raw_valid vs
    mechanically_repaired."""

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
    Direct parse -> trailing-comma repair -> first {...}/[...] block ->
    trailing-comma repair on the block, reporting whether any repair was
    needed. The single implementation of the strategy.
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
    # Extraction from prose is itself a repair.
    return JsonExtraction(block_result.parsed, True, True)


def extract_json(raw_text: str) -> tuple[dict | list | None, bool]:
    """(parsed, is_valid) via extract_json_detailed()."""
    result = extract_json_detailed(raw_text)
    return result.parsed, result.is_valid
