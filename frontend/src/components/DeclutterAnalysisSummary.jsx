import { Sofa, ScanSearch, ListChecks, TriangleAlert } from "lucide-react";

// User-facing Declutter/Both summary and the success screen's only h2.
// contextualCount and totalDurationMs remain accepted but are not displayed.
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
