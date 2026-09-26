// Pure helpers for the marketplace-listing review UI. No
// React/DOM/fetch/clipboard here, same convention as lib/declutterReview.js
// and lib/workflowProgress.js: this file only does maths and string
// mapping so ListingsView / ListingDraftCard stay presentational.
//
// Identity is always item_id. Eligibility is derived STRICTLY from the
// confirmed decisions, never from labels, draft presence, Keep ids or
// any client-supplied fallback list.

// Backend bounds, mirrored from app/core/listing_schemas.py and enforced
// again by api/listingContract.js. The UI shows these numbers to the user
// and disables copy while the current edited text is outside them.
export const TITLE_MIN = 2;
export const TITLE_MAX = 120;
export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 1200;

// Friendly, non-technical text for each sanitised unavailable reason the
// backend can return (app.core.listing_schemas.ListingUnavailableReason).
// No raw model output or transport error ever reaches this map, it is a
// fixed allowlist keyed presentation string.
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

// Never throws: an unrecognised / missing reason maps to a safe generic
// sentence rather than surfacing the raw value.
export function unavailableReasonMessage(reason) {
  return UNAVAILABLE_REASON_MESSAGES[reason] ?? UNAVAILABLE_REASON_FALLBACK;
}

// Trimmed-length validity for one editable field. The user's raw string
// is never mutated here, only measured: trimmedLength is what the backend
// bound applies to, so that is what the count and the valid flag use.
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

// Combined validity for a draft's editable title + description. `valid`
// is true only when BOTH fields are within their bounds; the card uses
// it to gate the Copy action.
export function draftEditValidity(title, description) {
  const titleValidity = fieldValidity(title, TITLE_MIN, TITLE_MAX);
  const descriptionValidity = fieldValidity(description, DESCRIPTION_MIN, DESCRIPTION_MAX);
  return {
    title: titleValidity,
    description: descriptionValidity,
    valid: titleValidity.valid && descriptionValidity.valid,
  };
}

// The exact clipboard payload for a generated draft: the CURRENT editable
// title and description, separated by one blank line. Values are used
// verbatim, never trimmed or reordered.
export function formatListingClipboardText(title, description) {
  return `${title}\n\n${description}`;
}

// Confirmed, non-excluded Sell item_ids, in confirmation order. Derived
// ONLY from confirmation.confirmedDecisions. A missing/malformed
// confirmation yields an empty list rather than throwing, so a component
// can call this unconditionally.
export function deriveEligibleSellItemIds(confirmation) {
  if (!confirmation || !Array.isArray(confirmation.confirmedDecisions)) return [];
  return confirmation.confirmedDecisions
    .filter((d) => d && d.confirmed_decision === "sell" && d.excluded === false)
    .map((d) => d.item_id);
}

// ---------------------------------------------------------------------------
// Seller-supplied listing details: a listing name and a declared condition
// per item_id. Listing metadata only: they never touch the detected label,
// the decision or the confirmation, and the server ignores them for any
// item that is not a confirmed non-excluded Sell item.
// ---------------------------------------------------------------------------

export const LISTING_NAME_MAX = 80;

// Mirrors the backend ListingCondition enum, in display order. The first
// entry is the default and means the model is told nothing about
// condition; it is never inferred from the image.
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

// The current details for one item: explicit user values from
// `detailsById` over the defaults (listing name = the reviewed effective
// label, condition = not specified). Pure; never mutates its inputs.
export function resolveListingDetails(itemId, detailsById, reviewItem) {
  const explicit = detailsById && detailsById[itemId] ? detailsById[itemId] : {};
  const fallbackName = reviewItem?.effective_label ?? reviewItem?.clean_label ?? "";
  const listingName = typeof explicit.listing_name === "string" ? explicit.listing_name : fallbackName;
  const condition = isListingCondition(explicit.condition) ? explicit.condition : DEFAULT_LISTING_CONDITION;
  return { listing_name: listingName, condition };
}

// The request-side shape for a set of eligible item ids, in the given
// order. A blank listing name is sent as null (server: "use the detected
// label") rather than as an empty string the schema would reject.
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

// Whether the details a draft was generated with still match the current
// ones for that item. Compared on the same normalised shape the request
// uses, so retyping the identical name is not a change.
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
