import { useState } from "react";
import { cn } from "../lib/cn";

// "Checklist": the actions of a Reorganise result as a locally interactive
// checklist. Shared by Direct Reorganise and Both through ReorganiseResult
// so the rendering exists exactly once.
//
// Completion is presentation state only: a Set of completed priorities
// held in this component. Checking an action never mutates actionPlan,
// never calls a hook, the backend or any generation action, and is never
// persisted. ReorganiseResult mounts this component with a key derived
// from the result's run identity, so a different generated result (or
// Start over, which unmounts the result) always starts from an empty
// checklist.
//
// Each row is title-led: the title is the complete, actionable step and
// is the checkbox's accessible name; the one-sentence instruction sits
// beneath it as secondary, muted text and is the checkbox's accessible
// description. No disclosure, tooltip or details view. Provenance,
// model, prompt, duration and issue details stay in the normalised
// response and are not rendered here.
export default function ReorganiseChecklist({ actionPlan }) {
  const [completed, setCompleted] = useState(() => new Set());

  const total = actionPlan.actions.length;
  const completedCount = actionPlan.actions.filter((action) => completed.has(action.priority)).length;
  const percent = total === 0 ? 0 : Math.round((completedCount / total) * 100);

  function toggle(priority) {
    setCompleted((current) => {
      const next = new Set(current);
      if (next.has(priority)) next.delete(priority);
      else next.add(priority);
      return next;
    });
  }

  return (
    <section
      aria-labelledby="reorganise-checklist-heading"
      className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5"
    >
      <h3 id="reorganise-checklist-heading" className="text-lg font-semibold text-foreground">
        Checklist
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Work through these steps in order. Check off each one as you finish.
      </p>

      <div className="mt-3">
        <p className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium text-foreground">
            {completedCount} of {total} completed
          </span>
          <span className="tabular-nums text-muted-foreground">{percent}%</span>
        </p>
        <div
          role="progressbar"
          aria-label="Checklist progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={completedCount}
          aria-valuetext={`${completedCount} of ${total} completed`}
          className="mt-1.5 h-2 w-full overflow-hidden rounded-pill bg-surface-muted"
        >
          <div className="h-full rounded-pill bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <ol className="mt-4 space-y-2" aria-label="Checklist actions">
        {actionPlan.actions.map((action) => {
          const done = completed.has(action.priority);
          const inputId = `checklist-action-${actionPlan.run_id}-${action.priority}`;
          const titleId = `${inputId}-title`;
          const instructionId = `${inputId}-instruction`;
          return (
            <li key={action.priority}>
              {/* The whole row is the checkbox's label, so it is one
                  comfortable target (min-h-11 = 44px) while the native
                  checkbox keeps keyboard and screen-reader semantics.
                  The accessible name is the title alone (aria-labelledby)
                  and the instruction is the description, so a screen
                  reader announces the step, then the detail. */}
              <label
                htmlFor={inputId}
                className={cn(
                  "flex min-h-11 cursor-pointer items-start gap-3 rounded-control border px-3 py-2 transition-colors",
                  done ? "border-primary/40 bg-accent/40" : "border-border bg-surface-muted"
                )}
              >
                <input
                  type="checkbox"
                  id={inputId}
                  checked={done}
                  onChange={() => toggle(action.priority)}
                  aria-labelledby={titleId}
                  aria-describedby={instructionId}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                />
                {/* Decorative: the ordered list already conveys the position. */}
                <span
                  data-testid="checklist-step-number"
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    done ? "bg-primary/70 text-primary-foreground" : "bg-primary text-primary-foreground"
                  )}
                >
                  {action.priority}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    id={titleId}
                    className={cn(
                      "block break-words text-sm font-semibold leading-6",
                      done ? "text-muted-foreground line-through" : "text-foreground"
                    )}
                  >
                    {action.title}
                  </span>
                  <span
                    id={instructionId}
                    className={cn(
                      "block break-words text-xs leading-5",
                      done ? "text-muted-foreground/80" : "text-muted-foreground"
                    )}
                  >
                    {action.instruction}
                  </span>
                  {done && <span className="sr-only">Completed</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
