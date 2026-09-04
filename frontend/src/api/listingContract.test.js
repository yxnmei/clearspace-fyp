import { describe, expect, test } from "vitest";

import { normaliseConfirmationResponse } from "./confirmationContract";
import { normaliseListingResponse, normaliseSingleListingResponse } from "./listingContract";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value));

// items: [{ id, ai, reason, decision, excluded, userReason?, label }]
// Produces a fully self-consistent { sourceDeclutter, confirmationResponse,
// currentConfirmed, reviewItems, eligibleIds } bundle.
function scenario(items) {
  const runId = "run1";
  const sourceDeclutter = {
    run_id: runId,
    expected_item_ids: items.map((it) => it.id),
    ai_decisions: items.map((it) => ({ item_id: it.id, decision: it.ai, reason: it.reason })),
    unresolved_item_ids: [],
  };
  const confirmed_decisions = items.map((it) => ({
    item_id: it.id,
    ai_decision: it.ai,
    confirmed_decision: it.decision,
    ai_reason: it.reason,
    user_reason: it.userReason ?? null,
    excluded: it.excluded,
    decision_changed: it.decision !== it.ai,
  }));
  const confirmationResponse = {
    run_id: runId,
    confirmed_decisions,
    confirmed_keep_ids: confirmed_decisions
      .filter((d) => d.confirmed_decision === "keep" && !d.excluded)
      .map((d) => d.item_id),
    decision_changed_count: confirmed_decisions.filter((d) => d.decision_changed).length,
    excluded_count: confirmed_decisions.filter((d) => d.excluded).length,
  };
  const currentConfirmed = normaliseConfirmationResponse(clone(confirmationResponse), clone(sourceDeclutter));
  const reviewItems = items.map((it) => ({ item_id: it.id, effective_label: it.label }));
  const eligibleIds = confirmed_decisions
    .filter((d) => d.confirmed_decision === "sell" && !d.excluded)
    .map((d) => d.item_id);
  return { runId, sourceDeclutter, confirmationResponse, currentConfirmed, reviewItems, eligibleIds };
}

function generatedDraft(id, label, over = {}) {
  return {
    item_id: id,
    effective_label: label,
    status: "generated",
    title: "Wooden chair",
    description: "A used wooden chair in ordinary condition.",
    unavailable_reason: null,
    was_repaired: false,
    attempts: 1,
    ...over,
  };
}

function unavailableDraft(id, label, over = {}) {
  return {
    item_id: id,
    effective_label: label,
    status: "unavailable",
    title: null,
    description: null,
    unavailable_reason: "generation_failed",
    was_repaired: null,
    attempts: 3,
    ...over,
  };
}

function batchResponse(scen, drafts, over = {}) {
  const nonEmpty = drafts.length > 0;
  return {
    run_id: scen.runId,
    confirmation: clone(scen.confirmationResponse),
    drafts,
    model_name: nonEmpty ? "phi4-mini" : null,
    prompt_version: nonEmpty ? "v1" : null,
    max_attempts: nonEmpty ? 3 : null,
    ...over,
  };
}

function singleResponse(scen, draft, over = {}) {
  return {
    run_id: scen.runId,
    confirmation: clone(scen.confirmationResponse),
    draft,
    model_name: "phi4-mini",
    prompt_version: "v1",
    max_attempts: 3,
    ...over,
  };
}

// A convenient default: 3 items, two eligible Sell (item_001, item_003).
function threeItemScenario() {
  return scenario([
    { id: "item_001", ai: "sell", reason: "r1", decision: "sell", excluded: false, label: "lamp" },
    { id: "item_002", ai: "keep", reason: "r2", decision: "keep", excluded: false, label: "chair" },
    { id: "item_003", ai: "sell", reason: "r3", decision: "sell", excluded: false, label: "book" },
  ]);
}

