import { useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import AnalysedRoomPanel from "./AnalysedRoomPanel";
import DeclutterItemCard from "./DeclutterItemCard";
import DeclutterAnalysisSummary from "./DeclutterAnalysisSummary";
import DeclutterUnresolvedItems from "./DeclutterUnresolvedItems";
import DeclutterContextualItems from "./DeclutterContextualItems";
import DeclutterConfirmationPanel from "./DeclutterConfirmationPanel";
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
//
// The analysis summary, unresolved list, contextual list and confirmation
// panel are presentational children; every computation, partition,
// callback argument and the confirmation guard live here, and the
// children receive already-derived values.
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
  // Forwarded to ConfirmationSummary's `nextStepNote`. Undefined by
  // default, so DeclutterPage (which never passes it) keeps
  // ConfirmationSummary's standalone-Declutter wording; Both passes a
  // note pointing at its immediate reorganisation step.
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
      {/* --- Results header --- */}
      <header>
        <h2 className="text-title font-semibold tracking-tight text-foreground">
          Review your declutter decisions
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          ClearSpace suggested a Keep, Sell, Donate or Discard action for each item it detected. Every
          suggestion is yours to change, exclude or correct — nothing is finalised until you press Confirm
          decisions.
        </p>
        <p className="mt-3 inline-flex items-center gap-2 rounded-pill bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
          <ShieldCheck aria-hidden="true" width={13} height={13} />
          You're in control
        </p>
      </header>

      {/* --- Analysis summary --- */}
      <DeclutterAnalysisSummary
        analysis={analysis}
        declutter={declutter}
        contextualCount={contextualItems.length}
        totalDurationMs={totalDurationMs}
      />

      {/* --- Resolved, expected items, alongside the analysed-room overlay --- */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-foreground">3. Review each item</h2>
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
              <p className="text-sm text-muted-foreground">No resolved actionable items yet.</p>
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
        <DeclutterUnresolvedItems
          items={unresolvedItems}
          activeItemId={activeItemId}
          registerItemRef={registerItemRef}
          activateItem={activateItem}
          deactivateItem={deactivateItem}
          correctingItemId={correctingItemId}
          correctionDisabled={correctionDisabled}
          correctionErrorFor={correctionErrorFor}
          correctLabel={correctLabel}
        />
      )}

      {/* --- Contextual / non-expected items --- */}
      {contextualItems.length > 0 && (
        <DeclutterContextualItems
          items={contextualItems}
          activeItemId={activeItemId}
          registerItemRef={registerItemRef}
          activateItem={activateItem}
          deactivateItem={deactivateItem}
        />
      )}

      {/* --- Review summary + confirm --- */}
      <DeclutterConfirmationPanel
        counts={counts}
        changedCount={changedCount}
        excludedCount={excludedCount}
        unresolvedCount={unresolvedCount}
        confirmDisabled={confirmDisabled}
        confirmationStatus={confirmationStatus}
        confirmationError={confirmationError}
        onConfirm={confirm}
      />

      {confirmation && (
        <ConfirmationSummary
          confirmation={confirmation}
          reviewItems={reviewItems}
          nextStepNote={confirmationNextStepNote}
        />
      )}
    </div>
  );
}
