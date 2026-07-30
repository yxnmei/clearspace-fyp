// Pure functions only — unit-tested (§4), no React/DOM/fetch here.

export function formatConfidence(confidence) {
  if (confidence == null || Number.isNaN(confidence)) return "—";
  return `${Math.round(confidence * 100)}%`;
}

export function decisionColor(decision) {
  switch (decision) {
    case "keep":
      return "text-green-600";
    case "sell":
      return "text-blue-600";
    case "donate":
      return "text-amber-600";
    case "discard":
      return "text-red-600";
    default:
      return "text-gray-500";
  }
}
