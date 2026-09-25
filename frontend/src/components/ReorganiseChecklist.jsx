import { useState } from "react";
import { cn } from "../lib/cn";

// Local completion state only. ReorganiseResult remounts this component
// for a new run, so no checkbox state leaks across generated plans.
export default function ReorganiseChecklist({ tidyPlan }) {
  const [completed, setCompleted] = useState(() => new Set());
  const steps = tidyPlan.phases.flatMap((phase) => phase.steps);
  const total = steps.length;
  const completedCount = steps.filter((step) => completed.has(step.step_id)).length;
  const percent = Math.round((completedCount / total) * 100);

  function toggle(stepId) {
    setCompleted((current) => {
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  }

  return (
    <section aria-labelledby="reorganise-checklist-heading" className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5">
      <h3 id="reorganise-checklist-heading" className="text-lg font-semibold text-foreground">Tidy plan</h3>
      <p className="mt-1 text-sm text-muted-foreground">Check off each step as you finish.</p>
      <div className="mt-3">
        <p className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium text-foreground">{completedCount} of {total} completed</span>
          <span className="tabular-nums text-muted-foreground">{percent}%</span>
        </p>
        <div role="progressbar" aria-label="Checklist progress" aria-valuemin={0} aria-valuemax={total}
          aria-valuenow={completedCount} aria-valuetext={`${completedCount} of ${total} completed`}
          className="mt-1.5 h-2 w-full overflow-hidden rounded-pill bg-surface-muted">
          <div className="h-full rounded-pill bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <div className="mt-4 space-y-5">
        {tidyPlan.phases.map((phase) => (
          <section key={phase.phase_id} aria-labelledby={`tidy-phase-${phase.phase_id}`}>
            <h4 id={`tidy-phase-${phase.phase_id}`} className="text-sm font-semibold text-foreground">{phase.title}</h4>
            <ol className="mt-2 space-y-2" aria-label={`${phase.title} steps`}>
              {phase.steps.map((step) => {
                const done = completed.has(step.step_id);
                const inputId = `tidy-step-${step.step_id}`;
                return (
                  <li key={step.step_id}>
                    <label htmlFor={inputId} className={cn(
                      "flex min-h-11 cursor-pointer items-start gap-3 rounded-control border px-3 py-2 transition-colors",
                      done ? "border-primary/40 bg-accent/40" : "border-border bg-surface-muted"
                    )}>
                      <input type="checkbox" id={inputId} checked={done} onChange={() => toggle(step.step_id)}
                        aria-label={step.text}
                        className="mt-0.5 h-5 w-5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" />
                      <span className={cn("min-w-0 flex-1 break-words text-sm leading-6", done ? "text-muted-foreground line-through" : "text-foreground")}>{step.text}</span>
                    </label>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </section>
  );
}
