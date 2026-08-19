"""
Bounded Reorganise-planner comparison — phi4-mini vs qwen3:8b vs mistral
vs gemma2:2b, each in plain and schema-structured output mode.

Why this exists: a real Direct Reorganise run produced two unusable
planner responses and fell through to the deterministic fallback, with a
1440.81s total planning stage. That number is the WHOLE
plan_reorganisation() stage across the initial attempt AND the bounded
recovery attempt (app/services/reorganise_service.py sets one t0 before
the initial call and reports a single StageTiming from it at every return
path) — it is not one call's latency, and no per-attempt timing was
recorded anywhere. The precise reason both responses were unparseable is
also unknown: the raw text was never persisted (no Reorganise code path
uses stage_timer, so logs/runs.jsonl has no entry for it). This harness
exists to measure what that run could not.

Deliberately NOT a production change. Every model/mode/bound explored
here is confined to this evaluation layer:
  - Production prompt construction (build_reorganise_plan_prompt),
    parsing (extract_json_detailed), semantic validation
    (parse_and_validate_plan) and — in the stability stage — the real
    orchestration state machine (plan_reorganisation) are IMPORTED and
    reused, never reimplemented, so a passing candidate here is a
    candidate under production's own rules.
  - The only divergence is the transport call this module makes itself:
    `format=` (schema mode), `options.num_predict`, `options.seed`, and a
    real client `timeout`. Production's own
    reorganise_llm.generate_reorganise_plan_once() is never imported for
    its transport, never modified, and Declutter
    (app/models/mistral_llm.py, settings.llm_model_name) is not touched
    at all.

Import boundary: importing this module pulls in no torch, CLIP, Grounding
DINO or Colab code. `ollama` and the production prompt builder (which
imports ollama at its own module level) are lazy-imported inside
_load_prompt_api()/make_ollama_chat_fn(), so `import
evaluation.scripts.compare_reorganise_planning` stays cheap and every
unit test injects a fake chat function instead — no unit test can reach a
real Ollama call.

Two explicit stages, never chained automatically:

  screen     Stage 1. Simple fixture first, all four candidates x both
             modes, EXACTLY ONE planner invocation per case and no
             recovery. Only pairs passing the call/syntactic/semantic/
             latency gates advance to the crowded 28-item fixture, where
             the additional trivial-plan gate also applies. Prints the
             surviving pairs; never promotes them itself.

  stability  Stage 2. Requires finalist pairs to be named explicitly on
             the command line (at most two — it never picks them), and
             runs each over three predetermined distinct seeds through
             the real plan_reorganisation(), so its one bounded recovery
             attempt and its provenance/fallback behaviour are genuinely
             exercised.

Manual usefulness review is deliberately NOT computed here. Every result
carries a null-filled manual_review block for a human to fill in; a
syntactically perfect plan that dumps all 28 items into one zone is
rejected automatically (is_trivial_plan), but "is this plan actually
useful" is a judgement this harness never fabricates a score for.

Usage (no inference happens until one of these is run):
    python -m evaluation.scripts.compare_reorganise_planning screen --out results.json
    python -m evaluation.scripts.compare_reorganise_planning stability \\
        --finalist phi4-mini:schema --finalist qwen3:8b:plain --out stability.json

A finalist spec is `model:mode`. Ollama model tags contain colons, so the
mode is the FINAL segment and the model is everything before it:
`qwen3:8b:plain` means model `qwen3:8b`, mode `plain`.
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from app.core.json_repair import extract_json_detailed
from app.core.reorganise_schemas import ReorganisePlan
from app.core.reorganise_semantic_conversion import parse_and_validate_plan
from app.core.schemas import DetectedItem, validate_unique_item_ids
from app.services.reorganise_service import plan_reorganisation

# --- fixed experiment bounds ------------------------------------------

CANDIDATE_MODELS: tuple[str, ...] = ("phi4-mini", "qwen3:8b", "mistral", "gemma2:2b")
MODES: tuple[str, ...] = ("plain", "schema")

# Hard per-call wall-clock bound, deliberately just above the selection
# gate: a call that misses the 180s gate is still measured and scored as a
# failure (rather than being killed exactly at the threshold, which would
# make "slow" and "timed out" indistinguishable in the data), but it can
# never run away the way the unbounded production client did.
REQUEST_TIMEOUT_S: float = 210.0
LATENCY_GATE_S: float = 180.0

# Derived from the measured serialized size of a realistic valid 28-item
# plan (5 zones, real instruction text, an image_prompt naming all 28
# labels with positions): 1901 chars compact / 2374 pretty-printed, i.e.
# roughly 475-634 / 594-791 tokens at 4.0-3.0 chars per token. Allowing
# for markdown fences and a stray preamble puts the realistic worst case
# near 900 tokens; 1536 leaves ~1.7x headroom over that, so truncating a
# genuinely valid 28-item plan is implausible, while still stopping a
# runaway well before the wall-clock bound.
NUM_PREDICT: int = 1536

# Predetermined and distinct — repeating one seed measures nothing about
# stability. Fixed here (not randomised per run) so a stability run is
# reproducible.
STABILITY_SEEDS: tuple[int, ...] = (11, 22, 33)
MAX_STABILITY_FINALISTS = 2

# Matches this codebase's existing bounded-detail convention.
_MAX_ERROR_DETAIL_LENGTH = 300
_TRUNCATION_SUFFIX = "…(truncated)"

Mode = Literal["plain", "schema"]
ErrorKind = Literal["timeout", "call_failed"]


def _bounded(text: str, limit: int = _MAX_ERROR_DETAIL_LENGTH) -> str:
    if len(text) <= limit:
        return text
    keep = max(0, limit - len(_TRUNCATION_SUFFIX))
    return text[:keep] + _TRUNCATION_SUFFIX


def _load_prompt_api() -> tuple[Callable[..., str], str]:
    """Lazy-imports production's prompt builder and prompt version.

    Deferred rather than imported at module level because
    app.models.reorganise_llm imports ollama at ITS module level — this
    keeps `import evaluation.scripts.compare_reorganise_planning` free of
    the ollama dependency surface, matching evaluation/scripts/batch_eval.py's
    own lazy-import convention.
    """
    from app.models.reorganise_llm import REORGANISE_PROMPT_VERSION, build_reorganise_plan_prompt

    return build_reorganise_plan_prompt, REORGANISE_PROMPT_VERSION


def reorganise_plan_schema() -> dict:
    """The PRODUCTION schema, passed to Ollama exactly as pydantic emits
    it — no inlined $refs, no stripped descriptions, no second
    hand-written schema. If constrained decoding copes badly with $defs
    or with the long docstring descriptions, that is a real finding about
    schema mode's viability here and must show up in the results, not be
    hidden by pre-emptively rewriting the schema."""
    return ReorganisePlan.model_json_schema()


# --- fixtures -----------------------------------------------------------


@dataclass(frozen=True)
class PlannerFixture:
    """A frozen planning input: the exact selected_items/scene_label/
    user_context a planner call receives. Carries no image, no boxes that
    matter, and no detection dependency — loading one never touches CLIP,
    Grounding DINO or /upload."""

    name: str
    scene_label: str
    user_context: str | None
    items: list[DetectedItem]
    provenance: dict

    @property
    def item_ids(self) -> list[str]:
        return [item.item_id for item in self.items]


def load_fixture(path: Path) -> PlannerFixture:
    """Strict: every required key must be present, every item must satisfy
    production's own DetectedItem schema, and item_ids must be unique
    (checked with production's validate_unique_item_ids, not a second
    hand-rolled rule). Raises ValueError — never a bare KeyError/
    ValidationError — so a malformed fixture fails with a message that
    names the fixture."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"fixture {path} could not be read as JSON: {type(exc).__name__}") from exc

    if not isinstance(raw, dict):
        raise ValueError(f"fixture {path} must be a JSON object")

    for key in ("fixture_name", "scene_label", "user_context", "items"):
        if key not in raw:
            raise ValueError(f"fixture {path} is missing required key {key!r}")

    scene_label = raw["scene_label"]
    if not isinstance(scene_label, str) or not scene_label.strip():
        raise ValueError(f"fixture {path}: scene_label must be a non-blank string")

    user_context = raw["user_context"]
    if user_context is not None and not isinstance(user_context, str):
        raise ValueError(f"fixture {path}: user_context must be null or a string")

    raw_items = raw["items"]
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError(f"fixture {path}: items must be a non-empty list")

    items: list[DetectedItem] = []
    for index, raw_item in enumerate(raw_items):
        try:
            items.append(DetectedItem.model_validate(raw_item))
        except Exception as exc:
            raise ValueError(f"fixture {path}: items[{index}] is not a valid DetectedItem: {exc}") from exc

    try:
        validate_unique_item_ids(items)
    except ValueError as exc:
        raise ValueError(f"fixture {path}: {exc}") from exc

    return PlannerFixture(
        name=str(raw["fixture_name"]),
        scene_label=scene_label,
        user_context=user_context,
        items=items,
        provenance=raw.get("provenance", {}),
    )


