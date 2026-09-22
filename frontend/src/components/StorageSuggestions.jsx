// "Storage and organisation ideas": a compact section rendered ONLY when
// the plan carries at least one suggestion; with none, nothing is
// rendered (no empty-state card). Shared by Direct Reorganise and Both
// through ReorganiseResult.
//
// Each card is exactly the contract's name and reason: a generic idea
// and one sentence saying what it would do for the selected items that
// motivated it. related_item_ids stay in the normalised response and its
// contract (validated, joined by item_id) but are not shown: the reason
// already names the items, so a "For: ..." line only repeated it. No
// prices, brands, links, availability claims or shopping controls, and
// no disclosure or tooltip; the backend has none of that to offer.
//
// Layout: one column on phones, two from sm, three from lg. A single
// suggestion therefore sits in one column of the grid rather than
// stretching into one oversized full-width card.
export default function StorageSuggestions({ storageSuggestions }) {
  if (!storageSuggestions || storageSuggestions.length === 0) return null;

  return (
    <section
      aria-labelledby="storage-suggestions-heading"
      className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5"
    >
      <h3 id="storage-suggestions-heading" className="text-lg font-semibold text-foreground">
        Storage and organisation ideas
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">Optional ways to give related items a consistent home.</p>
      <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Storage and organisation ideas">
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