function ctx(scen, extra = {}) {
  return {
    runId: scen.runId,
    sourceDeclutter: scen.sourceDeclutter,
    currentConfirmed: scen.currentConfirmed,
    currentReviewItems: scen.reviewItems,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// normaliseListingResponse - valid results
// ---------------------------------------------------------------------------

describe("normaliseListingResponse - valid", () => {
  test("a fully generated batch normalises", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [
      generatedDraft("item_001", "lamp"),
      generatedDraft("item_003", "book", { was_repaired: true, attempts: 2 }),
    ]);

    const result = normaliseListingResponse(response, ctx(scen));

    expect(result.runId).toBe("run1");
    expect(result.eligibleItemIds).toEqual(["item_001", "item_003"]);
    expect(result.modelName).toBe("phi4-mini");
    expect(result.promptVersion).toBe("v1");
    expect(result.maxAttempts).toBe(3);
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0]).toEqual({
      item_id: "item_001",
      effective_label: "lamp",
      status: "generated",
      title: "Wooden chair",
      description: "A used wooden chair in ordinary condition.",
      unavailable_reason: null,
      was_repaired: false,
      attempts: 1,
    });
    expect(result.drafts[1].was_repaired).toBe(true);
    expect(result.drafts[1].attempts).toBe(2);
    expect(result.confirmation.runId).toBe("run1");
    // identity stays item_id - no `id` alias anywhere
    expect(result.drafts[0]).not.toHaveProperty("id");
  });

  test("a partial-unavailable batch normalises (unavailable is a success)", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [
      generatedDraft("item_001", "lamp"),
      unavailableDraft("item_003", "book", { unavailable_reason: "timeout" }),
    ]);

    const result = normaliseListingResponse(response, ctx(scen));

    expect(result.drafts[1]).toEqual({
      item_id: "item_003",
      effective_label: "book",
      status: "unavailable",
      title: null,
      description: null,
      unavailable_reason: "timeout",
      was_repaired: null,
      attempts: 3,
    });
  });

  test("a zero-eligible batch normalises to an empty result with null provenance", () => {
    const scen = scenario([
      { id: "item_001", ai: "keep", reason: "r1", decision: "keep", excluded: false, label: "lamp" },
      { id: "item_002", ai: "donate", reason: "r2", decision: "donate", excluded: false, label: "chair" },
    ]);
    const response = batchResponse(scen, []);

    const result = normaliseListingResponse(response, ctx(scen));

    expect(result.eligibleItemIds).toEqual([]);
    expect(result.drafts).toEqual([]);
    expect(result.modelName).toBeNull();
    expect(result.promptVersion).toBeNull();
    expect(result.maxAttempts).toBeNull();
  });

  test("excluded Sell and non-Sell items are not eligible and get no draft", () => {
    const scen = scenario([
      { id: "item_001", ai: "sell", reason: "r1", decision: "sell", excluded: true, label: "lamp" },
      { id: "item_002", ai: "sell", reason: "r2", decision: "sell", excluded: false, label: "chair" },
      { id: "item_003", ai: "keep", reason: "r3", decision: "keep", excluded: false, label: "book" },
    ]);
    const response = batchResponse(scen, [generatedDraft("item_002", "chair")]);

    const result = normaliseListingResponse(response, ctx(scen));
    expect(result.eligibleItemIds).toEqual(["item_002"]);
    expect(result.drafts.map((d) => d.item_id)).toEqual(["item_002"]);
  });

  test("duplicate labels with distinct item_ids are accepted", () => {
    const scen = scenario([
      { id: "item_001", ai: "sell", reason: "r1", decision: "sell", excluded: false, label: "book" },
      { id: "item_002", ai: "sell", reason: "r2", decision: "sell", excluded: false, label: "book" },
    ]);
    const response = batchResponse(scen, [
      generatedDraft("item_001", "book"),
      generatedDraft("item_002", "book"),
    ]);

    const result = normaliseListingResponse(response, ctx(scen));
    expect(result.drafts.map((d) => d.item_id)).toEqual(["item_001", "item_002"]);
  });

  test("a corrected effective_label is matched (equality, not label text)", () => {
    const scen = scenario([
      { id: "item_001", ai: "sell", reason: "r1", decision: "sell", excluded: false, label: "necklace" },
    ]);
    // review item carries the corrected label; the draft must equal it
    const response = batchResponse(scen, [generatedDraft("item_001", "necklace")]);
    expect(() => normaliseListingResponse(response, ctx(scen))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// top-level shape
// ---------------------------------------------------------------------------

describe("normaliseListingResponse - top-level shape", () => {
  test("a non-object response throws", () => {
    expect(() => normaliseListingResponse(null, ctx(threeItemScenario()))).toThrow(/listingContract/);
    expect(() => normaliseListingResponse([], ctx(threeItemScenario()))).toThrow(/listingContract/);
  });

  test("a missing top-level field throws", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")]);
    delete response.max_attempts;
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/missing field/);
  });

  test("an unexpected top-level field throws", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")]);
    response.published = true;
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/unexpected field/);
  });

  test("a run_id mismatch throws", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")]);
    response.run_id = "run-other";
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/run_id/);
  });
});

