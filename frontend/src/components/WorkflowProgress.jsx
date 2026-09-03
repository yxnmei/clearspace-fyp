import { Check, Loader2 } from "lucide-react";
import { cn } from "../lib/cn";

// Workflow progress tracker. It renders already-derived presentation data
// and derives nothing about workflow state itself, no hooks.
//
// Two independent concepts:
//   - completed / unlocked: whether a step is done and reachable
//     (`completedStepIds`, `unlockedStepIds`);
//   - viewed: which step's content is on screen right now
//     (`viewedStepId`), which gets the current-step highlight and
//     `aria-current="step"` even when it is also completed.
//
// Non-navigable steppers (Reorganise, Both) pass neither `onStepSelect`
// nor the id lists and get exactly the old behaviour: check derived from
// `currentStepId` / `isComplete`, and no buttons. Wizard steppers
// (Declutter) pass `onStepSelect` plus the id lists; completed unlocked
// steps that are not the viewed step become real navigation buttons,
// unless `navigationLocked` (a safety-critical request is processing).
//
// Visual language:
//   - completed: solid green circle, white check, green label, solid
//     green connector behind it;
//   - viewed (current): deep-green filled circle, bold label on a pale
//     mint pill, the strongest state;
//   - future locked: neutral outlined circle, muted label, dashed
//     connector, aria-disabled and never focusable.
// Connectors sit on the circle centre-line only, one z-layer back, so a
// label is never crossed by a line.
export default function WorkflowProgress({
  workflowName,
  steps,
  currentStepId,
  viewedStepId,
  isComplete = false,
  processing = false,
  statusText,
  nextActionText,
  completedStepIds,
  unlockedStepIds,
  onStepSelect,
  navigationLocked = false,
}) {
  const navigable = typeof onStepSelect === "function";
  const currentIndex = steps.findIndex((step) => step.id === currentStepId);

  // In a non-navigable stepper that has finished, there is no "current"
  // step, every step reads as completed. Elsewhere the viewed step is
  // the current one.
  const viewed = !navigable && isComplete ? null : (viewedStepId ?? currentStepId);
  const viewedIndex = steps.findIndex((step) => step.id === (viewedStepId ?? currentStepId));
  const viewedLabel = viewedIndex >= 0 ? steps[viewedIndex].label : "";

  function isStepCompleted(step, index) {
    if (completedStepIds) return completedStepIds.includes(step.id);
    return isComplete || index < currentIndex;
  }

  function isStepNavigable(step) {
    if (!navigable || navigationLocked) return false;
    if (step.id === viewed) return false;
    return unlockedStepIds ? unlockedStepIds.includes(step.id) : false;
  }

  return (
    <nav
      aria-label={`${workflowName} workflow progress`}
      className="mx-auto w-full max-w-4xl rounded-card border border-border bg-surface p-4 sm:p-5"
    >
      <ol className="flex items-stretch overflow-x-auto pb-1">
        {steps.map((step, index) => {
          const completed = isStepCompleted(step, index);
          const isViewed = step.id === viewed;
          const isFuture = !completed && !isViewed;
          const connectorDone = index > 0 && isStepCompleted(steps[index - 1], index - 1);
          const navigableStep = isStepNavigable(step);

          const circle = (
            <span
              className={cn(
                "relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors",
                isViewed
                  ? "border-primary bg-primary text-primary-foreground"
                  : completed
                    ? "border-success bg-success text-success-foreground"
                    : "border-border bg-surface text-muted-foreground"
              )}
            >
              {completed ? <Check aria-hidden="true" width={16} height={16} /> : index + 1}
            </span>
          );

          const label = (
            <span
              className={cn(
                "mt-1.5 whitespace-nowrap rounded-pill px-2 py-0.5 text-xs transition-colors",
                isViewed
                  ? "bg-accent font-bold text-accent-foreground"
                  : completed
                    ? "font-semibold text-success"
                    : "font-medium text-muted-foreground"
              )}
            >
              {step.label}
            </span>
          );

          const inner = navigableStep ? (
            <button
              type="button"
              aria-label={`Go to ${step.label}`}
              onClick={() => onStepSelect(step.id)}
              className="flex flex-col items-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {circle}
              {label}
            </button>
          ) : (
            <span className="flex flex-col items-center">
              {circle}
              {label}
            </span>
          );

          return (
            <li
              key={step.id}
              aria-current={isViewed ? "step" : undefined}
              aria-disabled={navigable && isFuture ? "true" : undefined}
              className="relative flex min-w-[5.25rem] flex-1 flex-col items-center"
            >
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute right-1/2 top-4 z-0 w-full border-t-2",
                    connectorDone
                      ? "border-solid border-success"
                      : "border-dashed border-border"
                  )}
                />
              )}
              {inner}
            </li>
          );
        })}
      </ol>

      <div className="mt-3 border-t border-border pt-3 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step {(viewedIndex >= 0 ? viewedIndex : 0) + 1} of {steps.length} · {viewedLabel}
        </p>
        <p
          aria-live="polite"
          className="mt-1 flex items-center justify-center gap-1.5 text-sm font-medium text-foreground"
        >
          {processing && (
            <Loader2 aria-hidden="true" width={14} height={14} className="shrink-0 animate-spin text-primary" />
          )}
          <span>{statusText}</span>
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{nextActionText}</p>
      </div>
    </nav>
  );
}
