import { describe, expect, test } from "vitest";
import { normaliseDeclutterUploadResponse, normaliseOverrideResponse } from "./declutterContract";

function makeDetection(overrides = {}) {
  const cleanLabel = overrides.clean_label ?? "lamp";
  const correctedLabel = "corrected_label" in overrides ? overrides.corrected_label : null;
  return {
    item_id: "item_001",
    raw_phrase: "lamp",
    clean_label: cleanLabel,
    position: "upper-left",
    relative_size: "small",
    confidence: 0.8,
    // Real /upload and /override responses always carry these three —
    // label_source/effective_label are backend-computed from
    // corrected_label, so the defaults here agree with the "no
    // correction" case unless a test overrides corrected_label.
    corrected_label: correctedLabel,
    label_source: correctedLabel !== null ? "user" : "detector",
    effective_label: correctedLabel !== null ? correctedLabel : cleanLabel,
    ...overrides,
  };
}

function makeDecision(overrides = {}) {
  return { item_id: "item_001", decision: "keep", reason: "still useful", ...overrides };
}

function baseAnalysis(overrides = {}) {
  return {
    run_id: "run_abc",
    scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
    items: [],
    warnings: [],
    stage_timings: [],
    ...overrides,
  };
}

function baseDeclutter(overrides = {}) {
  return {
    run_id: "run_abc",
    expected_item_ids: [],
    ai_decisions: [],
    unresolved_item_ids: [],
    item_validity: {},
    mapping_warnings: [],
    semantic_errors: [],
    recovery_failures: [],
    provenance_warnings: [],
    is_complete: true,
    is_strictly_valid: true,
    ...overrides,
  };
}

function baseResponse({ runId = "run_abc", analysis = {}, declutter = {} } = {}) {
  return {
    run_id: runId,
    path: "declutter",
    analysis: baseAnalysis({ run_id: runId, ...analysis }),
    declutter: baseDeclutter({ run_id: runId, ...declutter }),
  };
}