# --- the evaluation-layer planner ---------------------------------------


@dataclass
class EvalPlannerResult:
    """Structurally identical to app.models.reorganise_llm.ReorganiseLLMResult
    — satisfies reorganise_service.ReorganiseLLMResultLike, so
    plan_reorganisation() consumes it with no adapter."""

    raw_text: str
    parsed_json: dict | list | None
    is_valid_json: bool
    was_repaired: bool
    model_name: str
    prompt_version: str


class PlannerCallError(RuntimeError):
    """A transport-level failure from one planner invocation, classified
    as a timeout or a generic call failure. Carries only a fixed,
    sanitized detail — see _sanitized_error_detail."""

    def __init__(self, kind: ErrorKind, detail: str) -> None:
        super().__init__(detail)
        self.kind: ErrorKind = kind
        self.detail = detail


# The complete, closed set of ways a 2xx-but-unusable Ollama response can
# be malformed. These strings are authored here, never derived from the
# response itself, so putting one in a result artefact cannot leak
# response content.
MalformedReason = Literal["missing_message", "message_not_object", "missing_content", "content_not_string"]


class MalformedResponseError(ValueError):
    """The chat call returned successfully but the response is not the
    {"message": {"content": <str>}} shape this harness needs.

    Deliberately does NOT carry the offending object (or any part of it):
    a malformed response is still model output, and the point of the
    sanitization rule is that nothing but authored text reaches the
    result artefact on a failure path. The usable-response path retains
    raw text on purpose; this path has no usable text to retain."""

    def __init__(self, reason: MalformedReason) -> None:
        super().__init__(reason)
        self.reason: MalformedReason = reason


