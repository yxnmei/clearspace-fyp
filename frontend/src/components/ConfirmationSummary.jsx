// Renders the normalized ConfirmationResult from useDeclutterFlow's
// confirmation state. Confirmed Keep item_ids are matched back to
// reviewItems strictly by item_id — never by label — so this component
// can show a clean_label/position next to each confirmed Keep item.
//
// nextStepNote (R6, Both — required correction 6/"configurable
// confirmation handoff wording"): optional, defaults to the exact
// original hardcoded string below — DeclutterReview's own existing call
// site never passes it, so Declutter's rendered output is byte-for-byte
// unchanged. useBothFlow's BothPage passes a Both-specific note instead,
// since for Both, Reorganise isn't a hypothetical "future stage" (a
// separate workflow the user might start later) — it's the very next
// step of the SAME flow, one click away.
export default function ConfirmationSummary({
  confirmation,
  reviewItems,
  nextStepNote = "Only these confirmed Keep items will be available to the future Reorganise stage.",
}) {
  const counts = { keep: 0, sell: 0, donate: 0, discard: 0 };
  for (const decision of confirmation.confirmedDecisions) {
    counts[decision.confirmed_decision] += 1;
  }

  const reviewItemsById = new Map(reviewItems.map((item) => [item.item_id, item]));
  const keepItems = confirmation.confirmedKeepIds.map((itemId) => ({
    item_id: itemId,
    matched: reviewItemsById.get(itemId) ?? null,
  }));

  return (
    <section className="rounded-lg border border-green-300 bg-green-50 p-5 shadow-sm">
      <h2 className="mb-1 text-lg font-medium text-green-900">Decisions confirmed</h2>
      <p role="status" className="mb-4 text-sm text-green-800">
        Run {confirmation.runId} — {confirmation.confirmedDecisions.length} decision
        {confirmation.confirmedDecisions.length === 1 ? "" : "s"} confirmed.
      </p>

      <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-green-700">Keep</dt>
          <dd className="text-green-950">{counts.keep}</dd>
        </div>
        <div>
          <dt className="text-green-700">Sell</dt>
          <dd className="text-green-950">{counts.sell}</dd>
        </div>
        <div>
          <dt className="text-green-700">Donate</dt>
          <dd className="text-green-950">{counts.donate}</dd>
        </div>
        <div>
          <dt className="text-green-700">Discard</dt>
          <dd className="text-green-950">{counts.discard}</dd>
        </div>
        <div>
          <dt className="text-green-700">Changed from AI</dt>
          <dd className="text-green-950">{confirmation.decisionChangedCount}</dd>
        </div>
        <div>
          <dt className="text-green-700">Excluded</dt>
          <dd className="text-green-950">{confirmation.excludedCount}</dd>
        </div>
      </dl>

      <h3 className="mb-1 text-sm font-medium text-green-900">
        Confirmed Keep items ({keepItems.length})
      </h3>
      <p className="mb-2 text-sm text-green-800">{nextStepNote}</p>
      {keepItems.length === 0 ? (
        <p className="text-sm text-green-700">No items were confirmed as Keep.</p>
      ) : (
        <ul className="space-y-1">
          {keepItems.map(({ item_id, matched }) => (
            <li key={item_id} className="rounded-md border border-green-200 bg-white p-2 text-sm text-stone-800">
              <code>{item_id}</code>
              {matched && (
                <>
                  {" — "}
                  {matched.effective_label ?? matched.clean_label}
                  {matched.position && <span className="text-stone-500"> ({matched.position})</span>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
