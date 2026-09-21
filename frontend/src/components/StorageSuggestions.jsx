// "Storage suggestions": a compact section rendered ONLY when the plan
// carries at least one suggestion; with none, nothing is rendered (no
// empty-state card). Shared by Direct Reorganise and Both through
// ReorganiseResult. Renders exactly what the contract validated: a
// bounded list of generic ideas, each with a name, a reason and the
// selected items it is based on (joined by item_id, shown as labels only,
// never as ids). It never adds prices, brands, links or availability
// claims, and says so, because the backend has none of that to offer.
export default function StorageSuggestions({ storageSuggestions, items }) {
  if (!storageSuggestions || storageSuggestions.length === 0) return null;

  const itemsById = new Map(items.map((item) => [item.item_id, item]));

  return (
    <section
      aria-labelledby="storage-suggestions-heading"
      className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5"
    >
      <h3 id="storage-suggestions-heading" className="text-lg font-semibold text-foreground">
        Storage suggestions
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Generic ideas based only on the kinds of items you selected. These are not products, prices or availability
        checks.
      </p>
      <ul className="mt-3 space-y-2" aria-label="Storage suggestions">
        {storageSuggestions.map((suggestion) => {
          const labels = suggestion.related_item_ids.map(
            (itemId) => itemsById.get(itemId)?.effective_label ?? "Selected item"
          );
          return (
            <li key={suggestion.name} className="rounded-control border border-border bg-surface-muted p-3">
              <p className="text-sm font-semibold text-foreground">{suggestion.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">{suggestion.reason}</p>
              {labels.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">For: {labels.join(", ")}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