// ---------------------------------------------------------------------------
// confirmation cross-check
// ---------------------------------------------------------------------------

describe("normaliseListingResponse - confirmation cross-check", () => {
  test("a confirmation whose decisions differ from the current confirmed result is rejected as stale", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")]);
    // The listing response was somehow computed with item_003 flipped to donate.
    response.confirmation.confirmed_decisions[2].confirmed_decision = "donate";
    response.confirmation.confirmed_decisions[2].decision_changed = true;
    response.confirmation.decision_changed_count = 1;
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/differs from the current confirmed result/);
  });

  test("an exclusion mismatch vs the current confirmed result is rejected", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp")]);
    response.confirmation.confirmed_decisions[2].excluded = true;
    response.confirmation.excluded_count = 1;
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/differs from the current confirmed result/);
  });

  test("an inconsistent confirmed_keep_ids in the listing response is rejected (never trusted at face value)", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")]);
    response.confirmation.confirmed_keep_ids = ["item_002", "item_999"];
    // Rejected by the reused confirmation validator (item_999 is not a
    // confirmed decision) - the listing normaliser never sees a
    // half-validated confirmation.
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/keep_id/i);
  });

  test("a keep-set that is internally valid but drifted from current is rejected via the decision cross-check", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp")]);
    // item_002 was Keep; flip it (and its keep-id) so the response is
    // internally consistent but no longer matches currentConfirmed.
    response.confirmation.confirmed_decisions[1].confirmed_decision = "donate";
    response.confirmation.confirmed_decisions[1].decision_changed = true;
    response.confirmation.confirmed_keep_ids = [];
    response.confirmation.decision_changed_count = 1;
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/differs from the current confirmed result/);
  });

  test("a malformed currentConfirmed throws loudly rather than passing", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")]);
    expect(() => normaliseListingResponse(response, ctx(scen, { currentConfirmed: { runId: "run1" } }))).toThrow(
      /currentConfirmed/
    );
  });
});

// ---------------------------------------------------------------------------
// draft id set / order
// ---------------------------------------------------------------------------

describe("normaliseListingResponse - draft id set and order", () => {
  test("a missing eligible draft id throws", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp")]);
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/omit eligible Sell item_id/);
  });

  test("a duplicate draft id throws", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [
      generatedDraft("item_001", "lamp"),
      generatedDraft("item_001", "lamp"),
    ]);
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/duplicate draft item_id/);
  });

  test("an unexpected (non-eligible) draft id throws", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [
      generatedDraft("item_001", "lamp"),
      generatedDraft("item_003", "book"),
      generatedDraft("item_002", "chair"),
    ]);
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/not eligible Sell items/);
  });

  test("a reordered draft list throws", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [
      generatedDraft("item_003", "book"),
      generatedDraft("item_001", "lamp"),
    ]);
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/order/);
  });

  test("an excluded Sell id appearing as a draft is unexpected", () => {
    const scen = scenario([
      { id: "item_001", ai: "sell", reason: "r1", decision: "sell", excluded: false, label: "lamp" },
      { id: "item_002", ai: "sell", reason: "r2", decision: "sell", excluded: true, label: "chair" },
    ]);
    const response = batchResponse(scen, [
      generatedDraft("item_001", "lamp"),
      generatedDraft("item_002", "chair"),
    ]);
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/not eligible Sell items/);
  });
});

// ---------------------------------------------------------------------------
// review item join
// ---------------------------------------------------------------------------

