// Pure derivations shared by the Declutter review surfaces, the compact
// wizard Review view and the stacked DeclutterReview that Both still
// consumes. Keeping the partition, counts and the confirmation guard in
// one place means neither surface re-implements them.

// The backend contract distinguishes three item groups: resolved expected
// items (a real decision to review), unresolved expected items (no valid
// AI decision, these block confirmation), and contextual detections
// (never sent for a Declutter decision).
export function partitionReviewItems(reviewItems = []) {
  return {
    resolvedItems: reviewItems.filter((item) => item.is_expected && !item.is_unresolved),
    unresolvedItems: reviewItems.filter((item) => item.is_expected && item.is_unresolved),
    contextualItems: reviewItems.filter((item) => !item.is_expected),
  };
}

// Decision tallies + changed/excluded evidence, computed only from the
// resolved items (the only ones that carry a review decision).
export function deriveReviewCounts(resolvedItems = []) {
  const counts = { keep: 0, sell: 0, donate: 0, discard: 0 };
  let changedCount = 0;
  let excludedCount = 0;
  for (const item of resolvedItems) {
    if (item.review_decision) counts[item.review_decision] += 1;
    if (item.decision_changed) changedCount += 1;
    if (item.review_excluded) excludedCount += 1;
  }
  return { counts, changedCount, excludedCount };
}

export function totalStageDurationMs(analysis) {
  return (analysis?.stage_timings ?? []).reduce((sum, stage) => sum + stage.duration_ms, 0);
}

// The exact confirmation guard: unchanged meaning from the original
// DeclutterReview,
//   confirmationStatus === "confirming" || !declutter ||
//   unresolvedCount > 0 || correctingItemId !== null
export function isConfirmBlocked({ confirmationStatus, declutter, unresolvedCount, correctingItemId }) {
  return (
    confirmationStatus === "confirming" ||
    !declutter ||
    unresolvedCount > 0 ||
    correctingItemId !== null
  );
}

// The Review workspace decision filter: "all" plus the four decisions.
// Filtering is always by an item's CURRENT effective review_decision,
// never its original ai_decision, so an item moves between filters the
// instant the user changes its decision. Exclusion is orthogonal: an
// excluded item still sits under its current decision.
export const REVIEW_DECISION_FILTERS = [
  { id: "all", label: "All" },
  { id: "keep", label: "Keep" },
  { id: "sell", label: "Sell" },
  { id: "donate", label: "Donate" },
  { id: "discard", label: "Discard" },
];

export function filterItemsByDecision(items = [], filterId = "all") {
  if (!filterId || filterId === "all") return items;
  return items.filter((item) => item.review_decision === filterId);
}

export function deriveDecisionFilterCounts(resolvedItems = []) {
  const counts = { all: resolvedItems.length, keep: 0, sell: 0, donate: 0, discard: 0 };
  for (const item of resolvedItems) {
    if (Object.prototype.hasOwnProperty.call(counts, item.review_decision)) {
      counts[item.review_decision] += 1;
    }
  }
  return counts;
}

// Whether the wizard's "Continue to Confirm" acknowledgement is allowed.
// It is a subset of the confirmation guard: the "confirming" clause is
// irrelevant here (you are still on Review), but a missing result, any
// unresolved item, or a label correction in flight all block it.
export function canContinueToConfirm({ declutter, unresolvedCount, correctingItemId }) {
  return Boolean(declutter) && unresolvedCount === 0 && correctingItemId === null;
}
