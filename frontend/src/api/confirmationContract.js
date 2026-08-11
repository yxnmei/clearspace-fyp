// Pure functions only — unit-tested (§4), no React/DOM/fetch here. See
// utils/format.js and api/declutterContract.js for the same convention.
//
// Two related but distinct jobs live in this file:
//   1. normaliseConfirmationResponse() — validates and normalizes the
//      backend's POST /confirm response against the DeclutterResult it
//      was confirmed from, joining purely by item_id.
//   2. Local review-state helpers (setDecisionOverride/setItemExcluded/
//      clearDecisionOverride/serialiseDecisionOverrides/buildReviewItems)
//      — pure, immutable management of the in-progress override map the
//      UI builds up before calling /confirm, and the request payload it
//      serializes into.
//
// Neither half ever joins by label text or introduces an `id` alias —
// item_id is the only identity that exists anywhere in this file.

const VALID_DECISIONS = new Set(["keep", "sell", "donate", "discard"]);

function fail(message) {
  throw new Error(`confirmationContract: ${message}`);
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

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) fail(`${name} must be a non-negative integer`);
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
// 1. normaliseConfirmationResponse
// ---------------------------------------------------------------------------

export function normaliseConfirmationResponse(response, sourceDeclutter) {
  if (!isPlainObject(response)) fail("response must be an object");
  if (!isPlainObject(sourceDeclutter)) fail("sourceDeclutter must be an object");

  const runId = requireNonEmptyString(response.run_id, "run_id");
  if (sourceDeclutter.run_id !== runId) fail("response.run_id does not match sourceDeclutter.run_id");

  const confirmedDecisions = requireArray(response.confirmed_decisions, "confirmed_decisions");
  const confirmedKeepIds = requireArray(response.confirmed_keep_ids, "confirmed_keep_ids");
  const decisionChangedCount = requireNonNegativeInteger(response.decision_changed_count, "decision_changed_count");
  const excludedCount = requireNonNegativeInteger(response.excluded_count, "excluded_count");

  const expectedItemIds = requireArray(sourceDeclutter.expected_item_ids, "sourceDeclutter.expected_item_ids");
  const sourceAiDecisions = requireArray(sourceDeclutter.ai_decisions, "sourceDeclutter.ai_decisions");
  const unresolvedItemIds = requireArray(sourceDeclutter.unresolved_item_ids, "sourceDeclutter.unresolved_item_ids");

  if (unresolvedItemIds.length !== 0) {
    fail("sourceDeclutter is not complete: unresolved_item_ids is non-empty");
  }

  // Every expected ID must have exactly one source AiDecision — dedupe
  // (below) plus the membership check further down together guarantee
  // "exactly one", not just "at least one".
  const sourceAiById = new Map();
  sourceAiDecisions.forEach((ai, i) => {
    if (!isPlainObject(ai)) fail(`sourceDeclutter.ai_decisions[${i}] must be an object`);
    const itemId = requireNonEmptyString(ai.item_id, `sourceDeclutter.ai_decisions[${i}].item_id`);
    if (sourceAiById.has(itemId)) fail(`duplicate sourceDeclutter.ai_decisions item_id: ${JSON.stringify(itemId)}`);
    sourceAiById.set(itemId, ai);
  });
  for (const id of expectedItemIds) {
    if (!sourceAiById.has(id)) fail(`expected item_id ${JSON.stringify(id)} has no source AiDecision`);
  }

  const confirmedIds = confirmedDecisions.map((c, i) => {
    if (!isPlainObject(c)) fail(`confirmed_decisions[${i}] must be an object`);
    return requireNonEmptyString(c.item_id, `confirmed_decisions[${i}].item_id`);
  });
  requireNoDuplicates(confirmedIds, "confirmed decision item_id");

  const sameOrderAsExpected =
    confirmedIds.length === expectedItemIds.length && confirmedIds.every((id, i) => id === expectedItemIds[i]);
  if (!sameOrderAsExpected) {
    fail("confirmed_decisions item_ids must exactly equal sourceDeclutter.expected_item_ids, in the same order");
  }

  confirmedKeepIds.forEach((id, i) => requireNonEmptyString(id, `confirmed_keep_ids[${i}]`));
  requireNoDuplicates(confirmedKeepIds, "confirmed_keep_ids entry");

  const confirmedIdSet = new Set(confirmedIds);
  for (const id of confirmedKeepIds) {
    if (!confirmedIdSet.has(id)) {
      fail(`confirmed_keep_id ${JSON.stringify(id)} does not belong to confirmed_decisions`);
    }
  }

  // Per-decision integrity, plus tallying the derived Keep set and
  // counts so they can be cross-checked against the caller-supplied
  // confirmed_keep_ids/decision_changed_count/excluded_count below —
  // those three are never trusted at face value.
  let actualChangedCount = 0;
  let actualExcludedCount = 0;
  const derivedKeepIds = [];

  confirmedDecisions.forEach((c, i) => {
    const itemId = confirmedIds[i];
    const sourceAi = sourceAiById.get(itemId);

    if (c.ai_decision !== sourceAi.decision) {
      fail(`confirmed_decisions[${i}].ai_decision does not match the source AiDecision for ${JSON.stringify(itemId)}`);
    }
    if (c.ai_reason !== sourceAi.reason) {
      fail(`confirmed_decisions[${i}].ai_reason does not match the source AiDecision for ${JSON.stringify(itemId)}`);
    }
    if (!VALID_DECISIONS.has(c.confirmed_decision)) {
      fail(
        `confirmed_decisions[${i}].confirmed_decision is not a valid decision: ${JSON.stringify(c.confirmed_decision)}`
      );
    }
    requireBoolean(c.excluded, `confirmed_decisions[${i}].excluded`);
    if (c.user_reason !== null && !(typeof c.user_reason === "string" && c.user_reason.trim() !== "")) {
      fail(`confirmed_decisions[${i}].user_reason must be null or a non-empty string`);
    }
    requireBoolean(c.decision_changed, `confirmed_decisions[${i}].decision_changed`);
    const expectedChanged = c.confirmed_decision !== c.ai_decision;
    if (c.decision_changed !== expectedChanged) {
      fail(`confirmed_decisions[${i}].decision_changed is inconsistent with confirmed_decision/ai_decision`);
    }

    if (c.decision_changed) actualChangedCount += 1;
    if (c.excluded) actualExcludedCount += 1;
    if (c.confirmed_decision === "keep" && !c.excluded) derivedKeepIds.push(itemId);
  });

  const keepSetMatches =
    confirmedKeepIds.length === derivedKeepIds.length && confirmedKeepIds.every((id, i) => id === derivedKeepIds[i]);
  if (!keepSetMatches) {
    fail("confirmed_keep_ids does not match the confirmed Keep-and-not-excluded items, in confirmed_decisions order");
  }

  if (decisionChangedCount !== actualChangedCount) {
    fail("decision_changed_count does not match the number of confirmed_decisions with decision_changed=true");
  }
  if (excludedCount !== actualExcludedCount) {
    fail("excluded_count does not match the number of confirmed_decisions with excluded=true");
  }

  return {
    runId,
    confirmedDecisions,
    confirmedKeepIds,
    decisionChangedCount,
    excludedCount,
    response,
  };
}

