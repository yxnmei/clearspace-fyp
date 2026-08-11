// Pure functions only — unit-tested (§4), no React/DOM/fetch here. See
// utils/format.js for the same convention.
//
// Adapts the backend's nested POST /upload (path="declutter") response —
// { run_id, path, analysis: {...AnalysisResult}, declutter: {...DeclutterResult} }
// — into a flat, item_id-joined shape the UI can render directly, without
// ever joining by label text or inventing an `id` alias (item_id is the
// only identity that exists on either side of the join). `analysis` and
// `declutter` are returned intact — their warnings/timings/provenance/
// validity/completeness fields are never stripped, only read from.

function fail(message) {
  throw new Error(`normaliseDeclutterUploadResponse: ${message}`);
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

function requireNoDuplicates(ids, name) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) fail(`duplicate ${name}: ${JSON.stringify(id)}`);
    seen.add(id);
  }
}

function extractItemIds(entries, entryName) {
  return entries.map((entry, index) => {
    if (!isPlainObject(entry)) fail(`${entryName}[${index}] must be an object`);
    return requireNonEmptyString(entry.item_id, `${entryName}[${index}].item_id`);
  });
}

export function normaliseDeclutterUploadResponse(response) {
  if (!isPlainObject(response)) fail("response must be an object");

  if (response.path !== "declutter") {
    fail(`expected path "declutter", got ${JSON.stringify(response.path)}`);
  }

  const runId = requireNonEmptyString(response.run_id, "run_id");

  if (!isPlainObject(response.analysis)) fail("analysis must be an object");
  if (!isPlainObject(response.declutter)) fail("declutter must be an object");
  const { analysis, declutter } = response;

  if (analysis.run_id !== runId) fail("analysis.run_id does not match top-level run_id");
  if (declutter.run_id !== runId) fail("declutter.run_id does not match top-level run_id");

  const detections = requireArray(analysis.items, "analysis.items");
  const decisions = requireArray(declutter.ai_decisions, "declutter.ai_decisions");
  const expectedIds = requireArray(declutter.expected_item_ids, "declutter.expected_item_ids");
  const unresolvedIds = requireArray(declutter.unresolved_item_ids, "declutter.unresolved_item_ids");
  if (!isPlainObject(declutter.item_validity)) fail("declutter.item_validity must be an object");
  const validity = declutter.item_validity;

  const detectionIds = extractItemIds(detections, "analysis.items");
  requireNoDuplicates(detectionIds, "detection item_id");

  const decisionIds = extractItemIds(decisions, "declutter.ai_decisions");
  requireNoDuplicates(decisionIds, "decision item_id");

  expectedIds.forEach((id, i) => requireNonEmptyString(id, `declutter.expected_item_ids[${i}]`));
  requireNoDuplicates(expectedIds, "expected_item_ids entry");

  unresolvedIds.forEach((id, i) => requireNonEmptyString(id, `declutter.unresolved_item_ids[${i}]`));
  requireNoDuplicates(unresolvedIds, "unresolved_item_ids entry");

  const detectionIdSet = new Set(detectionIds);
  const expectedIdSet = new Set(expectedIds);
  const unresolvedIdSet = new Set(unresolvedIds);

  // A future contextual detection may legitimately have no decision — so
  // detections are NOT required to all be expected. The reverse must
  // always hold: every expected item and every decision must resolve to
  // a real detection/expected item, never silently dropped or guessed.
  for (const id of expectedIds) {
    if (!detectionIdSet.has(id)) fail(`expected item_id ${JSON.stringify(id)} has no corresponding detection`);
  }
  for (const id of decisionIds) {
    if (!expectedIdSet.has(id)) fail(`decision item_id ${JSON.stringify(id)} is not an expected item`);
  }
  for (const id of unresolvedIds) {
    if (!expectedIdSet.has(id)) fail(`unresolved item_id ${JSON.stringify(id)} is not an expected item`);
  }

  const decisionsById = new Map(decisions.map((decision) => [decision.item_id, decision]));

  // item_validity keys must exactly equal expected_item_ids — no missing
  // entry, no unexpected extra key.
  for (const id of expectedIds) {
    if (!(id in validity)) fail(`expected item_id ${JSON.stringify(id)} has no item_validity entry`);
  }
  for (const key of Object.keys(validity)) {
    if (!expectedIdSet.has(key)) {
      fail(`declutter.item_validity has a key that is not an expected item_id: ${JSON.stringify(key)}`);
    }
  }

  // Every expected item must land on exactly one side of the partition:
  // resolved (one AiDecision, non-"still_invalid" validity) or unresolved
  // (no AiDecision, "still_invalid" validity). Duplicate decision item_ids
  // are already rejected above, so "exactly one AiDecision" only needs a
  // presence check here. A contradictory response — e.g. an unresolved
  // item that also has a decision, or a "still_invalid" item missing from
  // unresolved_item_ids — is rejected outright, never silently resolved
  // toward one side.
  for (const id of expectedIds) {
    const isUnresolved = unresolvedIdSet.has(id);
    const hasDecision = decisionsById.has(id);
    const itemValidity = validity[id];

    if (isUnresolved) {
      if (itemValidity !== "still_invalid") {
        fail(
          `unresolved item_id ${JSON.stringify(id)} must have item_validity "still_invalid", ` +
            `got ${JSON.stringify(itemValidity)}`
        );
      }
      if (hasDecision) {
        fail(`unresolved item_id ${JSON.stringify(id)} must not have an AiDecision`);
      }
    } else {
      if (itemValidity === "still_invalid") {
        fail(
          `expected item_id ${JSON.stringify(id)} has item_validity "still_invalid" but is missing ` +
            "from declutter.unresolved_item_ids"
        );
      }
      if (!hasDecision) {
        fail(`expected item_id ${JSON.stringify(id)} is not unresolved but has no AiDecision`);
      }
    }
  }

  // Join order follows analysis.items (the backend's own documented
  // deterministic spatial ordering) — never decision-array order, and
  // never label text. `{...detection}` copies every original detection
  // field through unchanged; no `id` alias is ever introduced.
  const items = detections.map((detection) => {
    const itemId = detection.item_id;
    const isExpected = expectedIdSet.has(itemId);
    const isUnresolved = unresolvedIdSet.has(itemId);
    const decision = decisionsById.get(itemId) ?? null;

    return {
      ...detection,
      ai_decision: decision ? decision.decision : null,
      ai_reason: decision ? decision.reason : null,
      item_validity: isExpected ? (validity[itemId] ?? null) : null,
      is_expected: isExpected,
      is_unresolved: isUnresolved,
    };
  });

  return { runId, analysis, declutter, items };
}
