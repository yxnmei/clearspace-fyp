import { useEffect, useMemo, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import AnalysedRoomPanel from "./AnalysedRoomPanel";
import DeclutterItemCard from "./DeclutterItemCard";
import DeclutterUnresolvedItems from "./DeclutterUnresolvedItems";
import DeclutterContextualItems from "./DeclutterContextualItems";
import BackToTopButton from "./BackToTopButton";
import {
  partitionReviewItems,
  REVIEW_DECISION_FILTERS,
  filterItemsByDecision,
  deriveDecisionFilterCounts,
} from "../lib/declutterReview";
import { cn } from "../lib/cn";

// The Declutter review content: the human-control header, a decision
// filter row, ONE sticky analysed-room image, the compact actionable
// rows, and the unresolved / contextual lists. It renders no
// confirmation counts, no Confirm button and no confirmed summary, those
// belong to whatever composes this (the Declutter wizard's Confirm view,
// or DeclutterReview for Both).
//
// activeItemId / showAllBoxes / itemRefs / decisionFilter are local
// presentational state for linking the overlay boxes to the rows and for
// narrowing the visible list. None of them is workflow state, and none
// of them changes a decision, correction or exclusion. The three-way
// partition comes from lib/declutterReview so nothing here or in
// DeclutterReview re-implements it.
//
// enableBackToTop mounts the floating Back to Top control plus its
// sentinels. The Declutter wizard's Review view passes it; Both's
// stacked DeclutterReview does not, so Both is unchanged.
export default function DeclutterReviewSection({
  reviewItems,
  imageUrl,
  setDecisionOverride,
  setItemExcluded,
  correctLabel = () => {},
  correctingItemId = null,
  correctionError = null,
  enableBackToTop = false,
}) {
  const correctionDisabled = correctingItemId !== null;
  function correctionErrorFor(itemId) {
    return correctionError && correctionError.itemId === itemId ? correctionError.message : null;
  }

  const [activeItemId, setActiveItemId] = useState(null);
  // Defaults to true so the analysed image shows its detection boxes as
  // soon as results appear. Activating one item quietens the rest.
  const [showAllBoxes, setShowAllBoxes] = useState(true);
  // Default "all"; filters by an item's current review_decision.
  const [decisionFilter, setDecisionFilter] = useState("all");
  const itemRefs = useRef(new Map());

  const workspaceRef = useRef(null);
  const topSentinelRef = useRef(null);
  const bottomSentinelRef = useRef(null);

  function registerItemRef(itemId, el) {
    if (el) itemRefs.current.set(itemId, el);
    else itemRefs.current.delete(itemId);
  }

  function activateItem(itemId) {
    setActiveItemId(itemId);
  }

  function deactivateItem(itemId) {
    // Guards against a blur/mouseleave on item A clobbering item B's
    // freshly-set active state when focus/hover moves directly between
    // rows in the same tick.
    setActiveItemId((current) => (current === itemId ? null : current));
  }

  function focusItem(itemId) {
    const el = itemRefs.current.get(itemId);
    if (!el) return;
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
    el.focus();
  }

  const { resolvedItems, unresolvedItems, contextualItems } = useMemo(
    () => partitionReviewItems(reviewItems),
    [reviewItems]
  );

  const filterCounts = useMemo(() => deriveDecisionFilterCounts(resolvedItems), [resolvedItems]);
  const visibleResolvedItems = useMemo(
    () => filterItemsByDecision(resolvedItems, decisionFilter),
    [resolvedItems, decisionFilter]
  );

  // Unresolved items are always shown (they block confirmation and must
  // never be hidden by a filter); contextual items carry no decision and
  // stay in their own section. Only the resolved list is narrowed.
  const overlayItems = useMemo(
    () => [...visibleResolvedItems, ...unresolvedItems, ...contextualItems],
    [visibleResolvedItems, unresolvedItems, contextualItems]
  );

  // If the active selection is no longer visible after a filter change,
  // drop it so no row-less overlay box stays highlighted.
  useEffect(() => {
    if (activeItemId == null) return;
    const stillVisible = overlayItems.some((item) => item.item_id === activeItemId);
    if (!stillVisible) setActiveItemId(null);
  }, [activeItemId, overlayItems]);

  const activeFilterLabel =
    REVIEW_DECISION_FILTERS.find((filter) => filter.id === decisionFilter)?.label ?? "All";

  return (
    <div ref={workspaceRef} tabIndex={-1} className="space-y-6 scroll-mt-4 focus:outline-none">
      {enableBackToTop && <span ref={topSentinelRef} aria-hidden="true" className="block h-px w-full" />}

      <header>
        <h2 className="text-title font-semibold tracking-tight text-foreground">
          Review your declutter decisions
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          ClearSpace suggested a Keep, Sell, Donate or Discard action for each item it detected. Every
          suggestion is yours to change, exclude or correct. Nothing is finalised until you press Confirm
          decisions.
        </p>
        <p className="mt-3 inline-flex items-center gap-2 rounded-pill bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
          <ShieldCheck aria-hidden="true" width={13} height={13} />
          You're in control
        </p>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="lg:sticky lg:top-4 lg:w-[40%] lg:flex-shrink-0">
          <AnalysedRoomPanel
            imageUrl={imageUrl}
            items={overlayItems}
            activeItemId={activeItemId}
            onBoxClick={focusItem}
            showAllBoxes={showAllBoxes}
            onToggleShowAllBoxes={setShowAllBoxes}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">Actionable items</h3>
              <div
                role="group"
                aria-label="Filter items by decision"
                className="flex flex-wrap items-center gap-1.5"
              >
                {REVIEW_DECISION_FILTERS.map((filter) => {
                  const active = decisionFilter === filter.id;
                  return (
                    <button
                      key={filter.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setDecisionFilter(filter.id)}
                      className={cn(
                        "rounded-pill border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-surface text-muted-foreground hover:bg-surface-muted"
                      )}
                    >
                      {filter.label}
                      <span className="ml-1 tabular-nums opacity-80">{filterCounts[filter.id]}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {resolvedItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No resolved actionable items yet.</p>
            ) : visibleResolvedItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No items currently marked as {activeFilterLabel}.
              </p>
            ) : (
              <ul className="space-y-2">
                {visibleResolvedItems.map((item) => (
                  <DeclutterItemCard
                    key={item.item_id}
                    item={item}
                    imageUrl={imageUrl}
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
          </section>

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

          {contextualItems.length > 0 && (
            <DeclutterContextualItems
              items={contextualItems}
              activeItemId={activeItemId}
              registerItemRef={registerItemRef}
              activateItem={activateItem}
              deactivateItem={deactivateItem}
            />
          )}
        </div>
      </div>

      {enableBackToTop && (
        <>
          <span ref={bottomSentinelRef} aria-hidden="true" className="block h-px w-full" />
          <BackToTopButton
            scrollTargetRef={workspaceRef}
            topSentinelRef={topSentinelRef}
            bottomSentinelRef={bottomSentinelRef}
          />
        </>
      )}
    </div>
  );
}
