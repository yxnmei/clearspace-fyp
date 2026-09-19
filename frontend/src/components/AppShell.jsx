import { ArrowLeft, ChevronRight } from "lucide-react";
import Brand from "./Brand";
import PathChip from "./PathChip";
import { Button } from "./ui/button";
import { cn } from "../lib/cn";

// Shared application shell: consistent ClearSpace branding, a restrained
// decorative background, and a responsive content column. It owns no
// workflow state.
//
// `onBack`, when provided, renders the single "Back to workflows" action for
// a workflow page. `workflowName`, when provided, renders the workflow
// breadcrumb (ClearSpace › <PathChip>) beside the brand from the sm
// breakpoint up; below sm the chip is shown by WorkflowProgress's mobile
// summary instead, so it never appears twice at one breakpoint. App decides
// when to pass both (every mode except the workflow chooser itself). There
// is deliberately no universal progress indicator here, the three
// workflows have different state machines.
export default function AppShell({ onBack, workflowName, children, className }) {
  return (
    <div className="relative isolate flex min-h-screen flex-col bg-background text-foreground">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[28rem] overflow-hidden">
        <div className="absolute -left-24 -top-32 h-80 w-80 rounded-full bg-accent/60 blur-3xl" />
        <div className="absolute right-[-8rem] top-10 h-72 w-72 rounded-full bg-surface-muted blur-3xl" />
      </div>

      <header className="border-b border-border/70 bg-surface/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-content items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Brand />
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
            <Button type="button" variant="ghost" size="sm" onClick={onBack} className="shrink-0">
              <ArrowLeft aria-hidden="true" width={16} height={16} />
              Back to workflows
            </Button>
          ) : null}
        </div>
      </header>

      <main className={cn("mx-auto w-full max-w-content flex-1 px-4 py-8 sm:px-6 sm:py-12", className)}>
        {children}
      </main>
    </div>
  );
}