def extract_message_content(response: Any) -> str:
    """Defensive accessor for response["message"]["content"].

    Exists because the naive chained subscript raises KeyError/TypeError
    from OUTSIDE the protected transport block, which would abort an
    entire screen run partway through on one bad response — losing every
    case that had not run yet, for a failure that is itself a finding
    worth recording.
    """
    if not isinstance(response, dict) or "message" not in response:
        raise MalformedResponseError("missing_message")
    message = response["message"]
    if not isinstance(message, dict):
        raise MalformedResponseError("message_not_object")
    if "content" not in message:
        raise MalformedResponseError("missing_content")
    content = message["content"]
    if not isinstance(content, str):
        raise MalformedResponseError("content_not_string")
    return content


def classify_call_error(exc: BaseException) -> ErrorKind:
    """Timeout vs any other failure, decided by exception type name across
    the whole class hierarchy (httpx.ReadTimeout, httpx.ConnectTimeout,
    TimeoutError, ...) rather than by importing httpx here — keeps this
    module's import surface minimal while still classifying the case the
    210s bound exists to catch. A malformed response is not a timeout, so
    it classifies as call_failed."""
    for klass in type(exc).__mro__:
        if "timeout" in klass.__name__.lower():
            return "timeout"
    return "call_failed"


def _sanitized_error_detail(kind: ErrorKind, exc: BaseException) -> str:
    """A FIXED message built only from the exception's type name and this
    harness's own classification — never str(exc).

    An exception's own text is attacker-of-convenience data: httpx and
    ollama errors routinely embed the request URL (which here is the
    ngrok/Ollama host), and an arbitrary library could embed request
    body fragments, i.e. the prompt. A type name is a class identifier,
    not data, so it is safe to record; the message never is.
    """
    type_name = type(exc).__name__
    if isinstance(exc, MalformedResponseError):
        return _bounded(f"malformed planner response ({type_name}: {exc.reason})")
    if kind == "timeout":
        return _bounded(f"planner call timed out ({type_name})")
    return _bounded(f"planner call failed ({type_name})")


def make_ollama_chat_fn(host: str, timeout_s: float = REQUEST_TIMEOUT_S) -> Callable[..., Any]:
    """The real transport, built only when an actual run needs it — never
    during import, never during unit tests (which inject a fake instead).
    The timeout is set on the CLIENT because that is where the installed
    ollama client accepts one; its own default is None (no request
    timeout at all), which is exactly the unbounded behaviour production
    currently has and this harness must not inherit."""
    import ollama

    client = ollama.Client(host=host, timeout=timeout_s)
    return client.chat


