// Pure functions only, unit-tested, no React/DOM/fetch/clipboard or
// hook state here. Same convention as api/confirmationContract.js /
// declutterContract.js / reorganiseContract.js: this file owns its own
// small local validation helpers (fail/isPlainObject/requireArray/...)
// rather than importing a shared helpers module. normaliseConfirmationResponse
// (a higher-level normalizer, not a small helper) is the one deliberate
// import, reused verbatim exactly as reorganiseContract.js already does.
//
// Two jobs, sharing every internal helper so there is only one
// implementation of each rule:
//   1. normaliseListingResponse() - validates a complete POST /listings
//      response (app/api/routes.py's ListingGenerationResult) against the
//      source DeclutterResult, the already-current confirmed result, and
//      the current review items.
//   2. normaliseSingleListingResponse() - validates a single POST
//      /listings/{item_id}/regenerate response (SingleListingDraftResult)
//      against the same trusted state PLUS the requested item_id.
//
// Never joins by label text: item_id is the only identity. A draft's
// effective_label is checked to EQUAL the current review item's
// effective_label (found strictly by item_id) - it is a consistency
// check, never a matching key, and there is no `id` alias anywhere.
//
// An `unavailable` draft is a SUCCESSFUL, fully validated result here,
// never thrown. Only a genuinely malformed / contract-violating response
// throws - this file never silently falls back to an empty draft list.

import { normaliseConfirmationResponse } from "./confirmationContract";

const ITEM_ID_RE = /^item_\d{3,}$/;

const VALID_STATUS = new Set(["generated", "unavailable"]);
// Matches app.core.listing_schemas.ListingUnavailableReason exactly.
const VALID_UNAVAILABLE_REASONS = new Set([
  "timeout",
  "service_unavailable",
  "invalid_output",
  "generation_failed",
]);

// Backend bounds (app/core/listing_schemas.py): trimmed length ranges and
// the strict-int attempt ceiling.
const TITLE_MIN = 2;
const TITLE_MAX = 120;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 1200;
const ATTEMPTS_MIN = 1;
const ATTEMPTS_MAX = 5;

const BATCH_KEYS = ["run_id", "confirmation", "drafts", "model_name", "prompt_version", "max_attempts"];
const SINGLE_KEYS = ["run_id", "confirmation", "draft", "model_name", "prompt_version", "max_attempts"];
const DRAFT_KEYS = [
  "item_id",
  "effective_label",
  "status",
  "title",
  "description",
  "unavailable_reason",
  "was_repaired",
  "attempts",
];
// The confirmed_decisions fields that must match the current confirmed
// result field-for-field for the listing response to be considered
// consistent (not derived from different overrides / a stale run).
const CONFIRMED_DECISION_FIELDS = [
  "item_id",
  "ai_decision",
  "ai_reason",
  "confirmed_decision",
  "user_reason",
  "excluded",
  "decision_changed",
];

