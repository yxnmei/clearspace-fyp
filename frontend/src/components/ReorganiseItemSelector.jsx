import { useRef, useState } from "react";
import { formatConfidence, itemNumberLabel } from "../utils/format";
import AnalysedRoomPanel from "./AnalysedRoomPanel";
import BackToTopButton from "./BackToTopButton";

function reorganiseBoxClassName(item, isActive, isQuiet, selectedSet) {
  const base = "absolute rounded-sm border-2 transition-none";
  const category = selectedSet.has(item.item_id)
    ? "border-green-700 bg-green-700/10"
    : "border-dashed border-stone-400 bg-stone-400/10";
  const state = isActive
    ? "z-20 border-4 ring-2 ring-stone-900 ring-offset-1 opacity-100"
    : isQuiet
      ? "opacity-30"
      : "opacity-90";
  return `${base} ${category} ${state}`;
}

// Direct Reorganise's dedicated Review screen. Every actionable detection
// starts included; the user may exclude false detections before moving to
// the separate Generate screen. Its layout and long-list navigation match
// DeclutterReviewSection while its binary interaction stays workflow-specific.
export default function ReorganiseItemSelector({
  items,
  selectedItemIds,
  onToggleItem,
  imageUrl,
  selectionDisabled = false,
  enableBackToTop = false,
}) {
  const selectedSet = new Set(selectedItemIds);
  const [activeItemId, setActiveItemId] = useState(null);
  const [showAllBoxes, setShowAllBoxes] = useState(true);
  const itemRefs = useRef(new Map());
  const workspaceRef = useRef(null);
  const topSentinelRef = useRef(null);
  const bottomSentinelRef = useRef(null);

  function registerItemRef(itemId, el) {
    if (el) itemRefs.current.set(itemId, el);
    else itemRefs.current.delete(itemId);
  }

  function focusItem(itemId) {
    const el = itemRefs.current.get(itemId);
    if (!el) return;
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
    el.focus();
  }

  function activate(itemId) {
    setActiveItemId(itemId);
  }

  function deactivate(itemId) {
    setActiveItemId((current) => (current === itemId ? null : current));
  }

  const actionableItems = items.filter((item) => item.item_role === "actionable");
  const contextualItems = items.filter((item) => item.item_role !== "actionable");

  return (
    <div ref={workspaceRef} tabIndex={-1} className="space-y-6 scroll-mt-4 focus:outline-none">
      {enableBackToTop && <span ref={topSentinelRef} aria-hidden="true" className="block h-px w-full" />}

      <header>
        <h2 className="text-title font-semibold tracking-tight text-foreground">Review items for your room plan</h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          All {actionableItems.length} actionable detection{actionableItems.length === 1 ? " is" : "s are"} included
          by default. Exclude anything detected incorrectly or anything that should not be part of the plan.
        </p>
        <p className="mt-3 inline-flex rounded-pill bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
          {selectedItemIds.length} of {actionableItems.length} included
        </p>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="lg:sticky lg:top-4 lg:w-[40%] lg:flex-shrink-0">
          <AnalysedRoomPanel
            imageUrl={imageUrl}
            items={items}
            activeItemId={activeItemId}
            onBoxClick={focusItem}
            showAllBoxes={showAllBoxes}
            onToggleShowAllBoxes={setShowAllBoxes}
            getBoxClassName={(item, isActive, isQuiet) =>
              reorganiseBoxClassName(item, isActive, isQuiet, selectedSet)
            }
          />
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">Actionable items</h3>
            {actionableItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No actionable items were detected.</p>
            ) : (
              <ul className="space-y-2">
                {actionableItems.map((item) => {
                  const isSelected = selectedSet.has(item.item_id);
                  const isActive = item.item_id === activeItemId;
                  return (
                    <li
                      key={item.item_id}
                      ref={(el) => registerItemRef(item.item_id, el)}
                      tabIndex={-1}
                      aria-current={isActive ? "true" : undefined}
                      onMouseEnter={() => activate(item.item_id)}
                      onMouseLeave={() => deactivate(item.item_id)}
                      onFocus={() => activate(item.item_id)}
                      onBlur={() => deactivate(item.item_id)}
                      className={`flex items-start gap-3 rounded-card border bg-surface p-3 shadow-card ${
                        isActive ? "border-primary ring-1 ring-primary" : "border-border"
                      }`}
                    >
                      <input
                        type="checkbox"
                        id={`reorganise-item-${item.item_id}`}
                        checked={isSelected}
                        disabled={selectionDisabled}
                        onChange={() => onToggleItem(item.item_id)}
                        className="mt-1 h-4 w-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <label htmlFor={`reorganise-item-${item.item_id}`} className="min-w-0 flex-1 cursor-pointer">
                        <p className="font-medium text-foreground">
                          <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-stone-800 text-[11px] font-semibold text-white">
                            {itemNumberLabel(item.item_id)}
                          </span>
                          {item.effective_label}
                          <span
                            className={`ml-2 rounded-pill border px-2 py-0.5 text-xs font-medium ${
                              isSelected
                                ? "border-success/40 bg-success/10 text-success"
                                : "border-border bg-surface-muted text-muted-foreground"
                            }`}
                          >
                            {isSelected ? "Included in plan" : "Excluded from plan"}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          item_id: <code>{item.item_id}</code> · {item.position}, {item.relative_size} ·{" "}
                          {formatConfidence(item.confidence)} detection confidence
                        </p>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {contextualItems.length > 0 && (
            <section className="rounded-card border border-border bg-surface-muted p-3">
              <h3 className="mb-1 text-sm font-semibold text-foreground">Contextual items ({contextualItems.length})</h3>
              <p className="mb-2 text-xs text-muted-foreground">Shown for context and not included in the plan.</p>
              <ul className="space-y-1">
                {contextualItems.map((item) => (
                  <li
                    key={item.item_id}
                    ref={(el) => registerItemRef(item.item_id, el)}
                    tabIndex={0}
                    aria-current={item.item_id === activeItemId ? "true" : undefined}
                    onMouseEnter={() => activate(item.item_id)}
                    onMouseLeave={() => deactivate(item.item_id)}
                    onFocus={() => activate(item.item_id)}
                    onBlur={() => deactivate(item.item_id)}
                    className="rounded-control border border-border bg-surface p-2 text-xs text-muted-foreground"
                  >
                    {item.effective_label} <code>{item.item_id}</code>
                  </li>
                ))}
              </ul>
            </section>
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
