// Render only grounded name/reason pairs. related_item_ids stay validated
// contract data and are not repeated in the UI.
const MULTI_COLUMN_GRID = "sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2";

export default function StorageSuggestions({ storageSuggestions }) {
  if (!storageSuggestions || storageSuggestions.length === 0) return null;

  const gridClassName = ["mt-3 grid grid-cols-1 gap-3", storageSuggestions.length > 1 ? MULTI_COLUMN_GRID : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <section
      aria-labelledby="storage-suggestions-heading"
      className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5"
    >
      <h3 id="storage-suggestions-heading" className="text-lg font-semibold text-foreground">
        Storage and organisation ideas
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">Optional ways to give related items a consistent home.</p>
      <ul className={gridClassName} aria-label="Storage and organisation ideas">
        {storageSuggestions.map((suggestion) => (
          <li key={suggestion.name} className="min-w-0 rounded-control border border-border bg-surface-muted p-3">
            <p className="break-words text-sm font-semibold text-foreground">{suggestion.name}</p>
            <p className="mt-1 break-words text-sm text-muted-foreground">{suggestion.reason}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
