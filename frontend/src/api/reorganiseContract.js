// Validates Direct and Both upload/generation envelopes against request
// snapshots. item_id is the only identity; duplicate labels remain distinct.
// An unavailable image is valid because the checklist remains usable.

import { normaliseConfirmationResponse } from "./confirmationContract";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// Enforce complete base64 groups and final-group-only padding.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;
const ITEM_ID_RE = /^item_\d{3,}$/;
// Provenance controls the allowed attempts, issues and model metadata.
const VALID_ACTION_PLAN_PROVENANCE = new Set(["llm_generated", "deterministic_fallback", "deterministic_direct"]);
const VALID_ACTION_PLAN_ISSUE_KINDS = new Set(["call_failed", "invalid_json", "invalid_actions"]);
// Exact key sets reject unsupported fields instead of displaying drift.
const MIN_ACTIONS = 1;
const MAX_ACTIONS = 5;
const TITLE_MIN_LENGTH = 3;
const TITLE_MAX_LENGTH = 80;
const INSTRUCTION_MIN_LENGTH = 10;
const INSTRUCTION_MAX_LENGTH = 300;
const ACTION_KEYS = ["instruction", "priority", "title"];
const PHASE_ORDER = ["empty_clean", "sort", "zones", "cables", "maintain"];
const PHASE_TITLES = ["Empty and clean", "Sort", "Set up zones", "Cables", "Keep it tidy"];
const TIDY_PLAN_KEYS = ["phases"];
const TIDY_PHASE_KEYS = ["phase_id", "steps", "title"];
const TIDY_STEP_KEYS = ["item_ids", "step_id", "text"];
const MAX_FOCUS_AREAS = 3;
const VALID_FOCUS_AREA_IDS = new Set(["left", "centre", "right", "other"]);
const FOCUS_AREA_KEYS = ["area_id", "item_ids", "label"];
const MAX_STORAGE_SUGGESTIONS = 3;
const STORAGE_SUGGESTION_KEYS = ["name", "reason", "related_item_ids"];
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
  // Labels may repeat; item_id must not.
  requireNoDuplicates(itemIds, "analysis.items item_id");

  const inputImageSha256 = requireSha256Hex(response.input_image_sha256, "input_image_sha256");

  return { runId, analysis, items, inputImageSha256 };
}

function requireExactKeys(value, keys, name) {
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, i) => key !== keys[i])) {
    fail(`${name} must have exactly the keys ${JSON.stringify(keys)}`);
  }
}

function requireBoundedString(value, name, min, max) {
  requireNonEmptyString(value, name);
  const length = value.trim().length;
  if (length < min || length > max) fail(`${name} must be ${min}..${max} characters after trimming, got ${length}`);
  return value;
}

function validateAction(action, index) {
  const name = `action_plan.actions[${index}]`;
  if (!isPlainObject(action)) fail(`${name} must be an object`);
  requireExactKeys(action, ACTION_KEYS, name);
  // Reject numbering drift rather than silently renumbering.
  const priority = requireInteger(action.priority, `${name}.priority`);
  if (priority !== index + 1) fail(`${name}.priority must be ${index + 1}, got ${priority}`);
  requireBoundedString(action.title, `${name}.title`, TITLE_MIN_LENGTH, TITLE_MAX_LENGTH);
  requireBoundedString(action.instruction, `${name}.instruction`, INSTRUCTION_MIN_LENGTH, INSTRUCTION_MAX_LENGTH);
}