class EvalPlanner:
    """Satisfies app.services.reorganise_service.ReorganisePlanner, so it
    can be injected straight into the real plan_reorganisation().

    Reuses production's prompt builder and JSON extractor verbatim; the
    ONLY deliberate divergences from production's own
    generate_reorganise_plan_once() are the experiment variables:
    `format=` in schema mode, options.num_predict, options.seed, and the
    client timeout.

    Every invocation is recorded in `self.invocations` so a caller (and
    the tests) can assert exact call accounting — how many calls were
    made, which carried validation_feedback (i.e. were recovery
    attempts), and each one's own latency.
    """

    def __init__(
        self,
        model_name: str,
        mode: Mode,
        *,
        chat_fn: Callable[..., Any],
        seed: int | None = None,
        temperature: float = 0.2,
        num_predict: int = NUM_PREDICT,
        timeout_s: float = REQUEST_TIMEOUT_S,
    ) -> None:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}, got {mode!r}")
        self.model_name = model_name
        self.mode: Mode = mode
        self.chat_fn = chat_fn
        self.seed = seed
        self.temperature = temperature
        self.num_predict = num_predict
        self.timeout_s = timeout_s
        self.invocations: list[dict] = []

    def build_options(self) -> dict:
        options: dict[str, Any] = {"temperature": self.temperature, "num_predict": self.num_predict}
        if self.seed is not None:
            options["seed"] = self.seed
        return options

    def __call__(
        self,
        run_id: str,
        selected_items: list[DetectedItem],
        scene_label: str,
        user_context: str | None,
        validation_feedback: list[str] | None = None,
        model_name: str | None = None,
    ) -> EvalPlannerResult:
        build_prompt, prompt_version = _load_prompt_api()
        prompt = build_prompt(selected_items, scene_label, user_context, validation_feedback)

        kwargs: dict[str, Any] = {
            "model": model_name or self.model_name,
            "messages": [{"role": "user", "content": prompt}],
            "options": self.build_options(),
        }
        if self.mode == "schema":
            kwargs["format"] = reorganise_plan_schema()

        started = time.perf_counter()
        record: dict[str, Any] = {
            "index": len(self.invocations),
            "is_recovery": validation_feedback is not None,
            "model": kwargs["model"],
            "mode": self.mode,
            "seed": self.seed,
            "options": dict(kwargs["options"]),
            "timeout_s": self.timeout_s,
            "format_sent": "format" in kwargs,
        }
        try:
            response = self.chat_fn(**kwargs)
            # Inside the protected block deliberately: a 2xx-but-malformed
            # response must become a recorded call_failed result, never an
            # uncaught KeyError/TypeError that aborts the whole run.
            raw_text = extract_message_content(response)
        except Exception as exc:  # noqa: BLE001 — classified, sanitized, re-raised as PlannerCallError
            kind = classify_call_error(exc)
            record.update(
                {
                    "latency_s": round(time.perf_counter() - started, 3),
                    "call_success": False,
                    "error_kind": kind,
                    "error_detail": _sanitized_error_detail(kind, exc),
                    # No raw_response on this path: for a malformed
                    # response the only text available IS the malformed
                    # object, which must not be exposed.
                    "raw_response": None,
                }
            )
            self.invocations.append(record)
            # No retry here, deliberately: the harness never retries a
            # call at this layer. plan_reorganisation()'s own single
            # bounded recovery attempt (stability stage only) is the one
            # documented exception, and it is that function's decision,
            # not this planner's.
            raise PlannerCallError(kind, record["error_detail"]) from exc

        extraction = extract_json_detailed(raw_text)
        record.update(
            {
                "latency_s": round(time.perf_counter() - started, 3),
                "call_success": True,
                "error_kind": None,
                "error_detail": None,
                "raw_response": raw_text,
                "syntactic_valid": extraction.is_valid,
                "mechanically_repaired": extraction.was_repaired,
            }
        )
        self.invocations.append(record)

        return EvalPlannerResult(
            raw_text=raw_text,
            parsed_json=extraction.parsed,
            is_valid_json=extraction.is_valid,
            was_repaired=extraction.was_repaired,
            model_name=kwargs["model"],
            prompt_version=prompt_version,
        )


# --- metrics -------------------------------------------------------------


def id_accounting(parsed_json: Any, selected_item_ids: list[str]) -> dict:
    """Missing / unexpected / duplicate item_id accounting computed
    defensively from the RAW parsed JSON, not from a validated
    ReorganisePlan.

    Deliberately not derived from the validated plan: ReorganisePlan's own
    validator REJECTS a plan that repeats an item_id across zones, so by
    the time a plan validates, a cross-zone duplicate can no longer be
    observed. Reading the raw structure is what makes "the model
    duplicated item_007" reportable as a distinct failure mode instead of
    collapsing into an opaque malformed_plan.
    """
    selected = set(selected_item_ids)
    collected: list[str] = []
    shape_usable = False

    if isinstance(parsed_json, dict):
        zones = parsed_json.get("zones")
        if isinstance(zones, list):
            shape_usable = True
            for zone in zones:
                if not isinstance(zone, dict):
                    continue
                zone_ids = zone.get("item_ids")
                if not isinstance(zone_ids, list):
                    continue
                collected.extend(i for i in zone_ids if isinstance(i, str))

    seen: dict[str, int] = {}
    for item_id in collected:
        seen[item_id] = seen.get(item_id, 0) + 1

    return {
        "shape_usable": shape_usable,
        "missing_ids": sorted(selected - set(collected)),
        "unexpected_ids": sorted(set(collected) - selected),
        "duplicate_ids": sorted(i for i, n in seen.items() if n > 1),
        "coverage_exact": shape_usable and set(collected) == selected and len(collected) == len(selected),
    }


def is_trivial_plan(parsed_json: Any, selected_item_ids: list[str]) -> bool:
    """True when every selected item is placed in ONE zone — a
    syntactically perfect but useless plan. Rejected automatically on the
    crowded fixture; meaningless on the simple fixture (where a single
    zone can be a legitimate answer), so callers only apply it where it
    belongs."""
    if not isinstance(parsed_json, dict):
        return False
    zones = parsed_json.get("zones")
    if not isinstance(zones, list) or len(zones) != 1:
        return False
    zone = zones[0]
    if not isinstance(zone, dict):
        return False
    zone_ids = zone.get("item_ids")
    if not isinstance(zone_ids, list):
        return False
    return set(i for i in zone_ids if isinstance(i, str)) == set(selected_item_ids)


