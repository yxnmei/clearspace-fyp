import { CheckCircle2, EyeOff, Loader2, PencilLine, TriangleAlert, Undo2 } from "lucide-react";
import { Button } from "./ui/button";
import { DECISION_OPTIONS } from "./DecisionControl";
import { cn } from "../lib/cn";

// The ONE confirmation surface of the Confirm choices screen, rendered
// by DeclutterPage and BothPage. It transforms in place:
//
//   - before confirmation (idle / confirming / error): "Confirm your
//     choices", the live decision summary as compact chips (non-zero
//     categories only), the unresolved blocker with a way back to Decide
//     items, the Confirm decisions action and its inline error;
//   - after a successful CURRENT confirmation (confirmationStatus ===
//     "confirmed" with a confirmation result): "Choices confirmed", the
//     confirmed counts and a short note on what the next screen offers.
//
// Never two panels at once, never a run id, item id or other technical
// metadata. Every count and flag is derived by the page (via
// lib/declutterReview) from current review data or the normalised
// confirmation; `onConfirm` is the hook's confirm, forwarded unchanged,
// and `onReviewUnresolved` is the page's own step navigation (no request,
// no reset). Identity stays item_id underneath, it is just not shown.

// Chips must read clearly against BOTH the white pre-confirmation panel
// and the pale green confirmed panel: every decision chip sits on the same
// solid surface with the same visible brand-green border and normal
// high-contrast foreground text; only the ICON carries the decision
// colour, which keeps the four categories distinguishable without four
// competing tints. Full literal class strings so Tailwind's scanner keeps
// them.
const CHIP_BASE =
  "inline-flex min-h-9 items-center gap-1.5 rounded-pill border px-3 py-1 text-sm text-foreground shadow-card";

const DECISION_CHIP_SURFACE = "border-primary/50 bg-surface";

const DECISION_ICON = {
  keep: "text-decision-keep",
  sell: "text-decision-sell",
  donate: "text-decision-donate",
  discard: "text-decision-discard",
};

function CountChip({ icon: Icon, label, value, className, iconClassName }) {
  return (
    <div className={cn(CHIP_BASE, className)}>
      <Icon aria-hidden="true" width={14} height={14} className={cn("shrink-0", iconClassName)} />
      <dt className="font-medium">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

// Only categories with a value > 0 are rendered; a decision nobody chose
// is simply absent rather than shown as an empty zero card.
function CountChips({ counts, changedCount, excludedCount, label }) {
  const chips = [];
  for (const { value, label: decisionLabel, Icon } of DECISION_OPTIONS) {
    const count = counts?.[value] ?? 0;
    if (count > 0) {
      chips.push(
        <CountChip
          key={value}
          icon={Icon}
          label={decisionLabel}
          value={count}
          className={DECISION_CHIP_SURFACE}
          iconClassName={DECISION_ICON[value]}
        />
      );
    }
  }
  if (changedCount > 0) {
    chips.push(
      <CountChip
        key="changed"
        icon={PencilLine}
        label="Changed"
        value={changedCount}
        className="border-warning/50 bg-warning/15"
        iconClassName="text-warning"
      />
    );
  }
  if (excludedCount > 0) {
    chips.push(
      <CountChip
        key="excluded"
        icon={EyeOff}
        label="Excluded"
        value={excludedCount}
        className="border-border bg-surface-muted"
        iconClassName="text-muted-foreground"
      />
    );
  }
  if (chips.length === 0) return null;
  return (
    <dl aria-label={label} className="flex flex-wrap gap-2">
      {chips}
    </dl>
  );
}

function confirmedCounts(confirmation) {
  const counts = { keep: 0, sell: 0, donate: 0, discard: 0 };
  for (const decision of confirmation.confirmedDecisions) {
    if (decision.confirmed_decision in counts) counts[decision.confirmed_decision] += 1;
  }
  return counts;
}

export const DECLUTTER_NEXT_STEP_NOTE =
  "On the next screen you can generate editable listing drafts for the items you confirmed as Sell. Nothing is generated until you ask.";

export default function DeclutterConfirmationPanel({
  counts,
  changedCount = 0,
  excludedCount = 0,
  unresolvedCount = 0,
  confirmDisabled,
  confirmationStatus,
  confirmationError,
  onConfirm,
  confirmation = null,
  onReviewUnresolved,
  nextStepNote = DECLUTTER_NEXT_STEP_NOTE,
}) {
  const isConfirming = confirmationStatus === "confirming";
  const isConfirmed = confirmationStatus === "confirmed" && confirmation !== null;

  // ------------------------------------------------------------ confirmed
  if (isConfirmed) {
    const decisionCount = confirmation.confirmedDecisions.length;
    return (
      <section
        aria-labelledby="confirmation-panel-heading"
        className="rounded-card border border-success/40 bg-success/5 p-4 sm:p-6"
      >
        <h2 id="confirmation-panel-heading" className="flex items-center gap-2 text-lg font-semibold text-success">
          <CheckCircle2 aria-hidden="true" width={20} height={20} className="shrink-0" />
          Choices confirmed
        </h2>
        <p role="status" className="mt-1 text-sm text-foreground">
          {decisionCount} decision{decisionCount === 1 ? "" : "s"} confirmed. Your choices are locked in for the
          next step; go back to Decide items if you want to change one.
        </p>

        <div className="mt-4">
          <CountChips
            counts={confirmedCounts(confirmation)}
            changedCount={confirmation.decisionChangedCount}
            excludedCount={confirmation.excludedCount}
            label="Confirmed decisions"
          />
        </div>

        <p className="mt-4 text-sm text-muted-foreground">{nextStepNote}</p>
      </section>
    );
  }

  // -------------------------------------------------- before confirmation
  const hasUnresolved = unresolvedCount > 0;
  return (
    <section
      aria-labelledby="confirmation-panel-heading"
      className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-6"
    >
      <h2 id="confirmation-panel-heading" className="text-lg font-semibold text-foreground">
        Confirm your choices
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Confirming locks in the decisions below for the next step. You can still go back to Decide items and change
        any of them first.
      </p>

      <div className="mt-4">
        <CountChips counts={counts} changedCount={changedCount} excludedCount={excludedCount} label="Your decisions" />
      </div>

      {hasUnresolved && (
        <div className="mt-4 rounded-control border border-warning/40 bg-warning/10 p-3">
          <p className="flex items-start gap-2 text-sm text-warning-foreground">
            <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0 text-warning" />
            <span>
              {unresolvedCount === 1
                ? "1 item still needs a decision before you can confirm."
                : `${unresolvedCount} items still need a decision before you can confirm.`}
            </span>
          </p>
          {onReviewUnresolved && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReviewUnresolved}
              className="mt-3 min-h-11 w-full sm:min-h-0 sm:w-auto"
            >
              <Undo2 aria-hidden="true" width={14} height={14} />
              Review unresolved items
            </Button>
          )}
        </div>
      )}

      <div className="mt-4">
        <Button
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
          aria-busy={isConfirming || undefined}
          className="min-h-11 w-full sm:min-h-0 sm:w-auto"
        >
          {isConfirming && <Loader2 aria-hidden="true" width={16} height={16} className="animate-spin" />}
          {isConfirming ? "Confirming…" : "Confirm decisions"}
        </Button>
      </div>

      {confirmationStatus === "error" && confirmationError && (
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-control border border-error/30 bg-error/10 p-3 text-sm text-error"
        >
          <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0" />
          <span>
            {confirmationError} Your review decisions and exclusions are unchanged. You can try again.
          </span>
        </p>
      )}
    </section>
  );
}