describe("normaliseDeclutterUploadResponse", () => {
  test("joins a detection and its decision by item_id", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision({ item_id: "item_001", decision: "keep", reason: "still useful" })],
        item_validity: { item_001: "raw_valid" },
      },
    });

    const result = normaliseDeclutterUploadResponse(response);

    expect(result.runId).toBe("run_abc");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      item_id: "item_001",
      clean_label: "lamp",
      ai_decision: "keep",
      ai_reason: "still useful",
      item_validity: "raw_valid",
      is_expected: true,
      is_unresolved: false,
    });
  });

  test("two detections sharing a label remain separate and get independent decisions", () => {
    const response = baseResponse({
      analysis: {
        items: [
          makeDetection({ item_id: "item_004", clean_label: "picture frame", position: "upper-left" }),
          makeDetection({ item_id: "item_006", clean_label: "picture frame", position: "left" }),
        ],
      },
      declutter: {
        expected_item_ids: ["item_004", "item_006"],
        ai_decisions: [
          makeDecision({ item_id: "item_004", decision: "discard", reason: "duplicate, low confidence" }),
          makeDecision({ item_id: "item_006", decision: "donate", reason: "still in good shape" }),
        ],
        item_validity: { item_004: "raw_valid", item_006: "raw_valid" },
      },
    });

    const result = normaliseDeclutterUploadResponse(response);

    expect(result.items.map((i) => i.item_id)).toEqual(["item_004", "item_006"]);
    expect(result.items.every((i) => i.clean_label === "picture frame")).toBe(true);
    expect(result.items[0].ai_decision).toBe("discard");
    expect(result.items[1].ai_decision).toBe("donate");
  });

  test("detection order follows analysis.items, not decision-array order", () => {
    const response = baseResponse({
      analysis: {
        items: [makeDetection({ item_id: "item_001" }), makeDetection({ item_id: "item_002" })],
      },
      declutter: {
        expected_item_ids: ["item_001", "item_002"],
        // Deliberately reversed relative to analysis.items.
        ai_decisions: [
          makeDecision({ item_id: "item_002", decision: "donate" }),
          makeDecision({ item_id: "item_001", decision: "keep" }),
        ],
        item_validity: { item_001: "raw_valid", item_002: "raw_valid" },
      },
    });

    const result = normaliseDeclutterUploadResponse(response);

    expect(result.items.map((i) => i.item_id)).toEqual(["item_001", "item_002"]);
    expect(result.items[0].ai_decision).toBe("keep");
    expect(result.items[1].ai_decision).toBe("donate");
  });

  test("returns the original analysis and declutter objects intact", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection()], warnings: [{ kind: "malformed_detection", detail: "x" }] },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision()],
        item_validity: { item_001: "raw_valid" },
        mapping_warnings: [{ kind: "unexpected", detail: "y" }],
        is_strictly_valid: false,
      },
    });

    const result = normaliseDeclutterUploadResponse(response);

    expect(result.analysis).toBe(response.analysis);
    expect(result.declutter).toBe(response.declutter);
    expect(result.analysis.warnings).toHaveLength(1);
    expect(result.declutter.mapping_warnings).toHaveLength(1);
    expect(result.declutter.is_complete).toBe(true);
    expect(result.declutter.is_strictly_valid).toBe(false);
  });

  test("an unresolved expected item stays visible with null decision/reason", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_003" })] },
      declutter: {
        expected_item_ids: ["item_003"],
        ai_decisions: [],
        unresolved_item_ids: ["item_003"],
        item_validity: { item_003: "still_invalid" },
        is_complete: false,
      },
    });

    const result = normaliseDeclutterUploadResponse(response);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      item_id: "item_003",
      ai_decision: null,
      ai_reason: null,
      item_validity: "still_invalid",
      is_expected: true,
      is_unresolved: true,
    });
  });

  test("a contextual/non-expected detection stays visible without a fabricated decision", () => {
    const response = baseResponse({
      analysis: {
        items: [makeDetection({ item_id: "item_001" }), makeDetection({ item_id: "item_099", clean_label: "wall" })],
      },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision({ item_id: "item_001" })],
        item_validity: { item_001: "raw_valid" },
      },
    });

    const result = normaliseDeclutterUploadResponse(response);

    const contextual = result.items.find((i) => i.item_id === "item_099");
    expect(contextual).toMatchObject({
      ai_decision: null,
      ai_reason: null,
      item_validity: null,
      is_expected: false,
      is_unresolved: false,
    });
  });

  test("mechanically_repaired and recovery_used validity values are preserved", () => {
    const response = baseResponse({
      analysis: {
        items: [makeDetection({ item_id: "item_001" }), makeDetection({ item_id: "item_002" })],
      },
      declutter: {
        expected_item_ids: ["item_001", "item_002"],
        ai_decisions: [makeDecision({ item_id: "item_001" }), makeDecision({ item_id: "item_002" })],
        item_validity: { item_001: "mechanically_repaired", item_002: "recovery_used" },
      },
    });

    const result = normaliseDeclutterUploadResponse(response);

    expect(result.items[0].item_validity).toBe("mechanically_repaired");
    expect(result.items[1].item_validity).toBe("recovery_used");
  });

  test("rejects a response whose analysis.run_id does not match the top-level run_id", () => {
    const response = baseResponse();
    response.analysis.run_id = "different_run";
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/run_id/);
  });

  test("rejects a response whose declutter.run_id does not match the top-level run_id", () => {
    const response = baseResponse();
    response.declutter.run_id = "different_run";
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/run_id/);
  });

  test("rejects a non-declutter path", () => {
    const response = baseResponse();
    response.path = "reorganise";
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/declutter/);
  });

  test("rejects duplicate detection item_id values", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" }), makeDetection({ item_id: "item_001" })] },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/duplicate/i);
  });

  test("rejects duplicate decision item_id values", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision({ item_id: "item_001" }), makeDecision({ item_id: "item_001", decision: "sell" })],
        item_validity: { item_001: "raw_valid" },
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/duplicate/i);
  });

  test("rejects duplicate expected_item_ids entries", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: { expected_item_ids: ["item_001", "item_001"], item_validity: { item_001: "raw_valid" } },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/duplicate/i);
  });

  test("rejects duplicate unresolved_item_ids entries", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: {
        expected_item_ids: ["item_001"],
        unresolved_item_ids: ["item_001", "item_001"],
        item_validity: { item_001: "still_invalid" },
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/duplicate/i);
  });

  test("rejects an expected item_id with no corresponding detection", () => {
    const response = baseResponse({
      analysis: { items: [] },
      declutter: { expected_item_ids: ["item_001"], item_validity: { item_001: "raw_valid" } },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/no corresponding detection/);
  });

  test("rejects a decision whose item_id is not expected", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: {
        expected_item_ids: [],
        ai_decisions: [makeDecision({ item_id: "item_001" })],
        item_validity: {},
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/not an expected item/);
  });

  test("rejects an unresolved item that also has an AiDecision", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision({ item_id: "item_001" })],
        unresolved_item_ids: ["item_001"],
        item_validity: { item_001: "still_invalid" },
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/must not have an AiDecision/);
  });

  test("rejects an unresolved item whose validity is not still_invalid", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [],
        unresolved_item_ids: ["item_001"],
        item_validity: { item_001: "raw_valid" },
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/must have item_validity "still_invalid"/);
  });

  test("rejects a still_invalid expected item missing from unresolved_item_ids", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [],
        unresolved_item_ids: [],
        item_validity: { item_001: "still_invalid" },
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/missing[\s\S]*unresolved_item_ids/);
  });

  test("rejects a resolved expected item missing an AiDecision", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [],
        unresolved_item_ids: [],
        item_validity: { item_001: "raw_valid" },
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/has no AiDecision/);
  });

  test("rejects an expected item missing an item_validity entry", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision({ item_id: "item_001" })],
        unresolved_item_ids: [],
        item_validity: {},
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/has no item_validity entry/);
  });

  test("rejects an unexpected extra item_validity key", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision({ item_id: "item_001" })],
        unresolved_item_ids: [],
        item_validity: { item_001: "raw_valid", item_999: "raw_valid" },
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/not an expected item_id/);
  });

  test("rejects a missing analysis.items array rather than defaulting to empty", () => {
    const response = baseResponse();
    delete response.analysis.items;
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/analysis\.items/);
  });

  test("rejects a non-array declutter.ai_decisions rather than defaulting to empty", () => {
    const response = baseResponse();
    response.declutter.ai_decisions = null;
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/ai_decisions/);
  });

  test("rejects a non-object declutter.item_validity", () => {
    const response = baseResponse();
    response.declutter.item_validity = [];
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/item_validity/);
  });

  test("does not mutate the source response", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision({ item_id: "item_001" })],
        item_validity: { item_001: "raw_valid" },
      },
    });
    Object.freeze(response);
    Object.freeze(response.analysis);
    Object.freeze(response.analysis.items);
    Object.freeze(response.analysis.items[0]);
    Object.freeze(response.declutter);
    Object.freeze(response.declutter.ai_decisions);
    Object.freeze(response.declutter.ai_decisions[0]);
    Object.freeze(response.declutter.item_validity);

    expect(() => normaliseDeclutterUploadResponse(response)).not.toThrow();
  });

  test("never introduces an id alias", () => {
    const response = baseResponse({
      analysis: { items: [makeDetection({ item_id: "item_001" })] },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision({ item_id: "item_001" })],
        item_validity: { item_001: "raw_valid" },
      },
    });

    const result = normaliseDeclutterUploadResponse(response);

    expect(result.items[0].item_id).toBe("item_001");
    expect("id" in result.items[0]).toBe(false);
  });

  // --- label-correction provenance (shared by both normalisers — see
  // normaliseOverrideResponse's own describe block below for the
  // override-specific scenarios) ---

  test("a corrected label with self-consistent label_source/effective_label is accepted", () => {
    const response = baseResponse({
      analysis: {
        items: [makeDetection({ item_id: "item_001", clean_label: "box", corrected_label: "hoodie" })],
      },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision({ item_id: "item_001" })],
        item_validity: { item_001: "raw_valid" },
      },
    });

    const result = normaliseDeclutterUploadResponse(response);

    expect(result.items[0].clean_label).toBe("box"); // never overwritten
    expect(result.items[0].corrected_label).toBe("hoodie");
    expect(result.items[0].label_source).toBe("user");
    expect(result.items[0].effective_label).toBe("hoodie");
  });

  test("rejects a blank (non-null) corrected_label", () => {
    const response = baseResponse({
      analysis: {
        items: [
          makeDetection({
            item_id: "item_001",
            corrected_label: "   ",
            label_source: "user",
            effective_label: "   ",
          }),
        ],
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/corrected_label must be null or a non-empty string/);
  });

  test("rejects label_source=\"user\" with no corrected_label", () => {
    const response = baseResponse({
      analysis: {
        items: [
          makeDetection({ item_id: "item_001", clean_label: "box", corrected_label: null, label_source: "user" }),
        ],
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/label_source.*does not agree/);
  });

  test("rejects label_source=\"detector\" when corrected_label is present", () => {
    const response = baseResponse({
      analysis: {
        items: [
          makeDetection({
            item_id: "item_001",
            clean_label: "box",
            corrected_label: "hoodie",
            label_source: "detector",
          }),
        ],
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/label_source.*does not agree/);
  });

  test("rejects an effective_label that does not equal corrected_label when corrected", () => {
    const response = baseResponse({
      analysis: {
        items: [
          makeDetection({
            item_id: "item_001",
            clean_label: "box",
            corrected_label: "hoodie",
            effective_label: "something-else",
          }),
        ],
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/effective_label does not equal/);
  });

  test("rejects an effective_label that does not equal clean_label when uncorrected", () => {
    const response = baseResponse({
      analysis: {
        items: [makeDetection({ item_id: "item_001", clean_label: "box", effective_label: "not-box" })],
      },
    });
    expect(() => normaliseDeclutterUploadResponse(response)).toThrow(/effective_label does not equal/);
  });
});

describe("normaliseOverrideResponse", () => {
  function baseOverrideResponse({ runId = "run_abc", analysis = {}, declutter = {} } = {}) {
    return {
      run_id: runId,
      analysis: baseAnalysis({ run_id: runId, ...analysis }),
      declutter: baseDeclutter({ run_id: runId, ...declutter }),
    };
  }

  test("has no path field, and is still accepted", () => {
    const response = baseOverrideResponse({
      analysis: { items: [makeDetection({ item_id: "item_001", clean_label: "box", corrected_label: "hoodie" })] },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision({ item_id: "item_001", decision: "sell" })],
        item_validity: { item_001: "mechanically_repaired" },
      },
    });
    expect(response.path).toBeUndefined();

    const result = normaliseOverrideResponse(response);

    expect(result.runId).toBe("run_abc");
    expect(result.items[0].effective_label).toBe("hoodie");
  });

  test("a successful correction of a resolved item is joined correctly", () => {
    const response = baseOverrideResponse({
      analysis: {
        items: [makeDetection({ item_id: "item_001", clean_label: "box", corrected_label: "hoodie" })],
      },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision({ item_id: "item_001", decision: "sell", reason: "still wearable" })],
        item_validity: { item_001: "mechanically_repaired" },
      },
    });

    const result = normaliseOverrideResponse(response);

    expect(result.items[0]).toMatchObject({
      item_id: "item_001",
      corrected_label: "hoodie",
      label_source: "user",
      effective_label: "hoodie",
      ai_decision: "sell",
      ai_reason: "still wearable",
      item_validity: "mechanically_repaired",
      is_expected: true,
      is_unresolved: false,
    });
  });

  test("a successful correction resolving a previously unresolved item", () => {
    const response = baseOverrideResponse({
      analysis: {
        items: [makeDetection({ item_id: "item_001", clean_label: "thing", corrected_label: "hoodie" })],
      },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [makeDecision({ item_id: "item_001", decision: "donate", reason: "x" })],
        unresolved_item_ids: [],
        item_validity: { item_001: "raw_valid" },
        is_complete: true,
      },
    });

    const result = normaliseOverrideResponse(response);

    expect(result.items[0].is_unresolved).toBe(false);
    expect(result.items[0].ai_decision).toBe("donate");
    expect(result.declutter.is_complete).toBe(true);
  });

  test("a failed correction leaves the item unresolved but keeps the corrected label", () => {
    const response = baseOverrideResponse({
      analysis: {
        items: [makeDetection({ item_id: "item_001", clean_label: "thing", corrected_label: "hoodie" })],
      },
      declutter: {
        expected_item_ids: ["item_001"],
        ai_decisions: [],
        unresolved_item_ids: ["item_001"],
        item_validity: { item_001: "still_invalid" },
        is_complete: false,
      },
    });

    const result = normaliseOverrideResponse(response);

    expect(result.items[0].is_unresolved).toBe(true);
    expect(result.items[0].ai_decision).toBeNull();
    expect(result.items[0].corrected_label).toBe("hoodie"); // preserved despite failure
    expect(result.items[0].effective_label).toBe("hoodie");
  });

  test("two same-label items remain independent after only one is corrected", () => {
    const response = baseOverrideResponse({
      analysis: {
        items: [
          makeDetection({ item_id: "item_004", clean_label: "picture frame", corrected_label: "painting" }),
          makeDetection({ item_id: "item_006", clean_label: "picture frame" }),
        ],
      },
      declutter: {
        expected_item_ids: ["item_004", "item_006"],
        ai_decisions: [
          makeDecision({ item_id: "item_004", decision: "keep" }),
          makeDecision({ item_id: "item_006", decision: "discard" }),
        ],
        item_validity: { item_004: "raw_valid", item_006: "raw_valid" },
      },
    });

    const result = normaliseOverrideResponse(response);

    const item004 = result.items.find((i) => i.item_id === "item_004");
    const item006 = result.items.find((i) => i.item_id === "item_006");
    expect(item004.effective_label).toBe("painting");
    expect(item004.label_source).toBe("user");
    expect(item006.effective_label).toBe("picture frame"); // untouched
    expect(item006.label_source).toBe("detector");
  });

  test("rejects a response whose analysis.run_id does not match the top-level run_id", () => {
    const response = baseOverrideResponse();
    response.analysis.run_id = "different_run";
    expect(() => normaliseOverrideResponse(response)).toThrow(/run_id/);
  });

  test("rejects a response whose declutter.run_id does not match the top-level run_id", () => {
    const response = baseOverrideResponse();
    response.declutter.run_id = "different_run";
    expect(() => normaliseOverrideResponse(response)).toThrow(/run_id/);
  });

  test("rejects a contradictory corrected-label/label_source pair, same as upload", () => {
    const response = baseOverrideResponse({
      analysis: {
        items: [
          makeDetection({ item_id: "item_001", clean_label: "box", corrected_label: "hoodie", label_source: "detector" }),
        ],
      },
    });
    expect(() => normaliseOverrideResponse(response)).toThrow(/label_source.*does not agree/);
  });

  test("does not require or reject a path field either way", () => {
    const withPath = baseOverrideResponse();
    withPath.path = "declutter"; // a stray path field must not be required NOR cause rejection
    expect(() => normaliseOverrideResponse(withPath)).not.toThrow();
  });
});
