import { Clock, Layers, ScanSearch, Sofa, Sparkles, TriangleAlert } from "lucide-react";
import { formatConfidence } from "../utils/format";
import { cn } from "../lib/cn";

function Stat({ icon: Icon, label, value, tone = "default" }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-control border border-border bg-surface-muted p-3",
        tone === "warning" && "border-warning/40 bg-warning/10"
      )}
    >
      <Icon
        aria-hidden="true"
        width={16}
        height={16}
        className={cn("mt-0.5 shrink-0", tone === "warning" ? "text-warning" : "text-primary")}
      />
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="truncate text-sm font-medium text-foreground">{value}</dd>
      </div>
    </div>
  );
}

// Direct Reorganise's Analyse screen. It deliberately mirrors the
// Declutter summary card while naming the different downstream action
// honestly: Direct Reorganise selects actionable detections for a room
// plan; it does not send them through Declutter decision reasoning.
export default function ReorganiseAnalysisSummary({ analysis }) {
  const actionableCount = analysis.items.filter((item) => item.item_role === "actionable").length;
  const contextualCount = analysis.items.length - actionableCount;
  const warningCount = analysis.warnings.length;
  const totalDurationMs = analysis.stage_timings.reduce((total, timing) => total + timing.duration_ms, 0);

  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6">
      <h2 className="mb-3 text-lg font-semibold text-foreground">2. Analysis summary</h2>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Stat
          icon={Sofa}
          label="Scene"
          value={`${analysis.scene.label} (${formatConfidence(analysis.scene.confidence)})`}
        />
        <Stat icon={ScanSearch} label="Candidate detections" value={analysis.items.length} />
        <Stat icon={Sparkles} label="Included in plan" value={actionableCount} />
        <Stat icon={Layers} label="Contextual items" value={contextualCount} />
        <Stat
          icon={TriangleAlert}
          label="Processing warnings"
          value={warningCount}
          tone={warningCount > 0 ? "warning" : "default"}
        />
        <Stat icon={Clock} label="Analysis time" value={`${(totalDurationMs / 1000).toFixed(1)}s`} />
      </dl>
    </section>
  );
}
