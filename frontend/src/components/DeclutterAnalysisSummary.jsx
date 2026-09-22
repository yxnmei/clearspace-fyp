import { Sofa, ScanSearch, ListChecks, TriangleAlert } from "lucide-react";

// The "What we found" summary on the Declutter / Both Analyse space
// screen, presentational only: every value comes straight from the
// analysis and declutter results the page already holds. On a
// successful analysis this heading is the screen's ONE visible h2: the
// workflow tracker already says "Analysis complete." and names the next
// action (in an aria-live region), so the page renders no second
// success heading or banner.
//
// Deliberately user-facing: the space type (no confidence percentage),
// how many items were found, and how many are ready to review on Decide
// items. No analysis timing, no candidate / detection / classification
// vocabulary, no warning codes. Contextual items are not counted here
// because Decide items explains them where they appear. A warning is one
// calm sentence, rendered only when the analysis actually carries one.
//
// `contextualCount` and `totalDurationMs` are still accepted from older
// callers but are not shown.
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

export default function DeclutterAnalysisSummary({ analysis, declutter }) {
  const hasWarnings = Array.isArray(analysis.warnings) && analysis.warnings.length > 0;

  return (
    <section
      aria-labelledby="declutter-analysis-summary-heading"
      className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6"
    >
      <h2 id="declutter-analysis-summary-heading" className="text-title font-semibold tracking-tight text-foreground">
        What we found
      </h2>
      <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <Stat icon={Sofa} label="Space type" value={analysis.scene.label} />
        <Stat icon={ScanSearch} label="Items found" value={analysis.items.length} />
        <Stat icon={ListChecks} label="Ready to review" value={declutter.expected_item_ids.length} />
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
