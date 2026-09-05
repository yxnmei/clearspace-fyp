// Pure helpers for the marketplace-listing review UI (Stage 4A). No
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
