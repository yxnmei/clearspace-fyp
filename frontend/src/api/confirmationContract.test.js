import { describe, expect, test } from "vitest";
import {
  buildReviewItems,
  clearDecisionOverride,
  normaliseConfirmationResponse,
  serialiseDecisionOverrides,
  setDecisionOverride,
  setItemExcluded,
} from "./confirmationContract";

function makeAiDecision(overrides = {}) {
  return { item_id: "item_001", decision: "keep", reason: "still useful", ...overrides };
}

function makeSourceDeclutter(overrides = {}) {
  return {
    run_id: "run1",
    expected_item_ids: ["item_001"],
    ai_decisions: [makeAiDecision()],
    unresolved_item_ids: [],
    item_validity: { item_001: "raw_valid" },
    ...overrides,
  };
}

function makeConfirmedDecision(overrides = {}) {
  return {
    item_id: "item_001",
    ai_decision: "keep",
    confirmed_decision: "keep",
    ai_reason: "still useful",
    user_reason: null,
    excluded: false,
    decision_changed: false,
    ...overrides,
  };
}

function makeConfirmationResponse(overrides = {}) {
  return {
    run_id: "run1",
    confirmed_decisions: [makeConfirmedDecision()],
    confirmed_keep_ids: ["item_001"],
    decision_changed_count: 0,
    excluded_count: 0,
    ...overrides,
  };
}

