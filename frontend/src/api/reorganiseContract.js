// Pure functions only, unit-tested (§4), no React/DOM/fetch here. See
// utils/format.js and api/declutterContract.js/confirmationContract.js
// for the same convention. Small LOCAL validation helpers (fail/
// isPlainObject/requireArray/etc. below) are duplicated here rather than
// imported from those files, matching the existing convention that each
// contract file owns its own copies rather than sharing a helpers
// module. normaliseConfirmationResponse (a higher-level normalizer, not
// a small helper) is the one deliberate exception, see job 3 below.
//
// Three jobs live here:
//   1. normaliseReorganiseUploadResponse(), validates POST /upload's
//      path="reorganise" response (see app/api/routes.py's
//      ReorganiseUploadResponse). Deliberately NOT built on top of
//      declutterContract.js's normaliseAnalysisDeclutterEnvelope: that
//      function hard-requires a `declutter` object which the Reorganise
//      response never carries at all, this is a genuinely different
//      envelope, not a variant of the Declutter one.
//   2. normaliseGenerateResponse(), validates POST /generate's response
//      (GenerateResponse) against the exact selected_item_ids that were
//      requested and the input_image_sha256 the upload step reported,
//      both passed in by the caller, exactly like
//      normaliseConfirmationResponse() takes sourceDeclutter to
//      cross-check against.
//   3. normaliseConfirmedGenerateResponse(), validates POST
//      /generate/confirmed's response (ConfirmedGenerateResponse, R6,
//      Both). Reuses validatePlanning()/validateGeneratedImage() below
//      VERBATIM (they're already standalone module-level functions, not
//      inlined into normaliseGenerateResponse) and reuses
//      confirmationContract.js's own normaliseConfirmationResponse()
//      verbatim too, genuine reuse of existing normalizers, not a
//      parallel reimplementation, per this module's own job.
//
// Never merges/joins by label text anywhere in this file, item_id is
// the only identity. Duplicate labels are explicitly legal and remain
// fully independent (see requireNoDuplicates, which only ever runs
// against item_id lists).
//
// A plan-preserving image_status="unavailable" response is a SUCCESSFUL,
// fully validated result here, never thrown as an error. Only a
// genuinely malformed/contract-violating response throws.

import { normaliseConfirmationResponse } from "./confirmationContract";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// Structural base64, not just "valid characters": a correct base64
// string is a sequence of complete 4-character groups, with padding
// ('=') allowed ONLY in the final group (1 or 2 trailing '=' chars,
// never in the middle, never on its own). The earlier
// `^[A-Za-z0-9+/]*={0,2}$` pattern accepted wrong-length strings (e.g.
// length not a multiple of 4) and misplaced padding, this pattern
// rejects both.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;
const ITEM_ID_RE = /^item_\d{3,}$/;
// "deterministic_direct" is the PRODUCTION value: no LLM planner is
// called at all, so the plan is built deterministically from the start.
// Distinct from "deterministic_fallback", which means two planner
// attempts were made and both were rejected, see the per-provenance
// attempt rules enforced below.
const VALID_PROVENANCE = new Set([
  "raw_valid",
  "mechanically_repaired",
  "recovery_used",
  "deterministic_fallback",
  "deterministic_direct",
]);
const VALID_IMAGE_STATUS = new Set(["generated", "unavailable"]);
const VALID_UNAVAILABLE_REASONS = new Set([
  "service_unreachable",
  "timeout",
  "request_failed",
  "service_error",
  "invalid_response",
]);
const VALID_MEDIA_TYPES = new Set(["image/png", "image/jpeg"]);
const VALID_ITEM_ROLES = new Set(["actionable", "contextual"]);
const VALID_ISSUE_ATTEMPTS = new Set(["initial", "recovery"]);
const VALID_ISSUE_KINDS = new Set(["call_failed", "invalid_json", "semantic_invalid"]);
// Matches app.models.image_gen_client.IMAGE_GEN_API_VERSION (R3), the
// generated image's api_version must equal this EXACT value, not merely
// be some non-empty string.
const EXPECTED_IMAGE_API_VERSION = "v1";

function fail(message) {
  throw new Error(`reorganiseContract: ${message}`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArray(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string`);
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== "boolean") fail(`${name} must be a boolean`);
  return value;
}

function requireFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} must be a finite number`);
  return value;
}

function requireInteger(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value)) fail(`${name} must be an integer`);
  return value;
}

