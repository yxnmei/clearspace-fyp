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

// Shared review workspace. Overlay linkage and filtering are local presentation
// state; confirmation belongs to the composing page.
export default function DeclutterReviewSection({
  reviewItems,
  imageUrl,
  setDecisionOverride,
  setItemExcluded,
  correctLabel = () => {},
  correctingItemId = null,
  correctionError = null,
  enableBackToTop = false,
  // One-shot external filter request; chips remain user-controlled afterwards.
  filterRequest = null,
}) {
  const correctionDisabled = correctingItemId !== null;
  function correctionErrorFor(itemId) {
    return correctionError && correctionError.itemId === itemId ? correctionError.message : null;
  }

  const [activeItemId, setActiveItemId] = useState(null);
  // Show boxes initially; an active item quietens the others.
  const [showAllBoxes, setShowAllBoxes] = useState(true);
  const [decisionFilter, setDecisionFilter] = useState("all");
  useEffect(() => {
    if (!filterRequest) return;
    const known = REVIEW_DECISION_FILTERS.some((filter) => filter.id === filterRequest.id);
    setDecisionFilter(known ? filterRequest.id : "all");
  }, [filterRequest]);
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
    // Do not let item A's exit clear newly active item B.
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

  // Filters narrow resolved items only; unresolved blockers stay visible.
  const overlayItems = useMemo(
    () => [...visibleResolvedItems, ...unresolvedItems, ...contextualItems],
    [visibleResolvedItems, unresolvedItems, contextualItems]
  );

  // Drop highlights whose row became filtered out.
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
          Review and adjust each item's suggested action or label before confirming.
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
          {/* Clear the sticky action bar, including its taller mobile layout. */}
          <BackToTopButton
            scrollTargetRef={workspaceRef}
            topSentinelRef={topSentinelRef}
            bottomSentinelRef={bottomSentinelRef}
            className="bottom-44 sm:bottom-24"
          />
        </>
      )}
    </div>
  );
}