describe("normaliseConfirmationResponse", () => {
  test("valid response normalises correctly", () => {
    const source = makeSourceDeclutter();
    const response = makeConfirmationResponse();

    const result = normaliseConfirmationResponse(response, source);

    expect(result.runId).toBe("run1");
    expect(result.confirmedDecisions).toEqual(response.confirmed_decisions);
    expect(result.confirmedKeepIds).toEqual(["item_001"]);
    expect(result.decisionChangedCount).toBe(0);
    expect(result.excludedCount).toBe(0);
  });

  test("original response object is retained intact", () => {
    const source = makeSourceDeclutter();
    const response = makeConfirmationResponse();

    const result = normaliseConfirmationResponse(response, source);

    expect(result.response).toBe(response);
  });

  test("rejects a run_id mismatch between response and sourceDeclutter", () => {
    const source = makeSourceDeclutter({ run_id: "run1" });
    const response = makeConfirmationResponse({ run_id: "a_different_run" });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/run_id/);
  });

  test("rejects duplicate confirmed decision item_ids", () => {
    const source = makeSourceDeclutter({
      expected_item_ids: ["item_001", "item_002"],
      ai_decisions: [makeAiDecision({ item_id: "item_001" }), makeAiDecision({ item_id: "item_002" })],
    });
    const response = makeConfirmationResponse({
      confirmed_decisions: [
        makeConfirmedDecision({ item_id: "item_001" }),
        makeConfirmedDecision({ item_id: "item_001" }),
      ],
      confirmed_keep_ids: ["item_001"],
    });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/duplicate/i);
  });

  test("rejects a response missing a confirmed decision for an expected item", () => {
    const source = makeSourceDeclutter({
      expected_item_ids: ["item_001", "item_002"],
      ai_decisions: [makeAiDecision({ item_id: "item_001" }), makeAiDecision({ item_id: "item_002" })],
    });
    const response = makeConfirmationResponse({
      confirmed_decisions: [makeConfirmedDecision({ item_id: "item_001" })], // item_002 missing
      confirmed_keep_ids: ["item_001"],
    });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow();
  });

  test("rejects confirmed_decisions order differing from expected_item_ids order", () => {
    const source = makeSourceDeclutter({
      expected_item_ids: ["item_001", "item_002"],
      ai_decisions: [makeAiDecision({ item_id: "item_001" }), makeAiDecision({ item_id: "item_002" })],
    });
    const response = makeConfirmationResponse({
      confirmed_decisions: [
        makeConfirmedDecision({ item_id: "item_002" }),
        makeConfirmedDecision({ item_id: "item_001" }),
      ],
      confirmed_keep_ids: ["item_001", "item_002"],
    });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/order/);
  });

  test("rejects a confirmed decision whose ai_decision does not match the source", () => {
    const source = makeSourceDeclutter({ ai_decisions: [makeAiDecision({ decision: "keep" })] });
    const response = makeConfirmationResponse({
      confirmed_decisions: [makeConfirmedDecision({ ai_decision: "donate" })],
    });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/ai_decision/);
  });

  test("rejects a confirmed decision whose ai_reason does not match the source", () => {
    const source = makeSourceDeclutter({ ai_decisions: [makeAiDecision({ reason: "still useful" })] });
    const response = makeConfirmationResponse({
      confirmed_decisions: [makeConfirmedDecision({ ai_reason: "a different reason" })],
    });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/ai_reason/);
  });

  test("rejects an invalid confirmed_decision enum value", () => {
    const source = makeSourceDeclutter();
    const response = makeConfirmationResponse({
      confirmed_decisions: [makeConfirmedDecision({ confirmed_decision: "maybe-later" })],
    });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/valid decision/);
  });

  test("rejects a decision_changed value inconsistent with confirmed_decision/ai_decision", () => {
    const source = makeSourceDeclutter();
    const response = makeConfirmationResponse({
      confirmed_decisions: [
        makeConfirmedDecision({ ai_decision: "keep", confirmed_decision: "keep", decision_changed: true }),
      ],
    });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/decision_changed/);
  });

  test("rejects duplicate confirmed_keep_ids", () => {
    const source = makeSourceDeclutter();
    const response = makeConfirmationResponse({ confirmed_keep_ids: ["item_001", "item_001"] });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/duplicate/i);
  });

  test("rejects a confirmed_keep_id whose decision is not Keep", () => {
    const source = makeSourceDeclutter({ ai_decisions: [makeAiDecision({ decision: "donate" })] });
    const response = makeConfirmationResponse({
      confirmed_decisions: [makeConfirmedDecision({ ai_decision: "donate", confirmed_decision: "donate" })],
      confirmed_keep_ids: ["item_001"], // falsely claims item_001 is a confirmed Keep
    });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/confirmed_keep_ids/);
  });

  test("rejects an excluded Keep item still listed in confirmed_keep_ids", () => {
    const source = makeSourceDeclutter();
    const response = makeConfirmationResponse({
      confirmed_decisions: [makeConfirmedDecision({ confirmed_decision: "keep", excluded: true })],
      confirmed_keep_ids: ["item_001"],
    });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/confirmed_keep_ids/);
  });

  test("rejects a confirmed_keep_ids that omits a legitimate Keep item", () => {
    const source = makeSourceDeclutter();
    const response = makeConfirmationResponse({
      confirmed_decisions: [makeConfirmedDecision({ confirmed_decision: "keep", excluded: false })],
      confirmed_keep_ids: [],
    });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/confirmed_keep_ids/);
  });

  test("rejects a wrong decision_changed_count", () => {
    const source = makeSourceDeclutter();
    const response = makeConfirmationResponse({ decision_changed_count: 5 });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/decision_changed_count/);
  });

  test("rejects a wrong excluded_count", () => {
    const source = makeSourceDeclutter();
    const response = makeConfirmationResponse({ excluded_count: 5 });
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/excluded_count/);
  });

  test("rejects an incomplete source Declutter result", () => {
    const source = makeSourceDeclutter({ unresolved_item_ids: ["item_001"] });
    const response = makeConfirmationResponse();
    expect(() => normaliseConfirmationResponse(response, source)).toThrow(/complete/);
  });

  test("never uses label text for identity, two identical ai_decision/reason pairs stay independent by item_id", () => {
    const source = makeSourceDeclutter({
      expected_item_ids: ["item_004", "item_006"],
      ai_decisions: [
        makeAiDecision({ item_id: "item_004", decision: "discard", reason: "duplicate, low confidence" }),
        makeAiDecision({ item_id: "item_006", decision: "discard", reason: "duplicate, low confidence" }),
      ],
    });
    const response = makeConfirmationResponse({
      confirmed_decisions: [
        makeConfirmedDecision({
          item_id: "item_004",
          ai_decision: "discard",
          confirmed_decision: "donate",
          ai_reason: "duplicate, low confidence",
          decision_changed: true,
        }),
        makeConfirmedDecision({
          item_id: "item_006",
          ai_decision: "discard",
          confirmed_decision: "discard",
          ai_reason: "duplicate, low confidence",
          decision_changed: false,
        }),
      ],
      confirmed_keep_ids: [],
      decision_changed_count: 1,
    });

    const result = normaliseConfirmationResponse(response, source);

    const byId = Object.fromEntries(result.confirmedDecisions.map((c) => [c.item_id, c.confirmed_decision]));
    expect(byId).toEqual({ item_004: "donate", item_006: "discard" });
  });
});