// ---------------------------------------------------------------------------
// 2. Local review-state helpers
// ---------------------------------------------------------------------------

// overridesById shape: { [item_id]: { item_id, decision?, excluded?, user_reason? } }
// — mirrors the backend's DecisionOverride wire shape closely enough
// that serialiseDecisionOverrides() barely has to transform it, but
// stays purely local state until /confirm is actually called.

export function setDecisionOverride(overridesById, itemId, decision, userReason = undefined) {
  requireNonEmptyString(itemId, "itemId");
  if (!VALID_DECISIONS.has(decision)) {
    fail(`decision must be one of keep/sell/donate/discard, got ${JSON.stringify(decision)}`);
  }

  const existing = overridesById[itemId];
  const next = { item_id: itemId, decision };
  // excluded is always preserved from any existing override entry.
  if (existing && typeof existing.excluded === "boolean") {
    next.excluded = existing.excluded;
  }

  // userReason distinguishes omission from explicit clearing — changing
  // the decision (e.g. clicking a different decision button) must not
  // silently erase text already typed into a reason field:
  //   undefined (the default — argument not passed at all): preserve
  //     whatever user_reason already existed, untouched.
  //   null, or a blank/whitespace-only string: an explicit clear —
  //     next.user_reason stays unset.
  //   a non-empty string: stored, trimmed.
  if (userReason === undefined) {
    if (existing && typeof existing.user_reason === "string") {
      next.user_reason = existing.user_reason;
    }
  } else if (userReason !== null && String(userReason).trim() !== "") {
    next.user_reason = String(userReason).trim();
  }

  return { ...overridesById, [itemId]: next };
}

