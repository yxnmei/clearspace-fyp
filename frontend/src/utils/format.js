// Pure functions only, unit-tested, no React/DOM/fetch here.
//
// (formatConfidence and decisionColor were removed once the redesigned
// screens stopped showing confidence percentages and text-colour-only
// decision cues; DecisionControl / Badge carry icon + label + tokens.)

// Decision -> border-color utility class, used by the detection-overlay
// boxes (AnalysedRoomPanel), where colour is a secondary cue layered on a
// bordered box rather than text.
export function decisionBorderColor(decision) {
  switch (decision) {
    case "keep":
      return "border-green-600";
    case "sell":
      return "border-blue-600";
    case "donate":
      return "border-amber-600";
    case "discard":
      return "border-red-600";
    default:
      return "border-stone-400";
  }
}

// A short, stable label for an overlay box / card badge, derived from
// item_id alone (never from label text or array position), so it stays
// consistent across re-renders and re-sorts. "item_001" -> "1". Falls
// back to the raw item_id if it doesn't match the expected pattern,
// rather than throwing, this is a display helper, not a validator.
export function itemNumberLabel(itemId) {
  if (typeof itemId !== "string") return "?";
  const match = itemId.match(/(\d+)$/);
  return match ? String(Number(match[1])) : itemId;
}