def plan_partition_signature(parsed_json: Any) -> list[list[str]] | None:
    """A canonical signature of HOW a plan groups items, independent of
    presentation.

    Deliberately ignores zone order, zone names and instruction wording:
    the same grouping described as "Desk workspace" in one run and "Work
    area" in the next is the SAME plan structurally, and a naive
    comparison would report that as instability when nothing about the
    grouping changed. Each zone becomes its sorted set of item_ids, and
    the groups themselves are sorted, so two runs that group items
    identically produce an identical signature.

    Returns None when the shape is unusable (no comparable structure).
    Empty zones are dropped — they carry no membership information.
    """
    if not isinstance(parsed_json, dict):
        return None
    zones = parsed_json.get("zones")
    if not isinstance(zones, list):
        return None

    groups: list[list[str]] = []
    for zone in zones:
        if not isinstance(zone, dict):
            continue
        zone_ids = zone.get("item_ids")
        if not isinstance(zone_ids, list):
            continue
        members = sorted({i for i in zone_ids if isinstance(i, str)})
        if members:
            groups.append(members)

    groups.sort()
    return groups


def summarize_finalist(model_name: str, mode: Mode, cases: list[dict]) -> dict:
    """Aggregates one finalist's repeats into the evidence a go/no-go
    decision actually needs.

    Partition stability and manual usefulness are reported ALONGSIDE
    passes_core_gates, never folded into it: a candidate can group items
    differently on every seed and still be objectively correct every
    time, and that trade-off is a human decision, not something this
    function should silently resolve by failing the candidate.
    """
    case_count = len(cases)
    exact_coverage_count = sum(1 for c in cases if c.get("coverage_exact"))
    recovery_count = sum(1 for c in cases if c.get("provenance") == "recovery_used")
    fallback_count = sum(1 for c in cases if c.get("provenance") == "deterministic_fallback")
    trivial_count = sum(1 for c in cases if c.get("is_trivial_plan"))
    timeout_count = sum(1 for c in cases if c.get("timeout_invocations"))
    call_failure_count = sum(1 for c in cases if c.get("failed_invocations"))

    latencies = [c["total_latency_s"] for c in cases if c.get("total_latency_s") is not None]
    max_total_latency_s = max(latencies) if latencies else None

    signatures = [
        {
            "seed": c.get("seed"),
            "provenance": c.get("provenance"),
            "from_model": c.get("provenance") != "deterministic_fallback",
            "signature": c.get("partition_signature"),
        }
        for c in cases
    ]

    # Only model-produced plans can say anything about the MODEL's
    # stability — the deterministic fallback is identical by
    # construction, so counting it would manufacture a "stable" verdict
    # out of the model having failed twice. Fewer than two such plans is
    # reported as None (unknown), never as True.
    model_signatures = [s["signature"] for s in signatures if s["from_model"] and s["signature"] is not None]
    if len(model_signatures) < 2:
        partition_stable = None
    else:
        partition_stable = all(sig == model_signatures[0] for sig in model_signatures)

    # "The initial attempt never sufficed in any repeat" — covers both
    # recovery_used and deterministic_fallback, since both mean a second
    # call was required. The individual counts above disambiguate which.
    systematic_recovery = case_count > 0 and all(c.get("attempts") == 2 for c in cases)

    core_gate_failures: list[str] = []
    if case_count == 0:
        core_gate_failures.append("no_cases")
    if exact_coverage_count != case_count:
        core_gate_failures.append("coverage_not_exact")
    if fallback_count:
        core_gate_failures.append("deterministic_fallback")
    if trivial_count:
        core_gate_failures.append("trivial_plan")
    if timeout_count:
        core_gate_failures.append("timeout")
    if call_failure_count:
        core_gate_failures.append("call_failure")
    if any(latency > LATENCY_GATE_S for latency in latencies):
        core_gate_failures.append("latency_gate")

    return {
        "model": model_name,
        "mode": mode,
        "case_count": case_count,
        "exact_coverage_count": exact_coverage_count,
        "recovery_count": recovery_count,
        "deterministic_fallback_count": fallback_count,
        "trivial_plan_count": trivial_count,
        "timeout_count": timeout_count,
        "call_failure_count": call_failure_count,
        "max_total_latency_s": max_total_latency_s,
        "partition_signatures": signatures,
        # Separate evidence, deliberately NOT part of passes_core_gates.
        "partition_stable_across_seeds": partition_stable,
        "systematic_recovery": systematic_recovery,
        "passes_core_gates": not core_gate_failures,
        "core_gate_failures": core_gate_failures,
        "_note": (
            "passes_core_gates covers exact coverage, no deterministic fallback, no trivial plan, "
            "no timeout/call failure, and every total latency <= "
            f"{LATENCY_GATE_S}s. partition_stable_across_seeds and the manual usefulness review on "
            "each case are separate evidence and are never folded into it."
        ),
    }


def manual_review_block() -> dict:
    """Five unscored fields for a human reviewer. Never computed, never
    defaulted to a number — a fabricated usefulness score would be worse
    than none at all."""
    return {
        "_instructions": "Scored manually by a human reviewer. This harness never computes these.",
        "meaningful_zones_instructions": None,
        "actionable_improvement": None,
        "user_context_adherence": None,
        "no_invented_items_or_architecture": None,
        "understandable_non_contradictory": None,
    }


# --- stage 1: screen ------------------------------------------------------


