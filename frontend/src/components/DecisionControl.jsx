import { HandHeart, PackageCheck, Tag, Trash2 } from "lucide-react";
import { cn } from "../lib/cn";

// The four Declutter decisions as ONE segmented control. Native radio
// semantics are kept intact: each option is a real <input type="radio">
// in a per-item group (name derived from item_id), so browser/jsdom
// keyboard behaviour (Tab to the checked member, arrow keys between
// members) needs no re-implementation. The input is visually hidden and
// the visible segment beside it is styled through the `peer` classes,
// so the focus ring and disabled state follow the input's real state.
//
// Every option shows an icon, its text label and its decision colour
// token; colour is never the only cue. Class strings are written out in
// full so Tailwind's scanner keeps them.
//
// DECISION_OPTIONS is shared with the decision summary bar so the icon +
// colour per decision exists exactly once.
export const DECISION_OPTIONS = [
  {
    value: "keep",
    label: "Keep",
    Icon: PackageCheck,
    text: "text-decision-keep",
    selected: "border-decision-keep bg-surface text-decision-keep shadow-card",
    unselected: "border-transparent text-muted-foreground hover:bg-surface hover:text-decision-keep",
  },
  {
    value: "sell",
    label: "Sell",
    Icon: Tag,
    text: "text-decision-sell",
    selected: "border-decision-sell bg-surface text-decision-sell shadow-card",
    unselected: "border-transparent text-muted-foreground hover:bg-surface hover:text-decision-sell",
  },
  {
    value: "donate",
    label: "Donate",
    Icon: HandHeart,
    text: "text-decision-donate",
    selected: "border-decision-donate bg-surface text-decision-donate shadow-card",
    unselected: "border-transparent text-muted-foreground hover:bg-surface hover:text-decision-donate",
  },
  {
    value: "discard",
    label: "Discard",
    Icon: Trash2,
    text: "text-decision-discard",
    selected: "border-decision-discard bg-surface text-decision-discard shadow-card",
    unselected: "border-transparent text-muted-foreground hover:bg-surface hover:text-decision-discard",
  },
];

export const DECISION_OPTIONS_BY_VALUE = Object.fromEntries(
  DECISION_OPTIONS.map((option) => [option.value, option])
);

export default function DecisionControl({ itemId, itemLabel, value, onChange, className }) {
  const groupName = `decision-${itemId}`;

  return (
    <fieldset className={cn("min-w-0", className)}>
      <legend className="sr-only">Your decision for {itemLabel}</legend>
      {/* One row of four at every breakpoint. Below sm the track takes the
          available width with compact spacing and 11px labels; from sm up
          it is a natural-width inline grid with the roomier spacing.
          Cells are minmax(0, 1fr); nothing is ever clipped, the host card
          gives the control the full card width on narrow screens. */}
      <div className="grid w-full max-w-full grid-cols-4 gap-0.5 rounded-control border border-border bg-surface-muted p-0.5 sm:inline-grid sm:w-auto sm:gap-1 sm:p-1">
        {DECISION_OPTIONS.map(({ value: optionValue, label, Icon, selected, unselected }) => {
          const checked = value === optionValue;
          return (
            <label key={optionValue} className="block min-w-0">
              <input
                type="radio"
                name={groupName}
                value={optionValue}
                checked={checked}
                onChange={() => onChange(itemId, optionValue)}
                className="peer sr-only"
              />
              <span
                data-decision-segment={optionValue}
                className={cn(
                  "flex min-h-10 min-w-0 cursor-pointer select-none items-center justify-center gap-0.5 whitespace-nowrap rounded-control border px-1 py-1 text-[11px] font-semibold leading-none tracking-tight transition-colors sm:gap-1.5 sm:px-2 sm:py-1.5 sm:text-xs sm:tracking-normal",
                  "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background",
                  "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
                  checked ? selected : unselected
                )}
              >
                <Icon aria-hidden="true" width={14} height={14} className="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5" />
                {label}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
