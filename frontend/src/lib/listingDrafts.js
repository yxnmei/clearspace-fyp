// Listing helpers use item_id identity. Eligibility comes only from confirmed
// decisions, never labels, draft presence, Keep ids or client fallbacks.

// Mirrored backend bounds used to validate editable copy text.
export const TITLE_MIN = 2;
export const TITLE_MAX = 120;
export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 1200;

// Fixed display text for sanitised unavailable reasons.
export const UNAVAILABLE_REASON_MESSAGES = {
  timeout: "The model took too long to write this draft. You can try regenerating it.",
  service_unavailable:
    "The drafting service was unavailable. You can try regenerating this draft in a moment.",
  invalid_output:
    "The model's response could not be used for this item. You can try regenerating it.",
  generation_failed: "This draft could not be generated. You can try regenerating it.",
};

const UNAVAILABLE_REASON_FALLBACK =
  "This draft could not be generated. You can try regenerating it.";

// Unknown reasons map to safe generic text.
export function unavailableReasonMessage(reason) {
  return UNAVAILABLE_REASON_MESSAGES[reason] ?? UNAVAILABLE_REASON_FALLBACK;
}

// Measure trimmed validity without mutating the user's raw text.
export function fieldValidity(value, min, max) {
  const text = typeof value === "string" ? value : "";
  const trimmedLength = text.trim().length;
  return {
    trimmedLength,
    min,
    max,
    tooShort: trimmedLength < min,
    tooLong: trimmedLength > max,
    valid: trimmedLength >= min && trimmedLength <= max,
  };
}

// Copy is valid only when both editable fields meet their bounds.
export function draftEditValidity(title, description) {
  const titleValidity = fieldValidity(title, TITLE_MIN, TITLE_MAX);
  const descriptionValidity = fieldValidity(description, DESCRIPTION_MIN, DESCRIPTION_MAX);
  return {
    title: titleValidity,
    description: descriptionValidity,
    valid: titleValidity.valid && descriptionValidity.valid,
  };
}

// Clipboard uses current title and description verbatim.
export function formatListingClipboardText(title, description) {
  return `${title}\n\n${description}`;
}

// Derive non-excluded Sell item_ids in confirmation order.
export function deriveEligibleSellItemIds(confirmation) {
  if (!confirmation || !Array.isArray(confirmation.confirmedDecisions)) return [];
  return confirmation.confirmedDecisions
    .filter((d) => d && d.confirmed_decision === "sell" && d.excluded === false)
    .map((d) => d.item_id);
}

// Seller details are item_id-keyed metadata, never decisions or eligibility.

export const LISTING_NAME_MAX = 80;

// not_specified supplies no condition; condition is never inferred.
export const LISTING_CONDITIONS = [
  { value: "not_specified", label: "Not specified" },
  { value: "new", label: "New" },
  { value: "like_new", label: "Like new" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
  { value: "well_used", label: "Well used" },
];

export const DEFAULT_LISTING_CONDITION = LISTING_CONDITIONS[0].value;

export function isListingCondition(value) {
  return LISTING_CONDITIONS.some((option) => option.value === value);
}

export function listingConditionLabel(value) {
  return LISTING_CONDITIONS.find((option) => option.value === value)?.label ?? LISTING_CONDITIONS[0].label;
}

// Explicit details override reviewed-label and not-specified defaults.
export function resolveListingDetails(itemId, detailsById, reviewItem) {
  const explicit = detailsById && detailsById[itemId] ? detailsById[itemId] : {};
  const fallbackName = reviewItem?.effective_label ?? reviewItem?.clean_label ?? "";
  const listingName = typeof explicit.listing_name === "string" ? explicit.listing_name : fallbackName;
  const condition = isListingCondition(explicit.condition) ? explicit.condition : DEFAULT_LISTING_CONDITION;
  return { listing_name: listingName, condition };
}

// Serialise in eligible order; null means use the detected label.
export function serialiseListingDetails(itemIds, detailsById, reviewItems) {
  const byId = new Map((reviewItems ?? []).map((item) => [item.item_id, item]));
  return itemIds.map((itemId) => {
    const details = resolveListingDetails(itemId, detailsById, byId.get(itemId));
    const trimmed = details.listing_name.trim();
    return {
      item_id: itemId,
      listing_name: trimmed === "" ? null : trimmed.slice(0, LISTING_NAME_MAX),
      condition: details.condition,
    };
  });
}

// Compare on request-normalised values so equivalent names are unchanged.
export function listingDetailsMatch(generatedWith, current) {
  if (!generatedWith || !current) return false;
  const normalise = (name) => {
    const trimmed = (typeof name === "string" ? name : "").trim();
    return trimmed === "" ? null : trimmed.slice(0, LISTING_NAME_MAX);
  };
  return (
    normalise(generatedWith.listing_name) === normalise(current.listing_name) &&
    (generatedWith.condition ?? DEFAULT_LISTING_CONDITION) === (current.condition ?? DEFAULT_LISTING_CONDITION)
  );
}