describe("normaliseListingResponse - review item join", () => {
  test("a missing current review item for an eligible draft throws (no silent accept)", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")]);
    const reviewItems = scen.reviewItems.filter((it) => it.item_id !== "item_003");
    expect(() => normaliseListingResponse(response, ctx(scen, { currentReviewItems: reviewItems }))).toThrow(
      /no matching current review item/
    );
  });

  test("an effective_label mismatch throws (no label-text fallback)", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [
      generatedDraft("item_001", "lamp"),
      generatedDraft("item_003", "book"),
    ]);
    response.drafts[1].effective_label = "paperback";
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/does not equal the current review/);
  });

  test("duplicate review item ids throw", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")]);
    const reviewItems = [...scen.reviewItems, { item_id: "item_001", effective_label: "lamp" }];
    expect(() => normaliseListingResponse(response, ctx(scen, { currentReviewItems: reviewItems }))).toThrow(
      /duplicate currentReviewItems item_id/
    );
  });
});

// ---------------------------------------------------------------------------
// draft field validation
// ---------------------------------------------------------------------------

describe("normaliseListingResponse - draft field validation", () => {
  const scen = threeItemScenario();
  const run = (draftOver, name = "item_003") => {
    const response = batchResponse(scen, [
      generatedDraft("item_001", "lamp"),
      { ...generatedDraft(name, name === "item_003" ? "book" : "lamp"), ...draftOver },
    ]);
    return () => normaliseListingResponse(response, ctx(scen));
  };

  test("a missing draft field throws", () => {
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")]);
    delete response.drafts[1].was_repaired;
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/missing field/);
  });

  test("an unexpected draft field throws", () => {
    expect(run({ price: 10 })).toThrow(/unexpected field/);
  });

  test("an unknown status throws", () => {
    expect(run({ status: "pending" })).toThrow(/status/);
  });

  test("an unknown unavailable_reason throws", () => {
    expect(run({ status: "unavailable", title: null, description: null, was_repaired: null, unavailable_reason: "disk_full" })).toThrow(
      /not recognised/
    );
  });

  test("a generated draft missing title throws", () => {
    expect(run({ title: null })).toThrow(/title/);
  });

  test("a generated draft missing description throws", () => {
    expect(run({ description: null })).toThrow(/description/);
  });

  test("a generated draft carrying an unavailable_reason throws", () => {
    expect(run({ unavailable_reason: "timeout" })).toThrow(/must be null for a generated draft/);
  });

  test("an unavailable draft carrying title text throws", () => {
    expect(run({ status: "unavailable", title: "Chair", description: null, was_repaired: null, unavailable_reason: "timeout" })).toThrow(
      /must be null for an unavailable draft/
    );
  });

  test("an unavailable draft carrying was_repaired throws", () => {
    expect(run({ status: "unavailable", title: null, description: null, was_repaired: false, unavailable_reason: "timeout" })).toThrow(
      /must be null for an unavailable draft/
    );
  });

  test("a generated draft with a non-boolean was_repaired throws", () => {
    expect(run({ was_repaired: "true" })).toThrow(/genuine boolean/);
    expect(run({ was_repaired: 1 })).toThrow(/genuine boolean/);
    expect(run({ was_repaired: null })).toThrow(/genuine boolean/);
  });

  test("a blank / too-short / oversized / padded title throws", () => {
    expect(run({ title: "" })).toThrow(/title/);
    expect(run({ title: "a" })).toThrow(/title/);
    expect(run({ title: "x".repeat(121) })).toThrow(/title/);
    expect(run({ title: " Chair" })).toThrow(/whitespace/);
    expect(run({ title: "Chair " })).toThrow(/whitespace/);
  });

  test("a too-short / oversized / padded description throws", () => {
    expect(run({ description: "too short" })).toThrow(/description/);
    expect(run({ description: "y".repeat(1201) })).toThrow(/description/);
    expect(run({ description: " leading is drift here." })).toThrow(/whitespace/);
  });

  test("attempts as a boolean / numeric string / NaN / Infinity / float throws", () => {
    expect(run({ attempts: true })).toThrow(/genuine integer/);
    expect(run({ attempts: "2" })).toThrow(/genuine integer/);
    expect(run({ attempts: Number.NaN })).toThrow(/genuine integer/);
    expect(run({ attempts: Number.POSITIVE_INFINITY })).toThrow(/genuine integer/);
    expect(run({ attempts: 2.5 })).toThrow(/genuine integer/);
  });

  test("attempts of 0 or above 5 throws", () => {
    expect(run({ attempts: 0 })).toThrow(/\[1, 5\]/);
    expect(run({ attempts: 6 })).toThrow(/\[1, 5\]/);
  });

  test("attempts greater than max_attempts throws", () => {
    const response = batchResponse(
      scen,
      [generatedDraft("item_001", "lamp", { attempts: 2 }), generatedDraft("item_003", "book", { attempts: 5 })],
      { max_attempts: 3 }
    );
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/greater than max_attempts/);
  });
});

