// Decision colour is a secondary cue on bordered detection overlays.
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

// Stable display number from item_id, never label text or array position.
export function itemNumberLabel(itemId) {
  if (typeof itemId !== "string") return "?";
  const match = itemId.match(/(\d+)$/);
  return match ? String(Number(match[1])) : itemId;
}
