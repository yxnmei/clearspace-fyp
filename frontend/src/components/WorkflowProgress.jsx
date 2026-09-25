import { Check, Loader2 } from "lucide-react";
import PathChip from "./PathChip";
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
// Non-navigable steppers pass neither `onStepSelect` nor the id lists and
// get the plain behaviour: check derived from `currentStepId` /
// `isComplete`, and no buttons. Wizard steppers pass `onStepSelect` plus
// the id lists; completed unlocked steps that are not the viewed step
// become real navigation buttons, unless `navigationLocked` (a
// safety-critical request is processing).
//
// Two presentations of the SAME props, switched by CSS only (one DOM):
//   - from sm up, the full step row: completed = solid green circle with
//     a check, viewed (current) = deep-green circle and bold label on a
//     pale pill, upcoming = outlined circle and muted label; connectors
//     sit on the circle centre-line one z-layer back, solid green once
//     the previous step is done, dashed otherwise;
//   - below sm, a compact summary instead of a squeezed row: the path
//     chip, "Step X of N", a progress bar and the current step's title.
//     Backward navigation there is the screen's own Back control; the
//     step buttons remain in the DOM but are not displayed.
// The status / next-action lines below are shared by both.
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
  const stepNumber = (viewedIndex >= 0 ? viewedIndex : 0) + 1;
  const stepCount = steps.length;

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
      className="mx-auto w-full max-w-4xl rounded-card border border-border bg-surface p-3 sm:p-4"
    >
      {/* Mobile summary (below sm). No list, no buttons, no percentage. */}
      <div className="sm:hidden">
        <div className="flex items-center justify-between gap-3">
          <PathChip workflowName={workflowName} />
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Step {stepNumber} of {stepCount}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={`${workflowName} workflow progress`}
          aria-valuemin={1}
          aria-valuemax={stepCount}
          aria-valuenow={stepNumber}
          aria-valuetext={`Step ${stepNumber} of ${stepCount}: ${viewedLabel}`}
          className="mt-2 h-1.5 w-full overflow-hidden rounded-pill bg-surface-muted"
        >
          <div
            className="h-full rounded-pill bg-primary transition-[width]"
            style={{ width: `${(stepNumber / stepCount) * 100}%` }}
          />
        </div>
        <p className="mt-2 text-base font-semibold text-foreground">{viewedLabel}</p>
      </div>

      {/* Full step row (sm and up). */}
      <ol className="hidden items-start sm:flex">
        {steps.map((step, index) => {
          const completed = isStepCompleted(step, index);
          const isViewed = step.id === viewed;
          const isFuture = !completed && !isViewed;
          const connectorDone = index > 0 && isStepCompleted(steps[index - 1], index - 1);
          const navigableStep = isStepNavigable(step);

          const circle = (
            <span
              className={cn(
                "relative z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors",
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
                "mt-1 rounded-pill px-2 py-0.5 text-center text-xs leading-tight transition-colors",
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
              className="relative flex min-w-0 flex-1 flex-col items-center"
            >
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute right-1/2 top-3.5 z-0 w-full border-t-2",
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

      <div className="mt-3 border-t border-border pt-2 text-center">
        <p className="hidden text-xs font-medium uppercase tracking-wide text-muted-foreground sm:block">
          Step {stepNumber} of {stepCount} · {viewedLabel}
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
