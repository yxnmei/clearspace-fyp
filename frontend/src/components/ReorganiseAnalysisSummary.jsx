import { Sofa, ScanSearch, ListChecks, TriangleAlert } from "lucide-react";

// The "What we found" summary on Direct Reorganise's Analyse space
// screen. It mirrors the Declutter summary's shape and vocabulary while
// naming the different downstream action honestly: Direct Reorganise
// lets the user include actionable items in a tidy plan on Select
// items; it does not send them through decision reasoning. On a
// successful analysis this heading is the screen's ONE visible h2: the
// workflow tracker already says "Analysis complete." and names the next
// action (in an aria-live region), so the page renders no second
// success heading or banner.
//
// User-facing only: the space type (no confidence percentage), how many
// items were found, and how many are available to include. No analysis
// timing, no candidate / detection / classification vocabulary, no
// warning codes; a warning is one calm sentence, rendered only when the
// analysis actually carries one.
function Stat({ icon: Icon, label, value }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-control border border-border bg-surface-muted p-3">
      <Icon aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0 text-primary" />
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="truncate text-sm font-medium text-foreground">{value}</dd>
      </div>
    </div>
  );
}

export default function ReorganiseAnalysisSummary({ analysis }) {
  const actionableCount = analysis.items.filter((item) => item.item_role === "actionable").length;
  const hasWarnings = Array.isArray(analysis.warnings) && analysis.warnings.length > 0;

  return (
    <section
      aria-labelledby="reorganise-analysis-summary-heading"
      className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6"
    >
      <h2 id="reorganise-analysis-summary-heading" className="text-title font-semibold tracking-tight text-foreground">
        What we found
      </h2>
      <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <Stat icon={Sofa} label="Space type" value={analysis.scene.label} />
        <Stat icon={ScanSearch} label="Items found" value={analysis.items.length} />
        <Stat icon={ListChecks} label="Available to include" value={actionableCount} />
      </dl>
      {hasWarnings && (
        <p className="mt-3 flex items-start gap-2 rounded-control border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
          <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0 text-warning" />
          Some results may need extra review.
        </p>
      )}
    </section>
  );
}