// ---------------------------------------------------------------------------
// provenance / empty rules
// ---------------------------------------------------------------------------

describe("normaliseListingResponse - provenance / empty rules", () => {
  test("an empty result carrying model provenance throws", () => {
    const scen = scenario([
      { id: "item_001", ai: "keep", reason: "r1", decision: "keep", excluded: false, label: "lamp" },
    ]);
    const response = batchResponse(scen, [], { model_name: "phi4-mini", prompt_version: null, max_attempts: null });
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/model_name must be null/);
  });

  test("an empty result carrying max_attempts throws", () => {
    const scen = scenario([
      { id: "item_001", ai: "keep", reason: "r1", decision: "keep", excluded: false, label: "lamp" },
    ]);
    const response = batchResponse(scen, [], { model_name: null, prompt_version: null, max_attempts: 3 });
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/max_attempts must be null/);
  });

  test("a non-empty result missing model_name throws", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")], {
      model_name: null,
    });
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/model_name/);
  });

  test("a non-empty result missing prompt_version throws", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")], {
      prompt_version: "  ",
    });
    expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/prompt_version/);
  });

  test("max_attempts as a boolean / string / 0 / 6 / NaN throws", () => {
    const scen = threeItemScenario();
    const drafts = [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")];
    for (const bad of [true, "3", 0, 6, Number.NaN, 2.5]) {
      const response = batchResponse(scen, drafts, { max_attempts: bad });
      expect(() => normaliseListingResponse(response, ctx(scen))).toThrow(/max_attempts/);
    }
  });
});

// ---------------------------------------------------------------------------
// normaliseSingleListingResponse
// ---------------------------------------------------------------------------

