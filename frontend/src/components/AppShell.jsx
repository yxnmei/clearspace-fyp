import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, TriangleAlert } from "lucide-react";
import Brand from "./Brand";
import PathChip from "./PathChip";
import { Button } from "./ui/button";
import { cn } from "../lib/cn";

// The persistent page frame: a banner header with the brand, the active
// workflow breadcrumb and the one "Back to workflows" action, then the
// bounded content column. It owns no workflow state.
//
// `onBack`, when provided, means a workflow is mounted. Leaving a
// workflow unmounts its whole subtree (App.jsx), which discards the
// analysis, decisions, drafts and local edits, so both ways out of a
// workflow (the header's Back button and the brand, which becomes a
// button only while a workflow is open) go through one inline
// confirmation strip: Stay closes it and returns focus to whichever
// control opened it; Leave calls onBack. No window.confirm, no modal:
// the strip sits under the header bar, is announced as an alertdialog,
// takes focus on open, and closes on Escape. It always asks while a
// workflow is open rather than guessing whether there is anything to
// lose, which is honest and needs no dirty tracking across three
// different state machines.
//
// The brand stays plain text on the chooser (nothing to leave). Its
// accessible name while a workflow is open is "ClearSpace home", which
// deliberately does not contain the words "back to workflows", so the
// text button keeps a unique name.
export default function AppShell({ onBack, workflowName, children, className }) {
  const [leaveRequested, setLeaveRequested] = useState(false);
  const triggerRef = useRef(null);
  const stayRef = useRef(null);

  useEffect(() => {
    if (leaveRequested) stayRef.current?.focus();
  }, [leaveRequested]);

  function requestLeave(event) {
    triggerRef.current = event.currentTarget;
    setLeaveRequested(true);
  }

  function stay() {
    setLeaveRequested(false);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (trigger && typeof trigger.focus === "function") trigger.focus();
  }

  function leave() {
    setLeaveRequested(false);
    triggerRef.current = null;
    onBack();
  }

  function handlePanelKeyDown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      stay();
    }
  }

  return (
    <div className="relative isolate flex min-h-screen flex-col bg-background text-foreground">
      {/* Soft decorative glow behind the header; purely visual, hidden
          from assistive tech, never receives pointer events. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[28rem] overflow-hidden">
        <div className="absolute -left-24 -top-32 h-80 w-80 rounded-full bg-accent/60 blur-3xl" />
        <div className="absolute right-[-8rem] top-10 h-72 w-72 rounded-full bg-surface-muted blur-3xl" />
      </div>

      <header className="border-b border-border/70 bg-surface/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-content items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            {onBack ? (
              <button
                type="button"
                aria-label="ClearSpace home"
                onClick={requestLeave}
                className="rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Brand />
              </button>
            ) : (
              <Brand />
            )}
            {workflowName ? (
              <>
                <ChevronRight
                  aria-hidden="true"
                  width={16}
                  height={16}
                  className="hidden shrink-0 text-muted-foreground sm:block"
                />
                <PathChip workflowName={workflowName} className="hidden sm:inline-flex" />
              </>
            ) : null}
          </div>
          {onBack ? (
            <Button type="button" variant="ghost" size="sm" onClick={requestLeave} className="shrink-0">
              <ArrowLeft aria-hidden="true" width={16} height={16} />
              Back to workflows
            </Button>
          ) : null}
        </div>

        {leaveRequested && onBack ? (
          <div
            role="alertdialog"
            aria-labelledby="leave-workflow-heading"
            aria-describedby="leave-workflow-description"
            onKeyDown={handlePanelKeyDown}
            className="border-t border-warning/40 bg-warning/10"
          >
            <div className="mx-auto flex w-full max-w-content flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <p className="flex items-start gap-2 text-sm text-foreground">
                <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0 text-warning" />
                <span>
                  <span id="leave-workflow-heading" className="font-semibold">
                    Leave this workflow?
                  </span>{" "}
                  <span id="leave-workflow-description">
                    Your analysis, decisions and drafts here will be lost.
                  </span>
                </span>
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button ref={stayRef} type="button" variant="outline" size="sm" onClick={stay}>
                  Stay
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={leave}
                  className="bg-error text-background hover:bg-error/90"
                >
                  Leave
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </header>

      <main className={cn("mx-auto w-full max-w-content flex-1 px-4 py-5 sm:px-6 sm:py-7", className)}>
        {children}
      </main>
    </div>
  );
}
