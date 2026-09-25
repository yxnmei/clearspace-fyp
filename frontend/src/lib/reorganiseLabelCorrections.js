// Pure helpers for Direct Reorganise label corrections (Select items).
// Mirrors app/core/reorganise_label_corrections.py: a correction is keyed
// by item_id only, its label is trimmed, 1..80 characters and single-line.
// The analysis object from /upload is never edited; corrections live in
// their own item_id map and travel to /generate as `label_corrections`.

export const MAX_CORRECTED_LABEL_LENGTH = 80;

// Any C0/C1 control character, which includes line breaks and tabs.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/;

// Returns { ok: true, value } with the trimmed label, or { ok: false,
// error } with a short user-facing message. Never throws.
export function validateCorrectedLabel(label) {
  if (typeof label !== "string") return { ok: false, error: "Enter a label." };
  const value = label.trim();
  if (value === "") return { ok: false, error: "Enter a label." };
  if (value.length > MAX_CORRECTED_LABEL_LENGTH) {
    return { ok: false, error: `Use ${MAX_CORRECTED_LABEL_LENGTH} characters or fewer.` };
  }
  if (CONTROL_CHARACTER_RE.test(value)) return { ok: false, error: "Use a single line of text." };
  return { ok: true, value };
}

// Display items: each corrected item becomes a NEW object whose
// effective_label is the correction and label_source is "user";
// clean_label stays the detector's label for provenance. Uncorrected
// items are returned as-is. The input array and its items are not
// modified.
export function applyLabelCorrections(items, correctionsById) {
  return items.map((item) => {
    const corrected = correctionsById[item.item_id];
    if (typeof corrected !== "string") return item;
    return { ...item, corrected_label: corrected, effective_label: corrected, label_source: "user" };
  });
}

// The /generate request field: one { item_id, corrected_label } per
// corrected item, in analysis order.
export function serialiseLabelCorrections(items, correctionsById) {
  return items
    .filter((item) => typeof correctionsById[item.item_id] === "string")
    .map((item) => ({ item_id: item.item_id, corrected_label: correctionsById[item.item_id] }));
}