def evaluate_screen_case(
    fixture: PlannerFixture,
    model_name: str,
    mode: Mode,
    planner_factory: Callable[[str, Mode, int | None], EvalPlanner],
    *,
    apply_trivial_gate: bool,
) -> dict:
    """EXACTLY ONE planner invocation. No recovery, no retry — this stage
    deliberately does not touch plan_reorganisation(), so a candidate is
    judged on what it produces unaided."""
    planner = planner_factory(model_name, mode, None)
    started = time.perf_counter()

    result: dict[str, Any] = {
        "stage": "screen",
        "fixture": fixture.name,
        "model": model_name,
        "mode": mode,
        "seed": None,
        "timeout_s": planner.timeout_s,
        "num_predict": planner.num_predict,
        "options": planner.build_options(),
        "attempts": 1,
        "prompt_version": None,
        "call_success": False,
        "error_kind": None,
        "error_detail": None,
        "raw_response": None,
        "syntactic_valid": False,
        "mechanically_repaired": False,
        "semantic_valid": False,
        "semantic_errors": [],
        "coverage_exact": False,
        "missing_ids": [],
        "unexpected_ids": [],
        "duplicate_ids": [],
        "is_trivial_plan": None,
        "latency_s": None,
        "manual_review": manual_review_block(),
    }

    try:
        planner_result = planner(
            run_id="eval-screen",
            selected_items=fixture.items,
            scene_label=fixture.scene_label,
            user_context=fixture.user_context,
        )
    except PlannerCallError as exc:
        result["latency_s"] = round(time.perf_counter() - started, 3)
        result["error_kind"] = exc.kind
        result["error_detail"] = exc.detail
        result["invocations"] = planner.invocations
        result["gate_failures"] = [exc.kind]
        result["passed_gates"] = False
        return result

    result["latency_s"] = round(time.perf_counter() - started, 3)
    result["call_success"] = True
    result["prompt_version"] = planner_result.prompt_version
    result["raw_response"] = planner_result.raw_text
    result["syntactic_valid"] = planner_result.is_valid_json
    result["mechanically_repaired"] = planner_result.was_repaired

    accounting = id_accounting(planner_result.parsed_json, fixture.item_ids)
    result["missing_ids"] = accounting["missing_ids"]
    result["unexpected_ids"] = accounting["unexpected_ids"]
    result["duplicate_ids"] = accounting["duplicate_ids"]
    result["coverage_exact"] = accounting["coverage_exact"]

    if planner_result.is_valid_json:
        conversion = parse_and_validate_plan(planner_result.parsed_json, fixture.item_ids)
        result["semantic_valid"] = conversion.is_valid
        result["semantic_errors"] = [
            {"kind": e.kind, "detail": _bounded(e.detail), "item_ids": e.item_ids} for e in conversion.errors
        ]

    if apply_trivial_gate:
        result["is_trivial_plan"] = is_trivial_plan(planner_result.parsed_json, fixture.item_ids)

    gate_failures: list[str] = []
    if not result["syntactic_valid"]:
        gate_failures.append("syntactic_invalid")
    if not result["semantic_valid"]:
        gate_failures.append("semantic_invalid")
    if result["latency_s"] is not None and result["latency_s"] > LATENCY_GATE_S:
        gate_failures.append("latency_gate")
    if apply_trivial_gate and result["is_trivial_plan"]:
        gate_failures.append("trivial_plan")

    result["gate_failures"] = gate_failures
    result["passed_gates"] = not gate_failures
    result["invocations"] = planner.invocations
    return result


def run_screen(
    simple_fixture: PlannerFixture,
    crowded_fixture: PlannerFixture,
    planner_factory: Callable[[str, Mode, int | None], EvalPlanner],
    *,
    models: tuple[str, ...] = CANDIDATE_MODELS,
    modes: tuple[str, ...] = MODES,
    save: Callable[[dict], None] | None = None,
) -> dict:
    """Progressive: every (model, mode) pair meets the SIMPLE fixture
    first, and only pairs that pass its gates are given the crowded
    28-item fixture. A candidate that cannot plan four unambiguous items
    never costs a crowded-fixture call."""
    report: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "stage": "screen",
        "status": "in_progress",
        "bounds": {
            "timeout_s": REQUEST_TIMEOUT_S,
            "num_predict": NUM_PREDICT,
            "latency_gate_s": LATENCY_GATE_S,
        },
        "fixtures": {
            "simple": {"name": simple_fixture.name, "n_items": len(simple_fixture.items)},
            "crowded": {"name": crowded_fixture.name, "n_items": len(crowded_fixture.items)},
        },
        "simple_cases": [],
        "crowded_cases": [],
        "survivors": [],
    }

    def _save() -> None:
        if save is not None:
            save(report)

    _save()

    survivors: list[tuple[str, str]] = []
    for model_name in models:
        for mode in modes:
            case = evaluate_screen_case(
                simple_fixture, model_name, mode, planner_factory, apply_trivial_gate=False
            )
            report["simple_cases"].append(case)
            if case["passed_gates"]:
                survivors.append((model_name, mode))
            _save()

    for model_name, mode in survivors:
        case = evaluate_screen_case(
            crowded_fixture, model_name, mode, planner_factory, apply_trivial_gate=True
        )
        report["crowded_cases"].append(case)
        _save()

    report["survivors"] = [
        {"model": c["model"], "mode": c["mode"]} for c in report["crowded_cases"] if c["passed_gates"]
    ]
    report["status"] = "complete"
    _save()
    return report


