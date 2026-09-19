import { Layers } from "lucide-react";
import { itemNumberLabel } from "../utils/format";
import { cn } from "../lib/cn";

// The contextual / non-expected items section. Rendered only when there
// is at least one contextual item. These items never receive a Declutter
// decision; they are kept visibly secondary, and exist here only so an
// overlay box click can still reach them. Ref registration and
// activation live in the composing review section. Raw item_id is not
// rendered; the number badge keeps the link to the detection box.
export default function DeclutterContextualItems({
  items,
  activeItemId,
  registerItemRef,
  activateItem,
  deactivateItem,
}) {
  return (
    <section className="rounded-card border border-border bg-surface-muted p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        <Layers aria-hidden="true" width={16} height={16} />
        Contextual items ({items.length})
      </h2>
      <p className="mb-3 mt-1.5 text-sm text-muted-foreground">
        Detected for context only, not sent for a Declutter decision.
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
                "rounded-control border bg-surface p-3 text-sm text-muted-foreground transition-colors",
                active ? "border-primary ring-1 ring-primary" : "border-border"
              )}
            >
              <span className="mr-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted-foreground text-[11px] font-semibold text-background">
                {itemNumberLabel(item.item_id)}
              </span>
              <span className="font-medium text-foreground">{item.effective_label ?? item.clean_label}</span>
              {(item.position || item.relative_size) && (
                <span className="text-muted-foreground">
                  {" "}
                  · {[item.position, item.relative_size].filter(Boolean).join(", ")}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
