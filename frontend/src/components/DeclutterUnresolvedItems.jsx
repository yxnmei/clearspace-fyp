import { TriangleAlert } from "lucide-react";
import { LabelCorrectionControl } from "./DeclutterItemCard";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";

// The unresolved expected-items section. Rendered by DeclutterReview only
// when there is at least one unresolved item. All partitioning, ref
// registration, activation and correction-error scoping still live in
// DeclutterReview and are passed in. These items stay prominent: they
// are what blocks confirmation.
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
        The AI could not produce a valid decision for these items. Confirmation is blocked until every item is
        resolved, no decision can be fabricated for them here. If the detected label looks wrong, correcting it
        lets ClearSpace retry its reasoning for just this one item.
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
              <span className="font-medium text-foreground">{item.effective_label ?? item.clean_label}</span>{" "}
              {item.label_source === "user" && <Badge variant="primary">Corrected by you</Badge>}{" "}
              <span className="text-muted-foreground">
                (item_id: <code>{item.item_id}</code>, {item.position}, {item.relative_size})
              </span>
              <p className="mt-1 font-medium text-error">No valid AI decision was produced for this item.</p>
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