# --- stage 2: stability ---------------------------------------------------


def parse_finalist(spec: str) -> tuple[str, Mode]:
    """`model:mode`, e.g. `phi4-mini:schema` or `qwen3:8b:schema`.

    Split from the RIGHT, not the left: Ollama model identifiers legally
    contain a colon (`qwen3:8b` is one of this harness's own candidates),
    so a left split would read that tag as the mode and reject a real
    model. The mode is always the final segment.

    Both halves are validated against the harness's own closed sets
    before anything else happens, so an unknown model or a malformed mode
    fails at argument-parsing time — never after a client has been built
    or a call issued.
    """
    if ":" not in spec:
        raise ValueError(f"finalist must be 'model:mode', got {spec!r}")
    model_name, mode = spec.rsplit(":", 1)
    model_name, mode = model_name.strip(), mode.strip()
    if not model_name:
        raise ValueError(f"finalist {spec!r} has an empty model name")
    if model_name not in CANDIDATE_MODELS:
        raise ValueError(f"finalist {spec!r} names an unknown model; expected one of {CANDIDATE_MODELS}")
    if mode not in MODES:
        raise ValueError(f"finalist {spec!r} has an unknown mode; expected one of {MODES}")
    return model_name, mode  # type: ignore[return-value]


def evaluate_stability_case(
    fixture: PlannerFixture,
    model_name: str,
    mode: Mode,
    seed: int,
    planner_factory: Callable[[str, Mode, int | None], EvalPlanner],
) -> dict:
    """Runs the REAL production plan_reorganisation() with this planner
    injected, so the initial attempt, the one bounded recovery attempt,
    provenance assignment and deterministic fallback are all production's
    own behaviour — not reimplemented here. Consequently this case may
    issue up to TWO invocations."""
    planner = planner_factory(model_name, mode, seed)
    started = time.perf_counter()

    result: dict[str, Any] = {
        "stage": "stability",
        "fixture": fixture.name,
        "model": model_name,
        "mode": mode,
        "seed": seed,
        "timeout_s": planner.timeout_s,
        "num_predict": planner.num_predict,
        "options": planner.build_options(),
        "manual_review": manual_review_block(),
    }

    planning = plan_reorganisation(
        run_id="eval-stability",
        selected_items=fixture.items,
        scene_label=fixture.scene_label,
        user_context=fixture.user_context,
        llm_planner=planner,
    )

    total_latency_s = round(time.perf_counter() - started, 3)
    plan_json = planning.plan.model_dump()
    accounting = id_accounting(plan_json, fixture.item_ids)

    result.update(
        {
            "provenance": planning.provenance.value,
            "attempts": planning.attempts,
            "prompt_version": planning.prompt_version,
            "reported_model_name": planning.model_name,
            "used_recovery": planning.provenance.value == "recovery_used",
            "used_deterministic_fallback": planning.provenance.value == "deterministic_fallback",
            "issues": [
                {
                    "attempt": issue.attempt,
                    "kind": issue.kind,
                    "detail": _bounded(issue.detail),
                    "conversion_errors": [
                        {"kind": e.kind, "detail": _bounded(e.detail), "item_ids": e.item_ids}
                        for e in issue.conversion_errors
                    ],
                }
                for issue in planning.issues
            ],
            "coverage_exact": accounting["coverage_exact"],
            "missing_ids": accounting["missing_ids"],
            "unexpected_ids": accounting["unexpected_ids"],
            "duplicate_ids": accounting["duplicate_ids"],
            "is_trivial_plan": is_trivial_plan(plan_json, fixture.item_ids),
            "partition_signature": plan_partition_signature(plan_json),
            "n_zones": len(planning.plan.zones),
            "invocation_count": len(planner.invocations),
            "attempt_latencies_s": [inv.get("latency_s") for inv in planner.invocations],
            "total_latency_s": total_latency_s,
            "stage_timing_ms": planning.stage_timings[0].duration_ms,
            # Transport-level failure counts, read back from the planner's
            # own invocation log — plan_reorganisation() absorbs a
            # PlannerCallError into a call_failed issue, so these would
            # otherwise be invisible in the case record.
            "timeout_invocations": sum(1 for inv in planner.invocations if inv.get("error_kind") == "timeout"),
            "failed_invocations": sum(
                1 for inv in planner.invocations if inv.get("error_kind") == "call_failed"
            ),
            "invocations": planner.invocations,
        }
    )
    return result


