// Normalises full analysis/declutter envelopes while preserving both source
// objects. All joins use item_id; labels are never identity.

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(`declutterContract: ${message}`);
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

function requireSha256Hex(value, name) {
  if (typeof value !== "string" || !SHA256_HEX_RE.test(value)) {
    fail(`${name} must be a 64-character lowercase hexadecimal string`);
  }
  return value;
}

function extractItemIds(entries, entryName) {
  return entries.map((entry, index) => {
    if (!isPlainObject(entry)) fail(`${entryName}[${index}] must be an object`);
    return requireNonEmptyString(entry.item_id, `${entryName}[${index}].item_id`);
  });
}

// Recheck backend-computed label provenance for contradictions.
function requireLabelProvenanceConsistent(detection, name) {
  const { corrected_label: correctedLabel, label_source: labelSource, effective_label: effectiveLabel } = detection;

  if (correctedLabel !== null && !(typeof correctedLabel === "string" && correctedLabel.trim() !== "")) {
    fail(`${name}.corrected_label must be null or a non-empty string`);
  }

  const expectedSource = correctedLabel !== null ? "user" : "detector";
  if (labelSource !== expectedSource) {
    fail(
      `${name}.label_source (${JSON.stringify(labelSource)}) does not agree with corrected_label ` +
        `(${JSON.stringify(correctedLabel)})`
    );
  }

  const expectedEffective = correctedLabel !== null ? correctedLabel : detection.clean_label;
  if (effectiveLabel !== expectedEffective) {
    fail(`${name}.effective_label does not equal corrected_label ?? clean_label`);
  }
}

// expectedPath is null for /override, which has no path field.
function normaliseAnalysisDeclutterEnvelope(response, { expectedPath }) {
  if (!isPlainObject(response)) fail("response must be an object");

  if (expectedPath !== null && response.path !== expectedPath) {
    fail(`expected path ${JSON.stringify(expectedPath)}, got ${JSON.stringify(response.path)}`);
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

  detections.forEach((detection, i) => requireLabelProvenanceConsistent(detection, `analysis.items[${i}]`));

  const decisionIds = extractItemIds(decisions, "declutter.ai_decisions");
  requireNoDuplicates(decisionIds, "decision item_id");

  expectedIds.forEach((id, i) => requireNonEmptyString(id, `declutter.expected_item_ids[${i}]`));
  requireNoDuplicates(expectedIds, "expected_item_ids entry");

  unresolvedIds.forEach((id, i) => requireNonEmptyString(id, `declutter.unresolved_item_ids[${i}]`));
  requireNoDuplicates(unresolvedIds, "unresolved_item_ids entry");

  const detectionIdSet = new Set(detectionIds);
  const expectedIdSet = new Set(expectedIds);
  const unresolvedIdSet = new Set(unresolvedIds);

  // Contextual detections may lack decisions; expected ids may not lack detections.
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

  // item_validity keys must exactly match expected ids.
  for (const id of expectedIds) {
    if (!(id in validity)) fail(`expected item_id ${JSON.stringify(id)} has no item_validity entry`);
  }
  for (const key of Object.keys(validity)) {
    if (!expectedIdSet.has(key)) {
      fail(`declutter.item_validity has a key that is not an expected item_id: ${JSON.stringify(key)}`);
    }
  }

  // Expected items form an exact resolved/unresolved partition.
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

  // Preserve analysis order and detection fields; join only by item_id.
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

export function normaliseDeclutterUploadResponse(response) {
  return normaliseAnalysisDeclutterEnvelope(response, { expectedPath: "declutter" });
}

// /override returns a full envelope without a path field.
export function normaliseOverrideResponse(response) {
  return normaliseAnalysisDeclutterEnvelope(response, { expectedPath: null });
}

// Both also carries the original image hash for confirmed generation.
export function normaliseBothUploadResponse(response) {
  const envelope = normaliseAnalysisDeclutterEnvelope(response, { expectedPath: "both" });
  const inputImageSha256 = requireSha256Hex(response.input_image_sha256, "input_image_sha256");
  return { ...envelope, inputImageSha256 };
}
