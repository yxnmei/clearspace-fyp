import { formatConfidence } from "../utils/format";
import DeclutterItemCard from "./DeclutterItemCard";
import ConfirmationSummary from "./ConfirmationSummary";

// Renders the joined reviewItems useDeclutterFlow already built — this
// component only splits them into the three groups the backend contract
// distinguishes (resolved expected / unresolved expected / contextual)
// and dispatches setDecisionOverride/setItemExcluded/confirm. No
// orchestration or API calls live here.
export default function DeclutterReview({
  analysis,
  declutter,
  reviewItems,
  setDecisionOverride,
  setItemExcluded,
  confirm,
  confirmationStatus,
  confirmationError,
  confirmation,
}) {
  const resolvedItems = reviewItems.filter((item) => item.is_expected && !item.is_unresolved);
  const unresolvedItems = reviewItems.filter((item) => item.is_expected && item.is_unresolved);
  const contextualItems = reviewItems.filter((item) => !item.is_expected);

  const counts = { keep: 0, sell: 0, donate: 0, discard: 0 };
  let changedCount = 0;
  let excludedCount = 0;
  for (const item of resolvedItems) {
    if (item.review_decision) counts[item.review_decision] += 1;
    if (item.decision_changed) changedCount += 1;
    if (item.review_excluded) excludedCount += 1;
  }
  const unresolvedCount = unresolvedItems.length;

  const totalDurationMs = (analysis.stage_timings ?? []).reduce((sum, stage) => sum + stage.duration_ms, 0);

  const confirmDisabled = confirmationStatus === "confirming" || !declutter || unresolvedCount > 0;

  return (
    <div className="mt-6 space-y-6">
      {/* --- Analysis summary --- */}
      <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-lg font-medium text-stone-900">2. Analysis summary</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-stone-500">Scene</dt>
            <dd className="text-stone-900">
              {analysis.scene.label} ({formatConfidence(analysis.scene.confidence)})
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Detected items</dt>
            <dd className="text-stone-900">{analysis.items.length}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Actionable items</dt>
            <dd className="text-stone-900">{declutter.expected_item_ids.length}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Contextual items</dt>
            <dd className="text-stone-900">{contextualItems.length}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Analysis warnings</dt>
            <dd className="text-stone-900">{analysis.warnings.length}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Analysis time</dt>
            <dd className="text-stone-900">{(totalDurationMs / 1000).toFixed(1)}s</dd>
          </div>
        </dl>
      </section>

      {/* --- Resolved, expected items --- */}
      <section>
        <h2 className="mb-3 text-lg font-medium text-stone-900">3. Review each item</h2>
        {resolvedItems.length === 0 ? (
          <p className="text-sm text-stone-500">No resolved actionable items yet.</p>
        ) : (
          <ul className="space-y-3">
            {resolvedItems.map((item) => (
              <DeclutterItemCard
                key={item.item_id}
                item={item}
                onDecisionChange={setDecisionOverride}
                onExcludedChange={setItemExcluded}
              />
            ))}
          </ul>
        )}
      </section>

      {/* --- Unresolved expected items --- */}
      {unresolvedItems.length > 0 && (
        <section className="rounded-lg border border-red-300 bg-red-50 p-4">
          <h2 className="mb-2 text-sm font-medium text-red-900">Unresolved items ({unresolvedItems.length})</h2>
          <p className="mb-3 text-sm text-red-800">
            The AI could not produce a valid decision for these items. Confirmation is blocked until every item is
            resolved — no decision can be fabricated for them here.
          </p>
          <ul className="space-y-2">
            {unresolvedItems.map((item) => (
              <li key={item.item_id} className="rounded-md border border-red-200 bg-white p-3 text-sm">
                <span className="font-medium text-stone-900">{item.clean_label}</span>{" "}
                <span className="text-stone-500">
                  (item_id: <code>{item.item_id}</code>, {item.position}, {item.relative_size})
                </span>
                <p className="mt-1 text-red-700">No valid AI decision was produced for this item.</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* --- Contextual / non-expected items --- */}
      {contextualItems.length > 0 && (
        <section className="rounded-lg border border-stone-200 bg-stone-50 p-4">
          <h2 className="mb-2 text-sm font-medium text-stone-700">Contextual items ({contextualItems.length})</h2>
          <p className="mb-3 text-sm text-stone-500">
            Detected for context only — not sent for a Declutter decision.
          </p>
          <ul className="space-y-2">
            {contextualItems.map((item) => (
              <li key={item.item_id} className="rounded-md border border-stone-200 bg-white p-3 text-sm text-stone-700">
                <span className="font-medium">{item.clean_label}</span>{" "}
                <span className="text-stone-500">
                  (item_id: <code>{item.item_id}</code>, {item.position}, {item.relative_size})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* --- Review summary + confirm --- */}
      <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-lg font-medium text-stone-900">4. Confirm decisions</h2>
        <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-stone-500">Keep</dt>
            <dd className="text-stone-900">{counts.keep}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Sell</dt>
            <dd className="text-stone-900">{counts.sell}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Donate</dt>
            <dd className="text-stone-900">{counts.donate}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Discard</dt>
            <dd className="text-stone-900">{counts.discard}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Changed</dt>
            <dd className="text-stone-900">{changedCount}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Excluded</dt>
            <dd className="text-stone-900">{excludedCount}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Unresolved</dt>
            <dd className="text-stone-900">{unresolvedCount}</dd>
          </div>
        </dl>

        <button
          type="button"
          onClick={confirm}
          disabled={confirmDisabled}
          className="rounded-md bg-green-800 px-4 py-2 text-sm font-medium text-white hover:bg-green-900 disabled:cursor-not-allowed disabled:bg-stone-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
        >
          {confirmationStatus === "confirming" ? "Confirming…" : "Confirm decisions"}
        </button>

        {unresolvedCount > 0 && (
          <p className="mt-2 text-xs text-stone-500">
            Resolve every unresolved item above before confirmation is available.
          </p>
        )}

        {confirmationStatus === "error" && confirmationError && (
          <p role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            {confirmationError} Your review decisions and exclusions are unchanged — you can try again.
          </p>
        )}
      </section>

      {confirmation && <ConfirmationSummary confirmation={confirmation} reviewItems={reviewItems} />}
    </div>
  );
}
