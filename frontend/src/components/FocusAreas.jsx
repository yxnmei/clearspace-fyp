// "Areas to focus on": the coarse parts of the photo (left / centre /
// right) holding the most selected items, at most three, busiest first.
// Shared by Direct Reorganise and Both through ReorganiseResult.
//
// Derived server-side from each item's detected position only. It is a
// count of where the selected items are, not a measurement of clutter or
// importance, not a zone or a floor plan; the copy says exactly that.
// Items are joined back to the analysis item list purely by item_id and
// shown as a short bounded run of labels ("+N more"); an item the caller
// cannot resolve is named neutrally, never by its raw id.
const MAX_PREVIEW_LABELS = 3;

export function describeAreaItems(itemIds, itemsById) {
  const labels = itemIds.map((itemId) => itemsById.get(itemId)?.effective_label ?? "Selected item");
  const shown = labels.slice(0, MAX_PREVIEW_LABELS);
  const remaining = labels.length - shown.length;
  return remaining > 0 ? `${shown.join(", ")} +${remaining} more` : shown.join(", ");
}

export default function FocusAreas({ focusAreas, items }) {
  const itemsById = new Map(items.map((item) => [item.item_id, item]));

  return (
    <section
      aria-labelledby="focus-areas-heading"
      className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5"
    >
      <h3 id="focus-areas-heading" className="text-lg font-semibold text-foreground">
        Areas to focus on
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        The broad parts of your photo holding the most selected items, busiest first. This comes from where each
        item was detected, not from how cluttered or important an area is.
      </p>
      <ol className="mt-3 space-y-2" aria-label="Focus areas">
        {focusAreas.map((area) => {
          const count = area.item_ids.length;
          return (
            <li key={area.area_id} className="rounded-control border border-border bg-surface-muted p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <h4 className="text-sm font-semibold text-foreground">{area.label}</h4>
                <p className="text-xs text-muted-foreground">
                  {count} selected item{count === 1 ? "" : "s"}
                </p>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{describeAreaItems(area.item_ids, itemsById)}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