describe("override-state helpers", () => {
  test("setDecisionOverride stores an override keyed by item_id", () => {
    const result = setDecisionOverride({}, "item_001", "donate");
    expect(result).toEqual({ item_001: { item_id: "item_001", decision: "donate" } });
  });

  test("same-label items remain independent under distinct item_ids", () => {
    let overrides = setDecisionOverride({}, "item_004", "discard");
    overrides = setDecisionOverride(overrides, "item_006", "donate");
    expect(overrides.item_004.decision).toBe("discard");
    expect(overrides.item_006.decision).toBe("donate");
  });

  test("setItemExcluded preserves an existing decision override", () => {
    let overrides = setDecisionOverride({}, "item_001", "donate");
    overrides = setItemExcluded(overrides, "item_001", true);
    expect(overrides.item_001).toEqual({ item_id: "item_001", excluded: true, decision: "donate" });
  });

  test("setDecisionOverride preserves an existing exclusion", () => {
    let overrides = setItemExcluded({}, "item_001", true);
    overrides = setDecisionOverride(overrides, "item_001", "sell");
    expect(overrides.item_001).toEqual({ item_id: "item_001", decision: "sell", excluded: true });
  });

  test("clearDecisionOverride removes only the targeted item", () => {
    let overrides = setDecisionOverride({}, "item_001", "donate");
    overrides = setDecisionOverride(overrides, "item_002", "discard");
    overrides = clearDecisionOverride(overrides, "item_001");
    expect(overrides).toEqual({ item_002: { item_id: "item_002", decision: "discard" } });
  });

  test("does not mutate the input overridesById object", () => {
    const original = { item_001: { item_id: "item_001", decision: "keep" } };
    Object.freeze(original);
    Object.freeze(original.item_001);

    expect(() => setDecisionOverride(original, "item_002", "donate")).not.toThrow();
    expect(() => setItemExcluded(original, "item_001", true)).not.toThrow();
    expect(() => clearDecisionOverride(original, "item_001")).not.toThrow();
  });

  test("serialiseDecisionOverrides follows expected-item order, not insertion order", () => {
    let overrides = setDecisionOverride({}, "item_002", "donate");
    overrides = setDecisionOverride(overrides, "item_001", "discard");
    const serialised = serialiseDecisionOverrides(overrides, ["item_001", "item_002"]);
    expect(serialised.map((o) => o.item_id)).toEqual(["item_001", "item_002"]);
  });

  test("serialiseDecisionOverrides rejects an override item_id outside expectedItemIds", () => {
    const overrides = setDecisionOverride({}, "item_999", "keep");
    expect(() => serialiseDecisionOverrides(overrides, ["item_001"])).toThrow();
  });

  test("setDecisionOverride rejects an invalid decision value", () => {
    expect(() => setDecisionOverride({}, "item_001", "maybe-later")).toThrow(/decision/);
  });

  describe("setDecisionOverride user_reason omission/null/blank/non-empty semantics", () => {
    test("changing decision without a reason argument preserves the old reason", () => {
      let overrides = setDecisionOverride({}, "item_001", "donate", "don't need it");
      overrides = setDecisionOverride(overrides, "item_001", "sell"); // userReason omitted entirely
      expect(overrides.item_001).toEqual({ item_id: "item_001", decision: "sell", user_reason: "don't need it" });
    });

    test("passing null clears an existing reason", () => {
      let overrides = setDecisionOverride({}, "item_001", "donate", "don't need it");
      overrides = setDecisionOverride(overrides, "item_001", "sell", null);
      expect(overrides.item_001).toEqual({ item_id: "item_001", decision: "sell" });
      expect(overrides.item_001.user_reason).toBeUndefined();
    });

    test("passing blank/whitespace text clears an existing reason", () => {
      let overrides = setDecisionOverride({}, "item_001", "donate", "don't need it");
      overrides = setDecisionOverride(overrides, "item_001", "sell", "   ");
      expect(overrides.item_001.user_reason).toBeUndefined();
    });

    test("passing non-empty text stores the trimmed value", () => {
      const overrides = setDecisionOverride({}, "item_001", "donate", "  no longer needed  ");
      expect(overrides.item_001.user_reason).toBe("no longer needed");
    });

    test("exclusion remains preserved throughout decision/reason changes", () => {
      let overrides = setItemExcluded({}, "item_001", true);
      overrides = setDecisionOverride(overrides, "item_001", "donate", "don't need it");
      expect(overrides.item_001.excluded).toBe(true);
      overrides = setDecisionOverride(overrides, "item_001", "sell"); // reason omitted
      expect(overrides.item_001).toEqual({
        item_id: "item_001",
        decision: "sell",
        excluded: true,
        user_reason: "don't need it",
      });
      overrides = setDecisionOverride(overrides, "item_001", "discard", null); // reason cleared
      expect(overrides.item_001).toEqual({ item_id: "item_001", decision: "discard", excluded: true });
    });
  });

  test("buildReviewItems never fabricates a decision for a contextual item", () => {
    const items = [{ item_id: "item_099", is_expected: false, is_unresolved: false, ai_decision: null }];
    const result = buildReviewItems(items, {});
    expect(result[0].review_decision).toBeNull();
    expect(result[0].has_decision_override).toBe(false);
  });

  test("buildReviewItems never fabricates a decision for an unresolved item, even with a stray override", () => {
    const items = [
      { item_id: "item_003", is_expected: true, is_unresolved: true, ai_decision: null, item_validity: "still_invalid" },
    ];
    // A stray override entry that should never have been created for an
    // unresolved item (the hook's own guard rejects this in practice),
    // buildReviewItems must not trust it either, defensively.
    const strayOverrides = setDecisionOverride({}, "item_003", "donate", "just in case");

    const result = buildReviewItems(items, strayOverrides);

    expect(result[0].review_decision).toBeNull();
    expect(result[0].review_excluded).toBe(false);
    expect(result[0].review_user_reason).toBeNull();
    expect(result[0].decision_changed).toBe(false);
    expect(result[0].has_decision_override).toBe(false);
    // Original fields preserved unchanged.
    expect(result[0].is_expected).toBe(true);
    expect(result[0].is_unresolved).toBe(true);
  });

  describe("serialiseDecisionOverrides hardening", () => {
    test("rejects a non-object overridesById", () => {
      expect(() => serialiseDecisionOverrides(null, ["item_001"])).toThrow(/overridesById/);
      expect(() => serialiseDecisionOverrides([], ["item_001"])).toThrow(/overridesById/);
    });

    test("rejects a malformed (non-object) override entry", () => {
      const overrides = { item_001: "not an object" };
      expect(() => serialiseDecisionOverrides(overrides, ["item_001"])).toThrow(/must be an object/);
    });

    test("rejects an override whose item_id does not match its overridesById key", () => {
      const overrides = { item_001: { item_id: "item_002", decision: "keep" } };
      expect(() => serialiseDecisionOverrides(overrides, ["item_001", "item_002"])).toThrow(/does not match/);
    });

    test("rejects an override with an invalid decision value", () => {
      const overrides = { item_001: { item_id: "item_001", decision: "maybe-later" } };
      expect(() => serialiseDecisionOverrides(overrides, ["item_001"])).toThrow(/invalid decision/);
    });

    test("rejects an override with a non-boolean excluded value", () => {
      const overrides = { item_001: { item_id: "item_001", excluded: "yes" } };
      expect(() => serialiseDecisionOverrides(overrides, ["item_001"])).toThrow(/excluded/);
    });

    test("rejects duplicate expectedItemIds", () => {
      const overrides = { item_001: { item_id: "item_001", decision: "keep" } };
      expect(() => serialiseDecisionOverrides(overrides, ["item_001", "item_001"])).toThrow(/duplicate/i);
    });
  });

  test("buildReviewItems reflects an override's decision and exclusion", () => {
    const items = [{ item_id: "item_001", is_expected: true, is_unresolved: false, ai_decision: "keep" }];
    let overrides = setDecisionOverride({}, "item_001", "donate");
    overrides = setItemExcluded(overrides, "item_001", true);

    const result = buildReviewItems(items, overrides);

    expect(result[0].review_decision).toBe("donate");
    expect(result[0].review_excluded).toBe(true);
    expect(result[0].has_decision_override).toBe(true);
  });

  test("buildReviewItems derives decision_changed correctly", () => {
    const items = [
      { item_id: "item_001", is_expected: true, is_unresolved: false, ai_decision: "keep" },
      { item_id: "item_002", is_expected: true, is_unresolved: false, ai_decision: "keep" },
    ];
    const overrides = setDecisionOverride({}, "item_001", "donate");

    const result = buildReviewItems(items, overrides);

    expect(result.find((i) => i.item_id === "item_001").decision_changed).toBe(true);
    expect(result.find((i) => i.item_id === "item_002").decision_changed).toBe(false);
  });
});
