// Shared review partitions, counts and confirmation guards.

// Unresolved expected items block confirmation; contextual items have no decision.
export function partitionReviewItems(reviewItems = []) {
  return {
    resolvedItems: reviewItems.filter((item) => item.is_expected && !item.is_unresolved),
    unresolvedItems: reviewItems.filter((item) => item.is_expected && item.is_unresolved),
    contextualItems: reviewItems.filter((item) => !item.is_expected),
  };
}

// Count decisions and review changes only for resolved items.
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

// Confirmation requires a complete result with no correction in flight.
export function isConfirmBlocked({ confirmationStatus, declutter, unresolvedCount, correctingItemId }) {
  return (
    confirmationStatus === "confirming" ||
    !declutter ||
    unresolvedCount > 0 ||
    correctingItemId !== null
  );
}

// Filter by current review_decision; exclusion does not change the bucket.
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

// Review can continue only with a complete result and no correction in flight.
export function canContinueToConfirm({ declutter, unresolvedCount, correctingItemId }) {
  return Boolean(declutter) && unresolvedCount === 0 && correctingItemId === null;
}