export function setItemExcluded(overridesById, itemId, excluded) {
  requireNonEmptyString(itemId, "itemId");
  requireBoolean(excluded, "excluded");

  const existing = overridesById[itemId];
  const next = { item_id: itemId, excluded };
  if (existing && typeof existing.decision === "string") {
    next.decision = existing.decision;
  }
  if (existing && typeof existing.user_reason === "string") {
    next.user_reason = existing.user_reason;
  }

  return { ...overridesById, [itemId]: next };
}

export function clearDecisionOverride(overridesById, itemId) {
  requireNonEmptyString(itemId, "itemId");
  const next = { ...overridesById };
  delete next[itemId];
  return next;
}

export function serialiseDecisionOverrides(overridesById, expectedItemIds) {
  // Network-boundary hardening: this is the last checkpoint before a
  // request body is built, so it validates overridesById structurally
  // rather than assuming every entry was produced by
  // setDecisionOverride()/setItemExcluded() — a caller could have built
  // or mutated overridesById by hand.
  if (!isPlainObject(overridesById)) fail("overridesById must be an object");
  requireArray(expectedItemIds, "expectedItemIds");
  expectedItemIds.forEach((id, i) => requireNonEmptyString(id, `expectedItemIds[${i}]`));
  requireNoDuplicates(expectedItemIds, "expectedItemIds entry");

  const expectedSet = new Set(expectedItemIds);

  for (const [itemId, override] of Object.entries(overridesById)) {
    if (!expectedSet.has(itemId)) fail(`override item_id ${JSON.stringify(itemId)} is not in expectedItemIds`);
    if (!isPlainObject(override)) fail(`override for item_id ${JSON.stringify(itemId)} must be an object`);
    if (override.item_id !== itemId) {
      fail(
        `override.item_id (${JSON.stringify(override.item_id)}) does not match its overridesById key ` +
          `(${JSON.stringify(itemId)})`
      );
    }
    if (override.decision !== undefined && !VALID_DECISIONS.has(override.decision)) {
      fail(`override for item_id ${JSON.stringify(itemId)} has an invalid decision: ${JSON.stringify(override.decision)}`);
    }
    if (override.excluded !== undefined && typeof override.excluded !== "boolean") {
      fail(`override for item_id ${JSON.stringify(itemId)} has a non-boolean excluded value`);
    }
    if (
      override.user_reason !== undefined &&
      !(typeof override.user_reason === "string" && override.user_reason.trim() !== "")
    ) {
      fail(`override for item_id ${JSON.stringify(itemId)} has an invalid user_reason (must be a non-empty string)`);
    }
    if (override.decision === undefined && override.excluded === undefined) {
      fail(`override for item_id ${JSON.stringify(itemId)} sets neither decision nor excluded`);
    }
  }

  const serialised = [];
  for (const itemId of expectedItemIds) {
    const override = overridesById[itemId];
    if (!override) continue;

    const entry = { item_id: itemId };
    if (override.decision !== undefined) entry.decision = override.decision;
    if (override.excluded !== undefined) entry.excluded = override.excluded;
    if (override.user_reason !== undefined) entry.user_reason = override.user_reason;

    serialised.push(entry);
  }

  return serialised;
}

export function buildReviewItems(items, overridesById) {
  requireArray(items, "items");

  return items.map((item) => {
    if (item.is_expected !== true || item.is_unresolved === true) {
      // Contextual/non-expected items, AND still-unresolved expected
      // items (still_invalid — no AiDecision exists to override yet),
      // never receive a fabricated review decision, regardless of any
      // stray override entry that might exist for their item_id.
      // is_expected/is_unresolved themselves are preserved unchanged via
      // the spread below.
      return {
        ...item,
        review_decision: null,
        review_excluded: false,
        review_user_reason: null,
        decision_changed: false,
        has_decision_override: false,
      };
    }

    const override = overridesById[item.item_id];
    const reviewDecision = override && typeof override.decision === "string" ? override.decision : item.ai_decision;
    const reviewExcluded = override && typeof override.excluded === "boolean" ? override.excluded : false;
    const reviewUserReason = override && typeof override.user_reason === "string" ? override.user_reason : null;

    return {
      ...item,
      review_decision: reviewDecision,
      review_excluded: reviewExcluded,
      review_user_reason: reviewUserReason,
      decision_changed: reviewDecision !== item.ai_decision,
      has_decision_override: Boolean(override),
    };
  });
}
