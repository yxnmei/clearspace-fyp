import { itemNumberLabel } from "../utils/format";

// "Storage suggestions": the compact section below the focus areas.
// Shared by Direct Reorganise and Both through ReorganiseResult. Renders
// exactly what the contract validated: a bounded list of generic
// suggestions, each with a name, a reason, and the selected items it is
// based on (joined by item_id). It never adds prices, brands, links or
// availability claims, and says so, because the backend has none of
// that to offer.
export default function StorageSuggestions({ storageSuggestions, items }) {
  const itemsById = new Map(items.map((item) => [item.item_id, item]));

  return (
    <section
      aria-labelledby="storage-suggestions-heading"
      className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6"
    >
      <h2 id="storage-suggestions-heading" className="text-lg font-semibold text-foreground">
        Storage suggestions
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Generic ideas based only on the kinds of items you selected. These are not products, prices or availability
        checks.
      </p>
      {storageSuggestions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No storage suggestion for this selection. Suggestions appear only when at least two compatible small or
          medium-sized items are selected.
        </p>
      ) : (
        <ul className="mt-3 space-y-3" aria-label="Storage suggestions">
          {storageSuggestions.map((suggestion) => (
            <li key={suggestion.name} className="rounded-control border border-border bg-surface-muted p-3">
              <p className="text-sm font-medium text-foreground">{suggestion.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">{suggestion.reason}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Based on:{" "}
                {suggestion.related_item_ids
                  .map((itemId) => {
                    const item = itemsById.get(itemId);
                    return `#${itemNumberLabel(itemId)} ${item ? item.effective_label : itemId}`;
                  })
                  .join(", ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
