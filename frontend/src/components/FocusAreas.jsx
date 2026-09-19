import { itemNumberLabel } from "../utils/format";

// "Areas to focus on": the coarse parts of the photo (left / centre /
// right) holding the most selected items, at most three, busiest first.
// Shared by Direct Reorganise and Both through ReorganiseResult.
//
// Derived server-side from each item's detected position only. It is a
// count of where the selected items are, not a measurement of clutter,
// not AI-generated, and not a floor plan; the copy says exactly that.
// Chips are joined back to the analysis item list purely by item_id,
// never by label text; an item the caller cannot resolve still shows its
// id rather than being dropped.
export default function FocusAreas({ focusAreas, items }) {
  const itemsById = new Map(items.map((item) => [item.item_id, item]));

  return (
    <section aria-labelledby="focus-areas-heading" className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6">
      <h2 id="focus-areas-heading" className="text-lg font-semibold text-foreground">
        Areas to focus on
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The parts of your photo holding the most selected items, busiest first. This comes from where each item
        was detected, not from how cluttered an area looks.
      </p>
      <ol className="mt-4 grid gap-3 sm:grid-cols-3" aria-label="Focus areas">
        {focusAreas.map((area) => (
          <li key={area.area_id} className="rounded-card border border-border bg-surface-muted p-4">
            <h3 className="text-sm font-semibold text-foreground">{area.label}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {area.item_ids.length} selected item{area.item_ids.length === 1 ? "" : "s"}
            </p>
            <ul className="mt-3 flex flex-wrap gap-2" aria-label={`Items in the ${area.label.toLowerCase()}`}>
              {area.item_ids.map((itemId) => {
                const item = itemsById.get(itemId);
                return (
                  <li
                    key={itemId}
                    className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-2.5 py-0.5 text-xs font-medium text-foreground"
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground"
                    >
                      {itemNumberLabel(itemId)}
                    </span>
                    {item ? item.effective_label : itemId}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}