describe("normaliseSingleListingResponse", () => {
  test("a valid generated single response normalises", () => {
    const scen = threeItemScenario();
    const response = singleResponse(scen, generatedDraft("item_003", "book", { attempts: 2 }));

    const result = normaliseSingleListingResponse(response, ctx(scen, { itemId: "item_003" }));

    expect(result.runId).toBe("run1");
    expect(result.draft.item_id).toBe("item_003");
    expect(result.draft.status).toBe("generated");
    expect(result.draft.attempts).toBe(2);
    expect(result.modelName).toBe("phi4-mini");
    expect(result.maxAttempts).toBe(3);
    expect(result.eligibleItemIds).toEqual(["item_001", "item_003"]);
  });

  test("a valid unavailable single response normalises", () => {
    const scen = threeItemScenario();
    const response = singleResponse(scen, unavailableDraft("item_001", "lamp", { unavailable_reason: "service_unavailable" }));

    const result = normaliseSingleListingResponse(response, ctx(scen, { itemId: "item_001" }));
    expect(result.draft.status).toBe("unavailable");
    expect(result.draft.unavailable_reason).toBe("service_unavailable");
    expect(result.draft.title).toBeNull();
  });

  test("there is no empty case - missing provenance always throws", () => {
    const scen = threeItemScenario();
    const response = singleResponse(scen, generatedDraft("item_003", "book"), { model_name: null });
    expect(() => normaliseSingleListingResponse(response, ctx(scen, { itemId: "item_003" }))).toThrow(/model_name/);
  });

  test("a draft for a different item than requested is rejected (no substitution)", () => {
    const scen = threeItemScenario();
    const response = singleResponse(scen, generatedDraft("item_001", "lamp"));
    expect(() => normaliseSingleListingResponse(response, ctx(scen, { itemId: "item_003" }))).toThrow(
      /another eligible item cannot be substituted/
    );
  });

  test("a request for a non-eligible itemId is rejected", () => {
    const scen = threeItemScenario();
    const response = singleResponse(scen, generatedDraft("item_002", "chair"));
    expect(() => normaliseSingleListingResponse(response, ctx(scen, { itemId: "item_002" }))).toThrow(
      /not currently a confirmed non-excluded Sell item/
    );
  });

  test("a malformed itemId is rejected", () => {
    const scen = threeItemScenario();
    const response = singleResponse(scen, generatedDraft("item_003", "book"));
    expect(() => normaliseSingleListingResponse(response, ctx(scen, { itemId: "not-an-item" }))).toThrow(/itemId/);
  });

  test("the exact single top-level shape is required", () => {
    const scen = threeItemScenario();
    const response = singleResponse(scen, generatedDraft("item_003", "book"));
    response.drafts = [];
    expect(() => normaliseSingleListingResponse(response, ctx(scen, { itemId: "item_003" }))).toThrow(/unexpected field/);
  });

  test("run_id mismatch throws", () => {
    const scen = threeItemScenario();
    const response = singleResponse(scen, generatedDraft("item_003", "book"), { run_id: "run-other" });
    expect(() => normaliseSingleListingResponse(response, ctx(scen, { itemId: "item_003" }))).toThrow(/run_id/);
  });

  test("a stale confirmation (different overrides) throws", () => {
    const scen = threeItemScenario();
    const response = singleResponse(scen, generatedDraft("item_003", "book"));
    response.confirmation.confirmed_decisions[0].confirmed_decision = "donate";
    response.confirmation.confirmed_decisions[0].decision_changed = true;
    response.confirmation.decision_changed_count = 1;
    // item_001 was the other eligible; with it donated, eligibleIds no longer match either
    expect(() => normaliseSingleListingResponse(response, ctx(scen, { itemId: "item_003" }))).toThrow(/listingContract/);
  });

  test("draft field rules are identical to the batch normaliser", () => {
    const scen = threeItemScenario();
    const bad = singleResponse(scen, generatedDraft("item_003", "book", { attempts: "2" }));
    expect(() => normaliseSingleListingResponse(bad, ctx(scen, { itemId: "item_003" }))).toThrow(/genuine integer/);

    const overBudget = singleResponse(scen, generatedDraft("item_003", "book", { attempts: 5 }), { max_attempts: 3 });
    expect(() => normaliseSingleListingResponse(overBudget, ctx(scen, { itemId: "item_003" }))).toThrow(
      /greater than max_attempts/
    );

    const labelMismatch = singleResponse(scen, generatedDraft("item_003", "book", { effective_label: "paperback" }));
    expect(() => normaliseSingleListingResponse(labelMismatch, ctx(scen, { itemId: "item_003" }))).toThrow(
      /does not equal the current review/
    );
  });
});

// ---------------------------------------------------------------------------
// input immutability & no silent fallback
// ---------------------------------------------------------------------------

describe("normaliseListingResponse - hygiene", () => {
  test("does not mutate the response, confirmed result or review items", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")]);
    const responseSnapshot = clone(response);
    const reviewSnapshot = clone(scen.reviewItems);
    const confirmedSnapshot = clone(scen.currentConfirmed);

    normaliseListingResponse(response, ctx(scen));

    expect(response).toEqual(responseSnapshot);
    expect(scen.reviewItems).toEqual(reviewSnapshot);
    expect(scen.currentConfirmed).toEqual(confirmedSnapshot);
  });

  test("malformed data throws rather than returning an empty draft list", () => {
    const scen = threeItemScenario();
    const response = batchResponse(scen, [generatedDraft("item_001", "lamp"), generatedDraft("item_003", "book")]);
    response.drafts = "not an array";
    let threw = false;
    try {
      normaliseListingResponse(response, ctx(scen));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
