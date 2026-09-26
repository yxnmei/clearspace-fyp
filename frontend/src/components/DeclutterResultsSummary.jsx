import { useId, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, EyeOff, Pencil } from "lucide-react";
import { Button } from "./ui/button";
import ConfirmedChoicesSummary from "./ConfirmedChoicesSummary";
import { DECISION_OPTIONS } from "./DecisionControl";
import { cn } from "../lib/cn";

// Compact closing overview derived from confirmation. Expanded items reuse
// the read-only confirmed summary; editing returns to Decide items.
const CARD_ICON = {
  keep: "text-decision-keep",
  sell: "text-decision-sell",
  donate: "text-decision-donate",
  discard: "text-decision-discard",
};

export function countConfirmed(confirmation) {
  const counts = { keep: 0, sell: 0, donate: 0, discard: 0, excluded: 0 };
  for (const decision of confirmation.confirmedDecisions) {
    if (decision.excluded) counts.excluded += 1;
    else if (decision.confirmed_decision in counts) counts[decision.confirmed_decision] += 1;
  }
  return counts;
}

export default function DeclutterResultsSummary({
  confirmation,
  reviewItems = [],
  imageUrl = null,
  onEditDecisions,
  heading = "Declutter complete",
  intro = "Your decisions are confirmed. Here's your final summary.",
  className,
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const counts = countConfirmed(confirmation);
  const total = confirmation.confirmedDecisions.length;

  return (
    <section
      aria-labelledby="declutter-results-heading"
      className={cn("rounded-card border border-success/40 bg-success/5 p-4 sm:p-6", className)}
    >
      <h2 id="declutter-results-heading" className="flex items-center gap-2 text-lg font-semibold text-success">
        <CheckCircle2 aria-hidden="true" width={20} height={20} className="shrink-0" />
        {heading}
      </h2>
      <p className="mt-1 text-sm text-foreground">{intro}</p>

      {/* Four count cards, one per final category, always in the same
          order, including zeros: a zero here is information ("nothing to
          sell"), unlike the pre-confirmation chips that hide unused
          categories. */}
      <dl aria-label="Confirmed decision counts" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {DECISION_OPTIONS.map(({ value, label, Icon }) => (
          <div
            key={value}
            className="flex items-center gap-2.5 rounded-control border border-border bg-surface px-3 py-2 shadow-card"
          >
            <Icon aria-hidden="true" width={16} height={16} className={cn("shrink-0", CARD_ICON[value])} />
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-base font-semibold tabular-nums text-foreground">{counts[value]}</dd>
            </div>
          </div>
        ))}
      </dl>
      {counts.excluded > 0 ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <EyeOff aria-hidden="true" width={12} height={12} />
          {counts.excluded} item{counts.excluded === 1 ? "" : "s"} excluded from later steps.
        </p>
      ) : null}

      {/* One collapsible section for the item chips, collapsed by default
          so the Results screen stays short; the control names the count
          so nothing is hidden without saying how much. */}
      <div className="mt-4 rounded-control border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <p className="text-sm font-medium text-foreground">
            Your confirmed items <span className="tabular-nums text-muted-foreground">({total})</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? (
                <ChevronUp aria-hidden="true" width={14} height={14} />
              ) : (
                <ChevronDown aria-hidden="true" width={14} height={14} />
              )}
              {expanded ? "Hide items" : "View items"}
            </Button>
            {onEditDecisions ? (
              <Button type="button" variant="ghost" size="sm" onClick={onEditDecisions}>
                <Pencil aria-hidden="true" width={14} height={14} />
                Edit decisions
              </Button>
            ) : null}
          </div>
        </div>
        <div id={panelId} hidden={!expanded} className="border-t border-border px-3 py-3">
          {expanded ? (
            <ConfirmedChoicesSummary
              confirmation={confirmation}
              reviewItems={reviewItems}
              imageUrl={imageUrl}
              label="Confirmed items"
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
