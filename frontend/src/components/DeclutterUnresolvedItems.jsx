import { TriangleAlert } from "lucide-react";
import { LabelCorrectionControl } from "./DeclutterItemCard";
import { itemNumberLabel } from "../utils/format";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";

// The unresolved expected-items section. Rendered only when there is at
// least one unresolved item. All partitioning, ref registration,
// activation and correction-error scoping still live in the composing
// review section and are passed in. These items stay prominent: they
// are what blocks confirmation, and they are the ONLY rows that carry
// the "Please double check" flag (a genuinely unresolved decision, never
// a confidence threshold). Raw item_id is not rendered; the number badge
// derived from it keeps the row linked to its detection box.
export default function DeclutterUnresolvedItems({
  items,
  activeItemId,
  registerItemRef,
  activateItem,
  deactivateItem,
  correctingItemId,
  correctionDisabled,
  correctionErrorFor,
  correctLabel,
}) {
  return (
    <section className="rounded-card border border-error/40 bg-error/5 p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-error">
        <TriangleAlert aria-hidden="true" width={16} height={16} />
        Unresolved items ({items.length})
      </h2>
      <p className="mb-3 mt-1.5 text-sm text-foreground">
        ClearSpace could not settle on a decision for these items, so confirmation is blocked until every item is
        resolved. If a label looks wrong, correcting it retries the suggestion for that item only.
      </p>
      <ul className="space-y-2">
        {items.map((item) => {
          const active = item.item_id === activeItemId;
          return (
            <li
              key={item.item_id}
              ref={(el) => registerItemRef(item.item_id, el)}
              tabIndex={0}
              aria-current={active ? "true" : undefined}
              onMouseEnter={() => activateItem(item.item_id)}
              onMouseLeave={() => deactivateItem(item.item_id)}
              onFocus={() => activateItem(item.item_id)}
              onBlur={() => deactivateItem(item.item_id)}
              className={cn(
                "rounded-control border bg-surface p-3 text-sm transition-colors",
                active ? "border-primary ring-1 ring-primary" : "border-error/30"
              )}
            >
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                  {itemNumberLabel(item.item_id)}
                </span>
                <span className="font-semibold text-foreground">{item.effective_label ?? item.clean_label}</span>
                {item.label_source === "user" && <Badge variant="primary">Corrected by you</Badge>}
                <Badge variant="warning">
                  <TriangleAlert aria-hidden="true" width={12} height={12} />
                  Please double check
                </Badge>
              </p>
              {(item.position || item.relative_size) && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {[item.position, item.relative_size].filter(Boolean).join(", ")}
                </p>
              )}
              <p className="mt-1 text-xs font-medium text-error">ClearSpace could not suggest an action for this item.</p>
              <div className="mt-2">
                <LabelCorrectionControl
                  item={item}
                  isCorrecting={correctingItemId === item.item_id}
                  correctionDisabled={correctionDisabled}
                  correctionError={correctionErrorFor(item.item_id)}
                  onCorrectLabel={correctLabel}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