def run_stability(
    crowded_fixture: PlannerFixture,
    finalists: list[tuple[str, Mode]],
    planner_factory: Callable[[str, Mode, int | None], EvalPlanner],
    *,
    seeds: tuple[int, ...] = STABILITY_SEEDS,
    save: Callable[[dict], None] | None = None,
) -> dict:
    """Finalists must be supplied explicitly and number at most two —
    this function never selects them from a screen report, so a stability
    run is always a deliberate decision."""
    if not finalists:
        raise ValueError("stability requires at least one explicit finalist (model:mode)")
    if len(finalists) > MAX_STABILITY_FINALISTS:
        raise ValueError(
            f"stability accepts at most {MAX_STABILITY_FINALISTS} finalists, got {len(finalists)}"
        )
    if len(set(finalists)) != len(finalists):
        raise ValueError("stability finalists must be distinct")
    if len(set(seeds)) != len(seeds):
        raise ValueError("stability seeds must be distinct")

    report: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "stage": "stability",
        "status": "in_progress",
        "bounds": {
            "timeout_s": REQUEST_TIMEOUT_S,
            "num_predict": NUM_PREDICT,
            "latency_gate_s": LATENCY_GATE_S,
        },
        "seeds": list(seeds),
        "finalists": [{"model": m, "mode": mo} for m, mo in finalists],
        "fixture": {"name": crowded_fixture.name, "n_items": len(crowded_fixture.items)},
        "cases": [],
        "summaries": [],
    }

    def _refresh_summaries() -> None:
        """Recomputed from whatever cases exist so far, so an interrupted
        run's partial artefact still carries a correct (partial) summary
        rather than a stale or absent one."""
        report["summaries"] = [
            summarize_finalist(
                model_name,
                mode,
                [c for c in report["cases"] if c["model"] == model_name and c["mode"] == mode],
            )
            for model_name, mode in finalists
        ]

    def _save() -> None:
        _refresh_summaries()
        if save is not None:
            save(report)

    _save()

    for model_name, mode in finalists:
        for seed in seeds:
            report["cases"].append(
                evaluate_stability_case(crowded_fixture, model_name, mode, seed, planner_factory)
            )
            _save()

    report["status"] = "complete"
    _save()
    return report


# --- CLI ------------------------------------------------------------------


def default_planner_factory(host: str) -> Callable[[str, Mode, int | None], EvalPlanner]:
    """Builds real, Ollama-backed planners. Only ever called from main()
    — unit tests supply their own factory returning fake-backed planners,
    so no test can reach a real model."""

    def _factory(model_name: str, mode: Mode, seed: int | None) -> EvalPlanner:
        return EvalPlanner(
            model_name,
            mode,
            chat_fn=make_ollama_chat_fn(host, REQUEST_TIMEOUT_S),
            seed=seed,
        )

    return _factory


def _writer(out_path: Path) -> Callable[[dict], None]:
    """Incremental save after every case — a stability run can take an
    hour, and a crash partway through must not lose the cases that
    already completed (same reasoning as compare_llm_reasoning.py's own
    incremental save)."""

    def _save(report: dict) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    return _save


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default=None, help="Ollama host (defaults to app settings)")
    parser.add_argument(
        "--fixtures-dir", type=Path, default=Path("evaluation/fixtures"), help="Directory holding the fixtures"
    )
    sub = parser.add_subparsers(dest="stage", required=True)

    screen = sub.add_parser("screen", help="Stage 1: simple fixture, then crowded for survivors only")
    screen.add_argument("--out", type=Path, required=True, help="Result JSON path (written incrementally)")

    stability = sub.add_parser("stability", help="Stage 2: explicit finalists only, three predetermined seeds")
    stability.add_argument(
        "--finalist",
        action="append",
        default=[],
        metavar="MODEL:MODE",
        help=(
            f"Repeatable; at most {MAX_STABILITY_FINALISTS}. Never inferred from a screen report. "
            "The mode is the final segment, so colon-bearing model tags work: qwen3:8b:plain."
        ),
    )
    stability.add_argument("--out", type=Path, required=True, help="Result JSON path (written incrementally)")

    args = parser.parse_args(argv)

    if args.host is None:
        from app.config import get_settings

        host = get_settings().ollama_host
    else:
        host = args.host

    simple_fixture = load_fixture(args.fixtures_dir / "reorganise_simple.json")
    crowded_fixture = load_fixture(args.fixtures_dir / "reorganise_bedroom02_28items.json")
    factory = default_planner_factory(host)
    save = _writer(args.out)

    if args.stage == "screen":
        report = run_screen(simple_fixture, crowded_fixture, factory, save=save)
        print(f"screen complete -> {args.out}")
        print(f"  simple cases:  {len(report['simple_cases'])}")
        print(f"  crowded cases: {len(report['crowded_cases'])}")
        if report["survivors"]:
            print("  survivors (NOT auto-promoted — pass them to `stability --finalist` yourself):")
            for s in report["survivors"]:
                print(f"    {s['model']}:{s['mode']}")
        else:
            print("  no survivors — see the stop rule: recommend returning the deterministic plan directly.")
        return

    finalists = [parse_finalist(spec) for spec in args.finalist]
    report = run_stability(crowded_fixture, finalists, factory, save=save)
    print(f"stability complete -> {args.out} ({len(report['cases'])} cases)")


if __name__ == "__main__":
    main()