function validateActionPlan(plan, runId) {
  if (!isPlainObject(plan)) fail("action_plan must be an object");
  if (plan.run_id !== runId) fail("action_plan.run_id does not match run_id");

  const actions = requireArray(plan.actions, "action_plan.actions");
  if (actions.length < MIN_ACTIONS || actions.length > MAX_ACTIONS) {
    fail(`action_plan.actions must contain ${MIN_ACTIONS}..${MAX_ACTIONS} entries, got ${actions.length}`);
  }
  actions.forEach(validateAction);

  if (!VALID_ACTION_PLAN_PROVENANCE.has(plan.provenance)) {
    fail(`action_plan.provenance is not a recognised value: ${JSON.stringify(plan.provenance)}`);
  }

  const issues = requireArray(plan.issues, "action_plan.issues");
  issues.forEach((issue, i) => {
    if (!isPlainObject(issue)) fail(`action_plan.issues[${i}] must be an object`);
    if (!VALID_ACTION_PLAN_ISSUE_KINDS.has(issue.kind)) {
      fail(`action_plan.issues[${i}].kind is not recognised: ${JSON.stringify(issue.kind)}`);
    }
    requireNonEmptyString(issue.detail, `action_plan.issues[${i}].detail`);
  });

  requireRange(requireFiniteNumber(plan.duration_ms, "action_plan.duration_ms"), "action_plan.duration_ms", 0, Infinity);

  const modelName = plan.model_name;
  const promptVersion = plan.prompt_version;
  const bothPresent =
    typeof modelName === "string" && modelName.trim() !== "" && typeof promptVersion === "string" && promptVersion.trim() !== "";
  const bothNull = modelName === null && promptVersion === null;
  if (!bothPresent && !bothNull) {
    fail("action_plan.model_name and action_plan.prompt_version must either both be non-empty strings or both be null");
  }

  // At most one model call: provenance must agree with attempts and metadata.
  if (plan.provenance === "deterministic_direct") {
    if (plan.attempts !== 0) fail(`action_plan.attempts must be 0 for deterministic_direct (no model is called), got ${JSON.stringify(plan.attempts)}`);
    if (issues.length !== 0) fail(`deterministic_direct requires action_plan.issues to be empty, no attempt was made to fail, got ${issues.length}`);
    if (!bothNull) fail("deterministic_direct requires action_plan.model_name and action_plan.prompt_version to both be null, no model was called");
    if (plan.was_repaired !== null) fail("deterministic_direct requires action_plan.was_repaired to be null");
  } else {
    if (plan.attempts !== 1) fail(`action_plan.attempts must be 1 for provenance ${JSON.stringify(plan.provenance)}, got ${JSON.stringify(plan.attempts)}`);
    if (plan.provenance === "llm_generated") {
      if (issues.length !== 0) fail(`llm_generated requires action_plan.issues to be empty, got ${issues.length}`);
      if (!bothPresent) fail("llm_generated requires action_plan.model_name and action_plan.prompt_version to be non-empty strings");
      requireBoolean(plan.was_repaired, "action_plan.was_repaired");
    } else {
      if (issues.length !== 1) fail(`deterministic_fallback requires exactly one action_plan issue, got ${issues.length}`);
      if (plan.was_repaired !== null) fail("deterministic_fallback requires action_plan.was_repaired to be null");
      if (bothNull && issues[0].kind !== "call_failed") {
        fail("deterministic_fallback may omit action_plan.model_name and action_plan.prompt_version only when the call itself failed");
      }
    }
  }
}

function validateTidyPlan(plan, allowedItemIds) {
  if (!isPlainObject(plan)) fail("tidy_plan must be an object");
  requireExactKeys(plan, TIDY_PLAN_KEYS, "tidy_plan");
  const phases = requireArray(plan.phases, "tidy_plan.phases");
  if (phases.length < 1 || phases.length > 5) fail("tidy_plan.phases must contain 1..5 entries");
  const allowed = new Set(allowedItemIds);
  let previousPhase = -1;
  const stepIds = [];
  phases.forEach((phase, i) => {
    const name = `tidy_plan.phases[${i}]`;
    if (!isPlainObject(phase)) fail(`${name} must be an object`);
    requireExactKeys(phase, TIDY_PHASE_KEYS, name);
    const order = PHASE_ORDER.indexOf(phase.phase_id);
    if (order < 0 || order <= previousPhase) fail(`${name}.phase_id must be unique and in PHASE_ORDER`);
    previousPhase = order;
    if (phase.title !== PHASE_TITLES[order]) fail(`${name}.title does not match phase_id`);
    const steps = requireArray(phase.steps, `${name}.steps`);
    if (steps.length < 1 || steps.length > 6) fail(`${name}.steps must contain 1..6 entries`);
    steps.forEach((step, j) => {
      const stepName = `${name}.steps[${j}]`;
      if (!isPlainObject(step)) fail(`${stepName} must be an object`);
      requireExactKeys(step, TIDY_STEP_KEYS, stepName);
      if (step.step_id !== `${phase.phase_id}-${j + 1}`) fail(`${stepName}.step_id must match phase order`);
      stepIds.push(step.step_id);
      requireBoundedString(step.text, `${stepName}.text`, 10, 300);
      const ids = requireArray(step.item_ids, `${stepName}.item_ids`);
      ids.forEach((id, k) => {
        requireItemId(id, `${stepName}.item_ids[${k}]`);
        if (!allowed.has(id)) fail(`${stepName} references an item_id outside the reviewed selection`);
      });
      requireNoDuplicates(ids, `${stepName}.item_ids entry`);
    });
  });
  requireNoDuplicates(stepIds, "tidy step_id");
}