function requireRange(value, name, min, max, { minExclusive = false } = {}) {
  const aboveMin = minExclusive ? value > min : value >= min;
  if (!aboveMin || value > max) fail(`${name} must be in ${minExclusive ? "(" : "["}${min}, ${max}]`);
  return value;
}

function requireItemId(value, name) {
  if (typeof value !== "string" || !ITEM_ID_RE.test(value)) {
    fail(`${name} must match ^item_\\d{3,}$, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireSha256Hex(value, name) {
  if (typeof value !== "string" || !SHA256_HEX_RE.test(value)) {
    fail(`${name} must be a 64-character lowercase hexadecimal string`);
  }
  return value;
}

function requireBase64(value, name) {
  if (typeof value !== "string" || value.trim() === "" || !BASE64_RE.test(value)) {
    fail(`${name} must be a non-empty, valid base64 string`);
  }
  return value;
}

function requireNoDuplicates(ids, name) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) fail(`duplicate ${name}: ${JSON.stringify(id)}`);
    seen.add(id);
  }
}

// ---------------------------------------------------------------------------
// 1. normaliseReorganiseUploadResponse
// ---------------------------------------------------------------------------

export function normaliseReorganiseUploadResponse(response) {
  if (!isPlainObject(response)) fail("response must be an object");
  if (response.path !== "reorganise") fail(`expected path "reorganise", got ${JSON.stringify(response.path)}`);

  const runId = requireNonEmptyString(response.run_id, "run_id");

  if (!isPlainObject(response.analysis)) fail("analysis must be an object");
  const { analysis } = response;
  if (analysis.run_id !== runId) fail("analysis.run_id does not match top-level run_id");

  const items = requireArray(analysis.items, "analysis.items");
  const itemIds = items.map((item, i) => {
    if (!isPlainObject(item)) fail(`analysis.items[${i}] must be an object`);
    requireItemId(item.item_id, `analysis.items[${i}].item_id`);

    if (!isPlainObject(item.box)) fail(`analysis.items[${i}].box must be an object`);
    const box = item.box;
    for (const key of ["x1", "y1", "x2", "y2"]) {
      requireRange(
        requireFiniteNumber(box[key], `analysis.items[${i}].box.${key}`),
        `analysis.items[${i}].box.${key}`,
        0,
        1
      );
    }
    if (!(box.x2 > box.x1)) fail(`analysis.items[${i}].box.x2 must be greater than box.x1`);
    if (!(box.y2 > box.y1)) fail(`analysis.items[${i}].box.y2 must be greater than box.y1`);

    requireNonEmptyString(item.clean_label, `analysis.items[${i}].clean_label`);
    requireNonEmptyString(item.effective_label, `analysis.items[${i}].effective_label`);
    requireNonEmptyString(item.position, `analysis.items[${i}].position`);
    requireNonEmptyString(item.relative_size, `analysis.items[${i}].relative_size`);
    if (!VALID_ITEM_ROLES.has(item.item_role)) {
      fail(`analysis.items[${i}].item_role must be "actionable" or "contextual", got ${JSON.stringify(item.item_role)}`);
    }
    requireRange(
      requireFiniteNumber(item.confidence, `analysis.items[${i}].confidence`),
      `analysis.items[${i}].confidence`,
      0,
      1
    );
    return item.item_id;
  });
  // Duplicate LABELS are explicitly legal and never checked here, only
  // item_id (the one real identity) must be unique.
  requireNoDuplicates(itemIds, "analysis.items item_id");

  const inputImageSha256 = requireSha256Hex(response.input_image_sha256, "input_image_sha256");

  return { runId, analysis, items, inputImageSha256 };
}

// ---------------------------------------------------------------------------
// 2. normaliseGenerateResponse
// ---------------------------------------------------------------------------

function validateZone(zone, index) {
  if (!isPlainObject(zone)) fail(`planning.plan.zones[${index}] must be an object`);
  requireNonEmptyString(zone.zone_name, `planning.plan.zones[${index}].zone_name`);
  requireNonEmptyString(zone.instruction, `planning.plan.zones[${index}].instruction`);
  const itemIds = requireArray(zone.item_ids, `planning.plan.zones[${index}].item_ids`);
  if (itemIds.length === 0) fail(`planning.plan.zones[${index}].item_ids must not be empty`);
  itemIds.forEach((id, j) => requireItemId(id, `planning.plan.zones[${index}].item_ids[${j}]`));
  return itemIds;
}

function validatePlanning(planning, runId, selectedItemIds) {
  if (!isPlainObject(planning)) fail("planning must be an object");
  if (planning.run_id !== runId) fail("planning.run_id does not match run_id");

  if (!isPlainObject(planning.plan)) fail("planning.plan must be an object");
  const zones = requireArray(planning.plan.zones, "planning.plan.zones");
  if (zones.length === 0) fail("planning.plan.zones must not be empty");

  const plannedIds = [];
  zones.forEach((zone, i) => {
    plannedIds.push(...validateZone(zone, i));
  });
  requireNoDuplicates(plannedIds, "planned item_id (across zones)");

  // Exact partition against the requested selection, no missing, no
  // unexpected, no duplicate. Re-verified client-side even though R1
  // (parse_and_validate_plan) already guarantees this server-side, the
  // same "never trust a server-side invariant at face value" discipline
  // confirmationContract.js's keepSetMatches check already established.
  const plannedIdSet = new Set(plannedIds);
  const selectedIdSet = new Set(selectedItemIds);
  const missing = selectedItemIds.filter((id) => !plannedIdSet.has(id));
  const unexpected = plannedIds.filter((id) => !selectedIdSet.has(id));
  if (missing.length > 0) fail(`planning.plan omits selected item_id(s): ${JSON.stringify(missing)}`);
  if (unexpected.length > 0) fail(`planning.plan references unselected item_id(s): ${JSON.stringify(unexpected)}`);

  requireNonEmptyString(planning.plan.image_prompt, "planning.plan.image_prompt");
  // null or NON-EMPTY (an empty/whitespace-only string is not a
  // meaningful "no negative prompt" representation, that's what null
  // itself already means).
  if (planning.plan.negative_prompt !== null) {
    requireNonEmptyString(planning.plan.negative_prompt, "planning.plan.negative_prompt");
  }

  if (!VALID_PROVENANCE.has(planning.provenance)) {
    fail(`planning.provenance is not a recognised value: ${JSON.stringify(planning.provenance)}`);
  }
  // Attempt count is provenance-specific, not a single blanket rule.
  // attempts === 0 is valid ONLY for deterministic_direct (no planner was
  // called, so there is no attempt to count); every LLM-derived
  // provenance still requires a real attempt count of 1 or 2, so a
  // response cannot quietly claim zero attempts while also claiming the
  // model produced the plan.
  if (planning.provenance === "deterministic_direct") {
    if (planning.attempts !== 0) {
      fail(
        `planning.attempts must be 0 for deterministic_direct (no planner is called), got ${JSON.stringify(planning.attempts)}`
      );
    }
  } else if (planning.attempts !== 1 && planning.attempts !== 2) {
    fail(
      `planning.attempts must be 1 or 2 for provenance ${JSON.stringify(planning.provenance)}, got ${JSON.stringify(planning.attempts)}`
    );
  }

  const issues = requireArray(planning.issues, "planning.issues");
  issues.forEach((issue, i) => {
    if (!isPlainObject(issue)) fail(`planning.issues[${i}] must be an object`);
    if (!VALID_ISSUE_ATTEMPTS.has(issue.attempt)) {
      fail(`planning.issues[${i}].attempt must be "initial" or "recovery", got ${JSON.stringify(issue.attempt)}`);
    }
    if (!VALID_ISSUE_KINDS.has(issue.kind)) {
      fail(`planning.issues[${i}].kind is not recognised: ${JSON.stringify(issue.kind)}`);
    }
    requireNonEmptyString(issue.detail, `planning.issues[${i}].detail`);
    requireArray(issue.conversion_errors, `planning.issues[${i}].conversion_errors`);
  });

  // Exactly one stage timing, for the "reorganise_plan" stage, matches
  // ReorganisePlanningResult's own enforced invariant (R2), re-verified
  // here since this UI (ReorganiseResult) renders it directly.
  const stageTimings = requireArray(planning.stage_timings, "planning.stage_timings");
  if (stageTimings.length !== 1) {
    fail(`planning.stage_timings must contain exactly one entry, got ${stageTimings.length}`);
  }
  const [timing] = stageTimings;
  if (!isPlainObject(timing)) fail("planning.stage_timings[0] must be an object");
  if (timing.stage !== "reorganise_plan") {
    fail(`planning.stage_timings[0].stage must be "reorganise_plan", got ${JSON.stringify(timing.stage)}`);
  }
  requireRange(
    requireFiniteNumber(timing.duration_ms, "planning.stage_timings[0].duration_ms"),
    "planning.stage_timings[0].duration_ms",
    0,
    Infinity
  );

  const modelName = planning.model_name;
  const promptVersion = planning.prompt_version;
  const bothPresent = typeof modelName === "string" && modelName.trim() !== "" && typeof promptVersion === "string" && promptVersion.trim() !== "";
  const bothNull = modelName === null && promptVersion === null;
  if (!bothPresent && !bothNull) {
    fail("planning.model_name and planning.prompt_version must either both be non-empty strings or both be null");
  }

  // deterministic_direct means NO model ran. A response naming a model or
  // reporting a failed attempt alongside it would be claiming evidence of
  // an LLM call that never happened, rejected rather than displayed.
  if (planning.provenance === "deterministic_direct") {
    if (!bothNull) {
      fail("deterministic_direct requires planning.model_name and planning.prompt_version to both be null, no model was called");
    }
    if (issues.length !== 0) {
      fail(`deterministic_direct requires planning.issues to be empty, no attempt was made to fail, got ${issues.length}`);
    }
  }
}

function validateGeneratedImage(image, expectedInputImageSha256) {
  if (!isPlainObject(image)) fail("image must be an object");

  requireBase64(image.image, "image.image");
  if (!VALID_MEDIA_TYPES.has(image.image_media_type)) {
    fail(`image.image_media_type is not recognised: ${JSON.stringify(image.image_media_type)}`);
  }
  if (image.api_version !== EXPECTED_IMAGE_API_VERSION) {
    fail(`image.api_version must be exactly ${JSON.stringify(EXPECTED_IMAGE_API_VERSION)}, got ${JSON.stringify(image.api_version)}`);
  }
  if (image.depth_map_used !== true) fail("image.depth_map_used must be exactly true");

  requireRange(requireFiniteNumber(image.denoise_strength, "image.denoise_strength"), "image.denoise_strength", 0, 1);
  requireRange(
    requireFiniteNumber(image.controlnet_conditioning_scale, "image.controlnet_conditioning_scale"),
    "image.controlnet_conditioning_scale",
    0,
    2,
    { minExclusive: true }
  );
  // requireInteger's own typeof check already rejects booleans (typeof
  // true/false is "boolean", never "number") before Number.isInteger runs.
  const seed = requireInteger(image.seed, "image.seed");
  requireRange(seed, "image.seed", 0, 2 ** 32 - 1);

  requireNonEmptyString(image.base_model, "image.base_model");
  requireNonEmptyString(image.controlnet_model, "image.controlnet_model");
  requireNonEmptyString(image.service_version, "image.service_version");

  requireRange(requireFiniteNumber(image.generation_ms, "image.generation_ms"), "image.generation_ms", 0, Infinity);

  requireSha256Hex(image.prompt_sha256, "image.prompt_sha256");
  const inputImageSha256 = requireSha256Hex(image.input_image_sha256, "image.input_image_sha256");
  if (inputImageSha256 !== expectedInputImageSha256) {
    fail("image.input_image_sha256 does not match the upload-provided input_image_sha256");
  }
}

export function normaliseGenerateResponse(response, { runId, selectedItemIds, inputImageSha256 }) {
  if (!isPlainObject(response)) fail("response must be an object");

  // Caller-supplied input, not response data, validated with the same
  // rigor as everything else: non-empty, every entry a genuine item_id,
  // no duplicates. A malformed caller-supplied selection should fail
  // loudly here rather than produce a confusing partition mismatch below.
  requireArray(selectedItemIds, "selectedItemIds");
  if (selectedItemIds.length === 0) fail("selectedItemIds must be a non-empty array");
  selectedItemIds.forEach((id, i) => requireItemId(id, `selectedItemIds[${i}]`));
  requireNoDuplicates(selectedItemIds, "selectedItemIds entry");

  const responseRunId = requireNonEmptyString(response.run_id, "run_id");
  if (responseRunId !== runId) fail("response.run_id does not match the expected run_id");

  validatePlanning(response.planning, runId, selectedItemIds);

  if (!VALID_IMAGE_STATUS.has(response.image_status)) {
    fail(`image_status is not "generated" or "unavailable": ${JSON.stringify(response.image_status)}`);
  }

  if (response.image_status === "generated") {
    if (response.image_unavailable_reason !== null) {
      fail("image_unavailable_reason must be null when image_status is generated");
    }
    validateGeneratedImage(response.image, inputImageSha256);
  } else {
    if (response.image !== null) fail("image must be null when image_status is unavailable");
    if (!VALID_UNAVAILABLE_REASONS.has(response.image_unavailable_reason)) {
      fail(`image_unavailable_reason is not recognised: ${JSON.stringify(response.image_unavailable_reason)}`);
    }
  }

  return {
    runId: responseRunId,
    planning: response.planning,
    imageStatus: response.image_status,
    image: response.image,
    imageUnavailableReason: response.image_unavailable_reason,
  };
}

// ---------------------------------------------------------------------------
// 3. normaliseConfirmedGenerateResponse
// ---------------------------------------------------------------------------

// POST /generate/confirmed's response (ConfirmedGenerateResponse, R6,
// Both), see app/api/routes.py: EXTENDS GenerateResponse's shape
// (run_id/planning/image_status/image/image_unavailable_reason) with
// `confirmation`, never reshaping it. This adapter mirrors that
// composition: it validates the shared generation portion with the
// SAME validatePlanning()/validateGeneratedImage() functions
// normaliseGenerateResponse() above already uses (genuine reuse, not a
// parallel copy), and validates `confirmation` with
// confirmationContract.js's own normaliseConfirmationResponse()
// (imported at the top of this file), never a reimplementation of that
// logic either.
//
// `sourceDeclutter` is the exact DeclutterResult the /generate/confirmed
// request was built from (i.e. useBothFlow's own declutter.declutter at
// generate() time), normaliseConfirmationResponse cross-checks the
// returned confirmation against it exactly like /confirm's own response
// already is elsewhere.
//
// `priorConfirmedKeepIds` is the confirmed_keep_ids the client's own
// earlier POST /confirm call already returned for this same
// sourceDeclutter+overrides pair. The server independently re-derives
// confirmed_keep_ids from declutter+overrides (see both_service.py),
// never trusting anything the client sends, so this cross-check catches
// any drift between the two confirm() calls (e.g. a race, or a bug that
// let generate() fire against a stale confirmation) rather than silently
// trusting the fresh server response at face value.
export function normaliseConfirmedGenerateResponse(
  response,
  { runId, sourceDeclutter, priorConfirmedKeepIds, inputImageSha256 }
) {
  if (!isPlainObject(response)) fail("response must be an object");

  const responseRunId = requireNonEmptyString(response.run_id, "run_id");
  if (responseRunId !== runId) fail("response.run_id does not match the expected run_id");

  if (!isPlainObject(response.confirmation)) fail("confirmation must be an object");
  const confirmation = normaliseConfirmationResponse(response.confirmation, sourceDeclutter);
  if (confirmation.runId !== runId) fail("confirmation.run_id does not match the expected run_id");

  requireArray(priorConfirmedKeepIds, "priorConfirmedKeepIds");
  const keepIdsMatchPrior =
    confirmation.confirmedKeepIds.length === priorConfirmedKeepIds.length &&
    confirmation.confirmedKeepIds.every((id, i) => id === priorConfirmedKeepIds[i]);
  if (!keepIdsMatchPrior) {
    fail(
      "response confirmation.confirmed_keep_ids does not match the prior /confirm result, in order, " +
        "the server-derived selection has drifted from what was confirmed"
    );
  }

  // The plan must exactly partition the server-derived confirmed Keep
  // set, never a client-supplied selection (there is none here at all;
  // see generateConfirmedReorganisation in api/client.js).
  validatePlanning(response.planning, runId, confirmation.confirmedKeepIds);

  if (!VALID_IMAGE_STATUS.has(response.image_status)) {
    fail(`image_status is not "generated" or "unavailable": ${JSON.stringify(response.image_status)}`);
  }

  if (response.image_status === "generated") {
    if (response.image_unavailable_reason !== null) {
      fail("image_unavailable_reason must be null when image_status is generated");
    }
    validateGeneratedImage(response.image, inputImageSha256);
  } else {
    if (response.image !== null) fail("image must be null when image_status is unavailable");
    if (!VALID_UNAVAILABLE_REASONS.has(response.image_unavailable_reason)) {
      fail(`image_unavailable_reason is not recognised: ${JSON.stringify(response.image_unavailable_reason)}`);
    }
  }

  return {
    runId: responseRunId,
    confirmation,
    planning: response.planning,
    imageStatus: response.image_status,
    image: response.image,
    imageUnavailableReason: response.image_unavailable_reason,
  };
}
