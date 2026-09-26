import { Layers, LayoutGrid, PackageCheck } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";

// Responsive workflow label; visible text remains the primary cue.
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
