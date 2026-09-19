// "Your reorganisation checklist": the numbered action cards of a
// Reorganise result. Shared by Direct Reorganise and Both through
// ReorganiseResult so the rendering exists exactly once.
//
// The checklist is prose the user reads and acts on, not an item
// partition: no card is joined to an item_id, and nothing here hides or
// invents an action. Where the checklist came from is said plainly in one
// sentence; the technical record (provenance value, attempts, model,
// prompt version, duration, the single issue if any) stays in a collapsed
// disclosure. Raw model output never reaches the client at all.
const SOURCE_COPY = {
  llm_generated: "Suggested by the AI assistant from your selected items and notes. Read each step before you follow it.",
  deterministic_fallback:
    "The AI assistant did not return a usable checklist this time, so this one is built directly from where your selected items sit in the photo.",
  deterministic_direct: "Built directly from where your selected items sit in the photo, without the AI assistant.",
};

const ISSUE_COPY = {
  call_failed: "The AI assistant could not be reached or did not answer in time.",
  invalid_json: "The AI assistant's reply was not valid JSON.",
  invalid_actions: "The AI assistant's reply did not match the checklist rules.",
};

function ChecklistDetails({ actionPlan }) {
  return (
    <details className="rounded-control border border-border bg-surface-muted p-3 text-sm text-foreground">
      <summary className="cursor-pointer font-medium">Checklist details</summary>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Provenance</dt>
          <dd>{actionPlan.provenance}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Model calls</dt>
          <dd>{actionPlan.attempts}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Model</dt>
          <dd>{actionPlan.model_name ?? "n/a"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Prompt version</dt>
          <dd>{actionPlan.prompt_version ?? "n/a"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Checklist duration</dt>
          <dd>{(actionPlan.duration_ms / 1000).toFixed(2)}s</dd>
        </div>
      </dl>
      {actionPlan.issues.length > 0 && (
        <div className="mt-3">
          <p className="text-muted-foreground">Why the AI checklist was not used:</p>
          <ul className="list-inside list-disc">
            {actionPlan.issues.map((issue, i) => (
              <li key={i}>
                {ISSUE_COPY[issue.kind] ?? "The AI assistant's reply could not be used."}{" "}
                <span className="text-muted-foreground">({issue.kind})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

export default function ReorganiseChecklist({ actionPlan }) {
  return (
    <section
      aria-labelledby="reorganise-checklist-heading"
      className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6"
    >
      <h2 id="reorganise-checklist-heading" className="text-lg font-semibold text-foreground">
        Your reorganisation checklist
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {SOURCE_COPY[actionPlan.provenance] ?? SOURCE_COPY.deterministic_direct}
      </p>
      <ol className="mt-4 space-y-3" aria-label="Checklist actions">
        {actionPlan.actions.map((action) => (
          <li
            key={action.priority}
            className="flex gap-3 rounded-card border border-border bg-surface-muted p-4"
          >
            <span
              data-testid="checklist-step-number"
              className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
            >
              {action.priority}
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">{action.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{action.instruction}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-3">
        <ChecklistDetails actionPlan={actionPlan} />
      </div>
    </section>
  );
}