// Focus areas are count-ordered and reference selected item_ids once at most.
function validateFocusAreas(focusAreas, selectedItemIds) {
  const areas = requireArray(focusAreas, "focus_areas");
  if (areas.length === 0 || areas.length > MAX_FOCUS_AREAS) {
    fail(`focus_areas must contain 1..${MAX_FOCUS_AREAS} entries, got ${areas.length}`);
  }
  const selectedIdSet = new Set(selectedItemIds);
  const seenIds = [];
  const seenAreaIds = new Set();
  let previousCount = Infinity;
  areas.forEach((area, i) => {
    const name = `focus_areas[${i}]`;
    if (!isPlainObject(area)) fail(`${name} must be an object`);
    requireExactKeys(area, FOCUS_AREA_KEYS, name);
    if (!VALID_FOCUS_AREA_IDS.has(area.area_id)) fail(`${name}.area_id is not recognised: ${JSON.stringify(area.area_id)}`);
    if (seenAreaIds.has(area.area_id)) fail(`duplicate focus area: ${JSON.stringify(area.area_id)}`);
    seenAreaIds.add(area.area_id);
    requireNonEmptyString(area.label, `${name}.label`);
    const ids = requireArray(area.item_ids, `${name}.item_ids`);
    if (ids.length === 0) fail(`${name}.item_ids must not be empty`);
    if (ids.length > previousCount) fail("focus_areas must be ordered by item count, highest first");
    previousCount = ids.length;
    ids.forEach((id, j) => {
      requireItemId(id, `${name}.item_ids[${j}]`);
      if (!selectedIdSet.has(id)) fail(`${name} references unselected item_id ${JSON.stringify(id)}`);
      seenIds.push(id);
    });
  });
  requireNoDuplicates(seenIds, "focus area item_id (across areas)");
}

// Storage suggestions use unique names and selected item_ids only.
function validateStorageSuggestions(suggestions, selectedItemIds) {
  const list = requireArray(suggestions, "storage_suggestions");
  if (list.length > MAX_STORAGE_SUGGESTIONS) {
    fail(`storage_suggestions must contain at most ${MAX_STORAGE_SUGGESTIONS} entries, got ${list.length}`);
  }
  const selectedIdSet = new Set(selectedItemIds);
  const seenNames = new Set();
  list.forEach((suggestion, i) => {
    const name = `storage_suggestions[${i}]`;
    if (!isPlainObject(suggestion)) fail(`${name} must be an object`);
    requireExactKeys(suggestion, STORAGE_SUGGESTION_KEYS, name);
    const title = requireNonEmptyString(suggestion.name, `${name}.name`);
    requireNonEmptyString(suggestion.reason, `${name}.reason`);
    const normalised = title.trim().toLowerCase();
    if (seenNames.has(normalised)) fail(`duplicate storage suggestion name: ${JSON.stringify(title)}`);
    seenNames.add(normalised);
    const ids = requireArray(suggestion.related_item_ids, `${name}.related_item_ids`);
    if (ids.length === 0) fail(`${name}.related_item_ids must not be empty`);
    ids.forEach((id, j) => requireItemId(id, `${name}.related_item_ids[${j}]`));
    requireNoDuplicates(ids, `${name}.related_item_ids entry`);
    const unselected = ids.filter((id) => !selectedIdSet.has(id));
    if (unselected.length > 0) fail(`${name} references unselected item_id(s): ${JSON.stringify(unselected)}`);
  });
}

// Both response types share this body; Both supplies server-derived Keep ids.
function validateGenerationBody(response, runId, selectedItemIds, tidyAllowedItemIds = selectedItemIds) {
  validateActionPlan(response.action_plan, runId);
  validateTidyPlan(response.tidy_plan, tidyAllowedItemIds);
  validateFocusAreas(response.focus_areas, selectedItemIds);
  validateStorageSuggestions(response.storage_suggestions, selectedItemIds);
  requireNonEmptyString(response.image_prompt, "image_prompt");
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
  // The type check rejects booleans before the integer check.
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

  // Validate the request snapshot before comparing the response.
  requireArray(selectedItemIds, "selectedItemIds");
  if (selectedItemIds.length === 0) fail("selectedItemIds must be a non-empty array");
  selectedItemIds.forEach((id, i) => requireItemId(id, `selectedItemIds[${i}]`));
  requireNoDuplicates(selectedItemIds, "selectedItemIds entry");

  const responseRunId = requireNonEmptyString(response.run_id, "run_id");
  if (responseRunId !== runId) fail("response.run_id does not match the expected run_id");

  validateGenerationBody(response, runId, selectedItemIds);

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
    actionPlan: response.action_plan,
    tidyPlan: response.tidy_plan,
    focusAreas: response.focus_areas,
    storageSuggestions: response.storage_suggestions,
    imagePrompt: response.image_prompt,
    imageStatus: response.image_status,
    image: response.image,
    imageUnavailableReason: response.image_unavailable_reason,
  };
}

// Both revalidates confirmation and requires its server-derived Keep ids to
// match the prior confirmation snapshot before accepting generation output.
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

  // Focus areas and suggestions use only server-derived confirmed Keep ids.
  validateGenerationBody(
    response,
    runId,
    confirmation.confirmedKeepIds,
    confirmation.confirmedDecisions.filter((decision) => !decision.excluded).map((decision) => decision.item_id)
  );

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
    actionPlan: response.action_plan,
    tidyPlan: response.tidy_plan,
    focusAreas: response.focus_areas,
    storageSuggestions: response.storage_suggestions,
    imagePrompt: response.image_prompt,
    imageStatus: response.image_status,
    image: response.image,
    imageUnavailableReason: response.image_unavailable_reason,
  };
}
