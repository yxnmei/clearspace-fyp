import { ArrowLeft, ArrowRight, Info } from "lucide-react";
import { Button } from "./ui/button";
import { DECISION_OPTIONS } from "./DecisionControl";
import { cn } from "../lib/cn";

// Shared sticky decision summary and navigation. The page supplies all state;
// describeContinueBlocker explains each disabled Continue guard.

export function describeContinueBlocker({
  hasAnalysis = true,
  navigationLocked = false,
  correctingItemId = null,
  unresolvedCount = 0,
} = {}) {
  if (navigationLocked) return "Please wait for the current action to finish.";
  if (!hasAnalysis) return "Your space analysis is unavailable. Go back and analyse the space again.";
  if (correctingItemId !== null) return "A label correction is in progress. Continue becomes available once it finishes.";
  if (unresolvedCount > 0) {
    return unresolvedCount === 1
      ? "1 item still needs a decision."
      : `${unresolvedCount} items still need a decision.`;
  }
  return null;
}

export default function DecisionActionBar({
  totalCount,
  counts,
  backLabel,
  onBack,
  backDisabled = false,
  continueLabel,
  onContinue,
  continueDisabled = false,
  blockedReason = null,
}) {
  const reasonId = "decision-action-bar-reason";
  const showReason = continueDisabled && Boolean(blockedReason);

  return (
    <section
      aria-label="Decision summary and navigation"
      className="sticky bottom-3 z-30 mx-0 mt-6 rounded-card border border-border bg-accent/90 px-3 py-3 shadow-elevated backdrop-blur sm:px-4 lg:bottom-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <dl className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <div className="flex items-baseline gap-1">
            <dt className="sr-only">Items to decide</dt>
            <dd className="font-semibold text-foreground">
              {totalCount} item{totalCount === 1 ? "" : "s"}
            </dd>
          </div>
          {DECISION_OPTIONS.map(({ value, label, Icon, text }) => {
            const count = counts?.[value] ?? 0;
            if (count === 0) return null;
            return (
              <div key={value} className={cn("flex items-center gap-1", text)}>
                <Icon aria-hidden="true" width={14} height={14} className="shrink-0" />
                <dt className="font-medium">{label}</dt>
                <dd className="font-semibold tabular-nums">{count}</dd>
              </div>
            );
          })}
        </dl>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          {showReason && (
            <p
              id={reasonId}
              role="status"
              aria-live="polite"
              className="flex items-start gap-1.5 text-xs font-medium text-warning-foreground sm:max-w-xs"
            >
              <Info aria-hidden="true" width={14} height={14} className="mt-0.5 shrink-0 text-warning" />
              <span>{blockedReason}</span>
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              type="button"
              variant="outline"
              onClick={onBack}
              disabled={backDisabled}
              className="w-full sm:w-auto"
            >
              <ArrowLeft aria-hidden="true" width={16} height={16} />
              {backLabel}
            </Button>
            <Button
              type="button"
              onClick={onContinue}
              disabled={continueDisabled}
              aria-describedby={showReason ? reasonId : undefined}
              className="w-full sm:w-auto"
            >
              {continueLabel}
              <ArrowRight aria-hidden="true" width={16} height={16} />
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
