import { Layers, LayoutGrid, PackageCheck } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";

// The small "which workflow am I in" chip. Rendered by AppShell's header
// (from sm up) and by WorkflowProgress's mobile summary (below sm), so the
// workflow name is shown exactly once at every breakpoint. Purely
// presentational: it receives the display name and derives nothing.
//
// Icons are a secondary cue only; the visible name is always present and
// a visually hidden "Workflow:" prefix gives assistive tech the context.
const WORKFLOW_ICONS = {
  Declutter: PackageCheck,
  Reorganise: LayoutGrid,
  Both: Layers,
};

export default function PathChip({ workflowName, className }) {
  const Icon = WORKFLOW_ICONS[workflowName] ?? null;
  return (
    <Badge className={cn("gap-1.5 border-primary/15 py-1 font-semibold", className)}>
      {Icon ? <Icon aria-hidden="true" width={13} height={13} className="shrink-0" /> : null}
      <span className="sr-only">Workflow: </span>
      {workflowName}
    </Badge>
  );
}
