// Validates confirmation against its source and manages local overrides.
// item_id is the only identity; labels are never join keys.

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

  // Deduplication plus membership enforces exactly one decision per item.
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

  // Derive Keep ids and counts rather than trusting summary fields.
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

// overridesById shape: { [item_id]: { item_id, decision?, excluded?, user_reason? } }

export function setDecisionOverride(overridesById, itemId, decision, userReason = undefined) {
  requireNonEmptyString(itemId, "itemId");
  if (!VALID_DECISIONS.has(decision)) {
    fail(`decision must be one of keep/sell/donate/discard, got ${JSON.stringify(decision)}`);
  }

  const existing = overridesById[itemId];
  const next = { item_id: itemId, decision };
  if (existing && typeof existing.excluded === "boolean") {
    next.excluded = existing.excluded;
  }

  // undefined preserves the prior reason; null or blank clears it.
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
  // Validate again at the request boundary; callers may construct the map.
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
      // Never fabricate decisions for contextual or unresolved items.
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
