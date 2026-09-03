import { describe, expect, test } from "vitest";
import {
  partitionReviewItems,
  deriveReviewCounts,
  totalStageDurationMs,
  isConfirmBlocked,
  canContinueToConfirm,
  REVIEW_DECISION_FILTERS,
  filterItemsByDecision,
  deriveDecisionFilterCounts,
} from "./declutterReview";

const resolved = (o = {}) => ({ is_expected: true, is_unresolved: false, ...o });
const unresolved = (o = {}) => ({ is_expected: true, is_unresolved: true, ...o });
const contextual = (o = {}) => ({ is_expected: false, is_unresolved: false, ...o });

describe("partitionReviewItems", () => {
  test("splits into resolved / unresolved / contextual by the contract flags", () => {
    const items = [
      resolved({ item_id: "a" }),
      unresolved({ item_id: "b" }),
      contextual({ item_id: "c" }),
      resolved({ item_id: "d" }),
    ];
    const { resolvedItems, unresolvedItems, contextualItems } = partitionReviewItems(items);
    expect(resolvedItems.map((i) => i.item_id)).toEqual(["a", "d"]);
    expect(unresolvedItems.map((i) => i.item_id)).toEqual(["b"]);
    expect(contextualItems.map((i) => i.item_id)).toEqual(["c"]);
  });

  test("empty input is safe", () => {
    expect(partitionReviewItems()).toEqual({ resolvedItems: [], unresolvedItems: [], contextualItems: [] });
  });
});

describe("deriveReviewCounts", () => {
  test("tallies decisions and changed/excluded evidence from resolved items only", () => {
    const items = [
      resolved({ review_decision: "keep" }),
      resolved({ review_decision: "keep", decision_changed: true }),
      resolved({ review_decision: "discard", review_excluded: true }),
      resolved({ review_decision: null }),
    ];
    const { counts, changedCount, excludedCount } = deriveReviewCounts(items);
    expect(counts).toEqual({ keep: 2, sell: 0, donate: 0, discard: 1 });
    expect(changedCount).toBe(1);
    expect(excludedCount).toBe(1);
  });
});

describe("totalStageDurationMs", () => {
  test("sums stage_timings, tolerating a missing analysis", () => {
    expect(totalStageDurationMs({ stage_timings: [{ duration_ms: 10 }, { duration_ms: 4500 }] })).toBe(4510);
    expect(totalStageDurationMs(null)).toBe(0);
    expect(totalStageDurationMs({})).toBe(0);
  });
});

describe("isConfirmBlocked, the exact guard", () => {
  const ok = { confirmationStatus: "idle", declutter: {}, unresolvedCount: 0, correctingItemId: null };
  test("false when nothing blocks", () => {
    expect(isConfirmBlocked(ok)).toBe(false);
  });
  test("true while confirming", () => {
    expect(isConfirmBlocked({ ...ok, confirmationStatus: "confirming" })).toBe(true);
  });
  test("true with no declutter result", () => {
    expect(isConfirmBlocked({ ...ok, declutter: null })).toBe(true);
  });
  test("true with an unresolved item", () => {
    expect(isConfirmBlocked({ ...ok, unresolvedCount: 1 })).toBe(true);
  });
  test("true while a correction is in flight", () => {
    expect(isConfirmBlocked({ ...ok, correctingItemId: "item_001" })).toBe(true);
  });
});

describe("canContinueToConfirm", () => {
  const ok = { declutter: {}, unresolvedCount: 0, correctingItemId: null };
  test("true only when a result exists, nothing is unresolved and no correction is running", () => {
    expect(canContinueToConfirm(ok)).toBe(true);
    expect(canContinueToConfirm({ ...ok, declutter: null })).toBe(false);
    expect(canContinueToConfirm({ ...ok, unresolvedCount: 2 })).toBe(false);
    expect(canContinueToConfirm({ ...ok, correctingItemId: "x" })).toBe(false);
  });
  test("does not care about confirmationStatus (that is a Confirm-step concern)", () => {
    expect(canContinueToConfirm(ok)).toBe(true);
  });
});

describe("decision filters", () => {
  const item = (id, decision) => ({ item_id: id, review_decision: decision, is_expected: true, is_unresolved: false });

  test("the filter set is All plus the four decisions, in order", () => {
    expect(REVIEW_DECISION_FILTERS.map((f) => f.id)).toEqual(["all", "keep", "sell", "donate", "discard"]);
    expect(REVIEW_DECISION_FILTERS.map((f) => f.label)).toEqual(["All", "Keep", "Sell", "Donate", "Discard"]);
  });

  test('"all" (or a missing filter) returns every item unchanged', () => {
    const items = [item("a", "keep"), item("b", "sell")];
    expect(filterItemsByDecision(items, "all")).toBe(items);
    expect(filterItemsByDecision(items)).toBe(items);
  });

  test("filters by the item's current review_decision, not its ai_decision", () => {
    const items = [
      { item_id: "a", review_decision: "keep", ai_decision: "discard" },
      { item_id: "b", review_decision: "discard", ai_decision: "keep" },
    ];
    expect(filterItemsByDecision(items, "keep").map((i) => i.item_id)).toEqual(["a"]);
    expect(filterItemsByDecision(items, "discard").map((i) => i.item_id)).toEqual(["b"]);
  });

  test("excluded items still fall under their current decision (exclusion is orthogonal)", () => {
    const items = [
      { item_id: "a", review_decision: "sell", review_excluded: true },
      { item_id: "b", review_decision: "sell", review_excluded: false },
    ];
    expect(filterItemsByDecision(items, "sell").map((i) => i.item_id)).toEqual(["a", "b"]);
  });

  test("counts cover All plus each decision and move with the current decision", () => {
    const items = [item("a", "keep"), item("b", "keep"), item("c", "sell"), item("d", "discard")];
    expect(deriveDecisionFilterCounts(items)).toEqual({ all: 4, keep: 2, sell: 1, donate: 0, discard: 1 });

    items[0].review_decision = "donate"; // user changes item a
    expect(deriveDecisionFilterCounts(items)).toEqual({ all: 4, keep: 1, sell: 1, donate: 1, discard: 1 });
  });

  test("a null or unknown review_decision is counted only in All", () => {
    expect(deriveDecisionFilterCounts([item("a", null), item("b", undefined)])).toEqual({
      all: 2, keep: 0, sell: 0, donate: 0, discard: 0,
    });
  });
});
