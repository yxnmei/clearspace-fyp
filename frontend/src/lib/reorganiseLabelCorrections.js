// Corrections are item_id-keyed, single-line labels kept outside analysis.

export const MAX_CORRECTED_LABEL_LENGTH = 80;

// C0/C1 includes line breaks and tabs.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/;

// Returns a trimmed value or a user-facing validation error; never throws.
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

// Corrected display items are copied; clean_label retains detector provenance.
export function applyLabelCorrections(items, correctionsById) {
  return items.map((item) => {
    const corrected = correctionsById[item.item_id];
    if (typeof corrected !== "string") return item;
    return { ...item, corrected_label: corrected, effective_label: corrected, label_source: "user" };
  });
}

// Serialise corrections in analysis order.
export function serialiseLabelCorrections(items, correctionsById) {
  return items
    .filter((item) => typeof correctionsById[item.item_id] === "string")
    .map((item) => ({ item_id: item.item_id, corrected_label: correctionsById[item.item_id] }));
}
