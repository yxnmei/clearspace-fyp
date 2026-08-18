import { useRef, useState } from "react";
import { formatConfidence } from "../utils/format";
import AnalysedRoomPanel from "./AnalysedRoomPanel";
import DeclutterItemCard, { LabelCorrectionControl } from "./DeclutterItemCard";
import ConfirmationSummary from "./ConfirmationSummary";

// Renders the joined reviewItems useDeclutterFlow already built — this
// component only splits them into the three groups the backend contract
// distinguishes (resolved expected / unresolved expected / contextual)
// and dispatches setDecisionOverride/setItemExcluded/confirm. No
// orchestration or API calls live here.
//
// activeItemId/showAllBoxes/itemRefs are purely local presentational UI
// state for linking the analysed-room overlay to the item list — not
// workflow state, so (matching DeclutterUploadForm's existing local-state
// convention) they stay here rather than in useDeclutterFlow. itemRefs
// covers all three categories (resolved cards, unresolved and contextual
// list entries), since AnalysedRoomPanel draws boxes for all of them and
// a box click must be able to reach any of them.
export default function DeclutterReview({
  analysis,
  declutter,
  reviewItems,
  imageUrl,
  setDecisionOverride,
  setItemExcluded,
  confirm,
  confirmationStatus,
  confirmationError,
  confirmation,
  correctLabel = () => {},
  correctingItemId = null,
  correctionError = null,
  // R6/Both — required correction 6: forwarded straight to
  // ConfirmationSummary's own `nextStepNote` prop, undefined by default.
  // DeclutterPage's existing call site never passes this, so its
  // rendered output stays byte-for-byte unchanged; ConfirmationSummary's
  // own default text applies exactly as before.
  confirmationNextStepNote,
}) {
  // Any correction in flight disables every item's correction control
  // (not just the one being corrected) — see useDeclutterFlow's
  // correctLabel docstring for why cross-item corrections are serialized
  // rather than run concurrently. correctionErrorFor scopes the shared
  // { itemId, message } error down to the one card it actually belongs
  // to, so a failure on one item never appears next to another.
  const correctionDisabled = correctingItemId !== null;
  function correctionErrorFor(itemId) {
    return correctionError && correctionError.itemId === itemId ? correctionError.message : null;
  }
  const [activeItemId, setActiveItemId] = useState(null);
  // Defaults to true so the analysed image visibly shows its detection
  // boxes as soon as results appear — a false default left the panel
  // looking box-free (undiscoverable, and at odds with the guidance text
  // telling the user to review the highlighted image). Users can still
  // turn this off, and activating one item already quietens the rest.
  const [showAllBoxes, setShowAllBoxes] = useState(true);
  const itemRefs = useRef(new Map());

  function registerItemRef(itemId, el) {
    if (el) itemRefs.current.set(itemId, el);
    else itemRefs.current.delete(itemId);
  }

  function activateItem(itemId) {
    setActiveItemId(itemId);
  }

  function deactivateItem(itemId) {
    // Guards against a blur/mouseleave on item A clobbering item B's
    // freshly-set active state when focus/hover moves directly from one
    // item to another within the same tick.
    setActiveItemId((current) => (current === itemId ? null : current));
  }

  function focusItem(itemId) {
    const el = itemRefs.current.get(itemId);
    if (!el) return;
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
    el.focus();
  }

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

  const confirmDisabled =
    confirmationStatus === "confirming" || !declutter || unresolvedCount > 0 || correctingItemId !== null;

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
            {/* Renamed from "Detected items" — this is a count of returned
                boxes, not a claim of detection completeness (§6). */}
            <dt className="text-stone-500">Candidate detections</dt>
            <dd className="text-stone-900">{analysis.items.length}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Candidates sent for suggestions</dt>
            <dd className="text-stone-900">{declutter.expected_item_ids.length}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Contextual items</dt>
            <dd className="text-stone-900">{contextualItems.length}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Processing warnings</dt>
            <dd className="text-stone-900">{analysis.warnings.length}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Analysis time</dt>
            <dd className="text-stone-900">{(totalDurationMs / 1000).toFixed(1)}s</dd>
          </div>
        </dl>
      </section>

      {/* --- Resolved, expected items, alongside the analysed-room overlay --- */}
      <section>
        <h2 className="mb-3 text-lg font-medium text-stone-900">3. Review each item</h2>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <div className="lg:sticky lg:top-4 lg:w-[42%] lg:flex-shrink-0">
            <AnalysedRoomPanel
              imageUrl={imageUrl}
              items={reviewItems}
              activeItemId={activeItemId}
              onBoxClick={focusItem}
              showAllBoxes={showAllBoxes}
              onToggleShowAllBoxes={setShowAllBoxes}
            />
          </div>
          <div className="min-w-0 flex-1">
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
                    isActive={item.item_id === activeItemId}
                    onActivate={() => activateItem(item.item_id)}
                    onDeactivate={() => deactivateItem(item.item_id)}
                    registerRef={registerItemRef}
                    onCorrectLabel={correctLabel}
                    isCorrecting={correctingItemId === item.item_id}
                    correctionDisabled={correctionDisabled}
                    correctionError={correctionErrorFor(item.item_id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* --- Unresolved expected items --- */}
      {unresolvedItems.length > 0 && (
        <section className="rounded-lg border border-red-300 bg-red-50 p-4">
          <h2 className="mb-2 text-sm font-medium text-red-900">Unresolved items ({unresolvedItems.length})</h2>
          <p className="mb-3 text-sm text-red-800">
            The AI could not produce a valid decision for these items. Confirmation is blocked until every item is
            resolved — no decision can be fabricated for them here. If the detected label looks wrong, correcting it
            lets ClearSpace retry its reasoning for just this one item.
          </p>
          <ul className="space-y-2">
            {unresolvedItems.map((item) => (
              <li
                key={item.item_id}
                ref={(el) => registerItemRef(item.item_id, el)}
                tabIndex={0}
                aria-current={item.item_id === activeItemId ? "true" : undefined}
                onMouseEnter={() => activateItem(item.item_id)}
                onMouseLeave={() => deactivateItem(item.item_id)}
                onFocus={() => activateItem(item.item_id)}
                onBlur={() => deactivateItem(item.item_id)}
                className={`rounded-md border bg-white p-3 text-sm ${item.item_id === activeItemId ? "border-stone-900 ring-1 ring-stone-900" : "border-red-200"}`}
              >
                <span className="font-medium text-stone-900">{item.effective_label ?? item.clean_label}</span>{" "}
                {item.label_source === "user" && (
                  <span className="rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800">
                    Corrected by you
                  </span>
                )}{" "}
                <span className="text-stone-500">
                  (item_id: <code>{item.item_id}</code>, {item.position}, {item.relative_size})
                </span>
                <p className="mt-1 text-red-700">No valid AI decision was produced for this item.</p>
                <div className="mt-2">
                  <LabelCorrectionControl
                    item={item}
                    isCorrecting={correctingItemId === item.item_id}
                    correctionDisabled={correctionDisabled}
                    correctionError={correctionErrorFor(item.item_id)}
                    onCorrectLabel={correctLabel}
                  />
                </div>
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
              <li
                key={item.item_id}
                ref={(el) => registerItemRef(item.item_id, el)}
                tabIndex={0}
                aria-current={item.item_id === activeItemId ? "true" : undefined}
                onMouseEnter={() => activateItem(item.item_id)}
                onMouseLeave={() => deactivateItem(item.item_id)}
                onFocus={() => activateItem(item.item_id)}
                onBlur={() => deactivateItem(item.item_id)}
                className={`rounded-md border bg-white p-3 text-sm text-stone-700 ${item.item_id === activeItemId ? "border-stone-900 ring-1 ring-stone-900" : "border-stone-200"}`}
              >
                <span className="font-medium">{item.effective_label ?? item.clean_label}</span>{" "}
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

      {confirmation && (
        <ConfirmationSummary confirmation={confirmation} reviewItems={reviewItems} nextStepNote={confirmationNextStepNote} />
      )}
    </div>
  );
}