function fail(message) {
  throw new Error(`listingContract: ${message}`);
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

function requireItemId(value, name) {
  if (typeof value !== "string" || !ITEM_ID_RE.test(value)) {
    fail(`${name} must match ^item_\\d{3,}$, got ${JSON.stringify(value)}`);
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

// A GENUINE integer in [min, max]. typeof-guards first, so a boolean
// (typeof "boolean"), a numeric string, null, undefined never reach
// Number.isInteger; Number.isInteger then rejects NaN, Infinity and any
// non-whole float. JavaScript coercion cannot turn any of those into
// valid integer provenance.
function requireBoundedInteger(value, name, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${name} must be a genuine integer, got ${JSON.stringify(value)} (${typeof value})`);
  }
  if (value < min || value > max) fail(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  return value;
}

// A string that is ALREADY trimmed (the backend returns canonical
// trimmed values, so leading/trailing whitespace is contract drift and
// is rejected, never silently trimmed) and whose length is in [min, max].
function requireExactTrimmedString(value, name, min, max) {
  if (typeof value !== "string") fail(`${name} must be a string, got ${typeof value}`);
  if (value !== value.trim()) {
    fail(`${name} has leading/trailing whitespace (contract drift): ${JSON.stringify(value)}`);
  }
  if (value.length < min || value.length > max) {
    fail(`${name} length must be in [${min}, ${max}], got ${value.length}`);
  }
  return value;
}

function requireExactKeys(obj, expectedKeys, name) {
  const expectedSet = new Set(expectedKeys);
  const missing = expectedKeys.filter((k) => !(k in obj));
  const unexpected = Object.keys(obj).filter((k) => !expectedSet.has(k));
  if (missing.length) fail(`${name} is missing field(s): ${JSON.stringify(missing)}`);
  if (unexpected.length) fail(`${name} has unexpected field(s): ${JSON.stringify(unexpected)}`);
}

// ---------------------------------------------------------------------------
// shared internal helpers
// ---------------------------------------------------------------------------

// Minimal shape check for the caller-supplied "already current" confirmed
// result (the normalised object an earlier normaliseConfirmationResponse
// produced). A malformed one must fail loudly here rather than let
// undefined === undefined pass in _requireSameConfirmation below.
function _requireCurrentConfirmedShape(currentConfirmed) {
  if (!isPlainObject(currentConfirmed)) fail("currentConfirmed must be an object");
  requireNonEmptyString(currentConfirmed.runId, "currentConfirmed.runId");
  requireArray(currentConfirmed.confirmedDecisions, "currentConfirmed.confirmedDecisions");
  requireArray(currentConfirmed.confirmedKeepIds, "currentConfirmed.confirmedKeepIds");
  requireBoundedInteger(
    currentConfirmed.decisionChangedCount,
    "currentConfirmed.decisionChangedCount",
    0,
    Number.MAX_SAFE_INTEGER
  );
  requireBoundedInteger(
    currentConfirmed.excludedCount,
    "currentConfirmed.excludedCount",
    0,
    Number.MAX_SAFE_INTEGER
  );
}

// `normalised` is the freshly-normalised confirmation from the listing
// response; `current` is the already-current confirmed result. They must
// describe the SAME confirmation - a listing response derived from
// different overrides / a different run is rejected as stale.
function _requireSameConfirmation(normalised, current) {
  if (normalised.runId !== current.runId) {
    fail("listing response confirmation.run_id differs from the current confirmed result");
  }
  if (normalised.confirmedDecisions.length !== current.confirmedDecisions.length) {
    fail("listing response confirmation has a different number of confirmed_decisions than the current confirmed result");
  }
  normalised.confirmedDecisions.forEach((decision, i) => {
    const currentDecision = current.confirmedDecisions[i];
    if (!isPlainObject(currentDecision)) fail(`currentConfirmed.confirmedDecisions[${i}] must be an object`);
    for (const field of CONFIRMED_DECISION_FIELDS) {
      if (decision[field] !== currentDecision[field]) {
        fail(
          `listing response confirmation.confirmed_decisions[${i}].${field} differs from the current ` +
            "confirmed result (the listing response was derived from different overrides / a stale run)"
        );
      }
    }
  });
  const sameKeepIds =
    normalised.confirmedKeepIds.length === current.confirmedKeepIds.length &&
    normalised.confirmedKeepIds.every((id, i) => id === current.confirmedKeepIds[i]);
  if (!sameKeepIds) {
    fail("listing response confirmation.confirmed_keep_ids differs from the current confirmed result");
  }
  if (normalised.decisionChangedCount !== current.decisionChangedCount) {
    fail("listing response confirmation.decision_changed_count differs from the current confirmed result");
  }
  if (normalised.excludedCount !== current.excludedCount) {
    fail("listing response confirmation.excluded_count differs from the current confirmed result");
  }
}

// Eligible = confirmed Sell and not excluded, in confirmation order.
// Derived ONLY from the validated confirmation, never from anything the
// client passed in or the listing response claimed.
function _deriveEligibleItemIds(confirmation) {
  return confirmation.confirmedDecisions
    .filter((d) => d.confirmed_decision === "sell" && d.excluded === false)
    .map((d) => d.item_id);
}

function _reviewItemsById(currentReviewItems) {
  requireArray(currentReviewItems, "currentReviewItems");
  const byId = new Map();
  currentReviewItems.forEach((item, i) => {
    if (!isPlainObject(item)) fail(`currentReviewItems[${i}] must be an object`);
    const id = requireItemId(item.item_id, `currentReviewItems[${i}].item_id`);
    requireNonEmptyString(item.effective_label, `currentReviewItems[${i}].effective_label`);
    if (byId.has(id)) fail(`duplicate currentReviewItems item_id: ${JSON.stringify(id)}`);
    byId.set(id, item);
  });
  return byId;
}

// Validate one draft object and return a fresh normalised draft (never a
// reference to, or a mutation of, the input). `maxAttempts` is a real
// integer here (both callers only validate drafts once they have one).
function _normaliseDraft(draft, name, maxAttempts, reviewItemsById) {
  if (!isPlainObject(draft)) fail(`${name} must be an object`);
  requireExactKeys(draft, DRAFT_KEYS, name);

  const itemId = requireItemId(draft.item_id, `${name}.item_id`);

  const reviewItem = reviewItemsById.get(itemId);
  if (!reviewItem) {
    fail(`${name}.item_id ${JSON.stringify(itemId)} has no matching current review item`);
  }
  if (typeof draft.effective_label !== "string" || draft.effective_label.trim() === "") {
    fail(`${name}.effective_label must be a non-empty string`);
  }
  if (draft.effective_label !== reviewItem.effective_label) {
    fail(
      `${name}.effective_label ${JSON.stringify(draft.effective_label)} does not equal the current review ` +
        `item's effective_label ${JSON.stringify(reviewItem.effective_label)} for ${JSON.stringify(itemId)}`
    );
  }

  if (!VALID_STATUS.has(draft.status)) {
    fail(`${name}.status must be "generated" or "unavailable", got ${JSON.stringify(draft.status)}`);
  }

  const attempts = requireBoundedInteger(draft.attempts, `${name}.attempts`, ATTEMPTS_MIN, ATTEMPTS_MAX);
  if (attempts > maxAttempts) {
    fail(`${name}.attempts (${attempts}) is greater than max_attempts (${maxAttempts})`);
  }

  let title = null;
  let description = null;
  let unavailableReason = null;
  let wasRepaired = null;

  if (draft.status === "generated") {
    title = requireExactTrimmedString(draft.title, `${name}.title`, TITLE_MIN, TITLE_MAX);
    description = requireExactTrimmedString(draft.description, `${name}.description`, DESCRIPTION_MIN, DESCRIPTION_MAX);
    if (draft.unavailable_reason !== null) {
      fail(`${name}.unavailable_reason must be null for a generated draft, got ${JSON.stringify(draft.unavailable_reason)}`);
    }
    if (typeof draft.was_repaired !== "boolean") {
      fail(`${name}.was_repaired must be a genuine boolean for a generated draft, got ${JSON.stringify(draft.was_repaired)}`);
    }
    wasRepaired = draft.was_repaired;
  } else {
    if (draft.title !== null) fail(`${name}.title must be null for an unavailable draft`);
    if (draft.description !== null) fail(`${name}.description must be null for an unavailable draft`);
    if (draft.was_repaired !== null) fail(`${name}.was_repaired must be null for an unavailable draft`);
    if (!VALID_UNAVAILABLE_REASONS.has(draft.unavailable_reason)) {
      fail(`${name}.unavailable_reason is not recognised: ${JSON.stringify(draft.unavailable_reason)}`);
    }
    unavailableReason = draft.unavailable_reason;
  }

  // Fresh object; identity stays item_id (no `id` alias). Field names
  // kept identical to the wire so a hook can tell server values from its
  // own local edit state at a glance.
  return {
    item_id: itemId,
    effective_label: draft.effective_label,
    status: draft.status,
    title,
    description,
    unavailable_reason: unavailableReason,
    was_repaired: wasRepaired,
    attempts,
  };
}

// Shared: validate the shared confirmation portion (reusing
// normaliseConfirmationResponse verbatim, then cross-checking against the
// current confirmed result) and return { confirmation, eligibleItemIds,
// reviewItemsById }.
function _validateSharedListingContext(responseConfirmation, { runId, sourceDeclutter, currentConfirmed, currentReviewItems }) {
  if (!isPlainObject(responseConfirmation)) fail("confirmation must be an object");
  const confirmation = normaliseConfirmationResponse(responseConfirmation, sourceDeclutter);
  if (confirmation.runId !== runId) fail("confirmation.run_id does not match the expected run_id");

  _requireCurrentConfirmedShape(currentConfirmed);
  _requireSameConfirmation(confirmation, currentConfirmed);

  const eligibleItemIds = _deriveEligibleItemIds(confirmation);
  const reviewItemsById = _reviewItemsById(currentReviewItems);
  return { confirmation, eligibleItemIds, reviewItemsById };
}

// ---------------------------------------------------------------------------
// 1. normaliseListingResponse - complete POST /listings response
// ---------------------------------------------------------------------------

export function normaliseListingResponse(response, { runId, sourceDeclutter, currentConfirmed, currentReviewItems }) {
  if (!isPlainObject(response)) fail("response must be an object");
  requireExactKeys(response, BATCH_KEYS, "response");

  const responseRunId = requireNonEmptyString(response.run_id, "run_id");
  if (responseRunId !== runId) fail("response.run_id does not match the expected run_id");

  const { confirmation, eligibleItemIds, reviewItemsById } = _validateSharedListingContext(response.confirmation, {
    runId,
    sourceDeclutter,
    currentConfirmed,
    currentReviewItems,
  });

  const drafts = requireArray(response.drafts, "drafts");
  const isEmpty = eligibleItemIds.length === 0;

  let modelName = null;
  let promptVersion = null;
  let maxAttempts = null;

  if (isEmpty) {
    if (drafts.length !== 0) fail("drafts must be empty when there are no eligible Sell items");
    if (response.model_name !== null) fail("model_name must be null for an empty listing result");
    if (response.prompt_version !== null) fail("prompt_version must be null for an empty listing result");
    if (response.max_attempts !== null) fail("max_attempts must be null for an empty listing result");
  } else {
    modelName = requireNonEmptyString(response.model_name, "model_name");
    promptVersion = requireNonEmptyString(response.prompt_version, "prompt_version");
    maxAttempts = requireBoundedInteger(response.max_attempts, "max_attempts", ATTEMPTS_MIN, ATTEMPTS_MAX);
  }

  // Exact draft-id partition against the eligible set, in confirmation
  // order: no missing, no duplicate, no unexpected (which also catches an
  // excluded / non-Sell id), no reorder.
  const draftIds = drafts.map((draft, i) => {
    if (!isPlainObject(draft)) fail(`drafts[${i}] must be an object`);
    return requireItemId(draft.item_id, `drafts[${i}].item_id`);
  });
  requireNoDuplicates(draftIds, "draft item_id");

  const sameSetAndOrder =
    draftIds.length === eligibleItemIds.length && draftIds.every((id, i) => id === eligibleItemIds[i]);
  if (!sameSetAndOrder) {
    const eligibleSet = new Set(eligibleItemIds);
    const draftSet = new Set(draftIds);
    const missing = eligibleItemIds.filter((id) => !draftSet.has(id));
    const unexpected = draftIds.filter((id) => !eligibleSet.has(id));
    if (missing.length) fail(`drafts omit eligible Sell item_id(s): ${JSON.stringify(missing)}`);
    if (unexpected.length) {
      fail(`drafts include item_id(s) that are not eligible Sell items: ${JSON.stringify(unexpected)}`);
    }
    fail("drafts are not in confirmation (eligible Sell) order");
  }

  const normalisedDrafts = drafts.map((draft, i) =>
    _normaliseDraft(draft, `drafts[${i}]`, maxAttempts, reviewItemsById)
  );

  return {
    runId: responseRunId,
    confirmation,
    eligibleItemIds,
    drafts: normalisedDrafts,
    modelName,
    promptVersion,
    maxAttempts,
  };
}

// ---------------------------------------------------------------------------
// 2. normaliseSingleListingResponse - POST /listings/{item_id}/regenerate
// ---------------------------------------------------------------------------

export function normaliseSingleListingResponse(
  response,
  { runId, sourceDeclutter, currentConfirmed, currentReviewItems, itemId }
) {
  if (!isPlainObject(response)) fail("response must be an object");
  requireExactKeys(response, SINGLE_KEYS, "response");
  requireItemId(itemId, "itemId");

  const responseRunId = requireNonEmptyString(response.run_id, "run_id");
  if (responseRunId !== runId) fail("response.run_id does not match the expected run_id");

  const { confirmation, eligibleItemIds, reviewItemsById } = _validateSharedListingContext(response.confirmation, {
    runId,
    sourceDeclutter,
    currentConfirmed,
    currentReviewItems,
  });

  if (!eligibleItemIds.includes(itemId)) {
    fail(`the requested itemId ${JSON.stringify(itemId)} is not currently a confirmed non-excluded Sell item`);
  }

  // A single regeneration ALWAYS targets one eligible item and always
  // makes at least one model call - there is no empty case, so
  // model / prompt / max_attempts are always present.
  const modelName = requireNonEmptyString(response.model_name, "model_name");
  const promptVersion = requireNonEmptyString(response.prompt_version, "prompt_version");
  const maxAttempts = requireBoundedInteger(response.max_attempts, "max_attempts", ATTEMPTS_MIN, ATTEMPTS_MAX);

  const draft = _normaliseDraft(response.draft, "draft", maxAttempts, reviewItemsById);
  if (draft.item_id !== itemId) {
    fail(
      `the regenerated draft is for ${JSON.stringify(draft.item_id)}, not the requested item ` +
        `${JSON.stringify(itemId)} - another eligible item cannot be substituted`
    );
  }

  return {
    runId: responseRunId,
    confirmation,
    eligibleItemIds,
    draft,
    modelName,
    promptVersion,
    maxAttempts,
  };
}
