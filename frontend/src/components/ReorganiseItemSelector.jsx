import { useRef, useState } from "react";
import { Check, CircleOff, ScanSearch, TriangleAlert } from "lucide-react";
import { itemNumberLabel } from "../utils/format";
import AnalysedRoomPanel from "./AnalysedRoomPanel";
import BackToTopButton from "./BackToTopButton";
import ItemCropThumbnail from "./ItemCropThumbnail";
import { cn } from "../lib/cn";

// Box colouring for the analysed-room overlay: an included item's box is
// solid brand green, an excluded item's box is dashed and muted, and the
// active (hovered / focused) box gets the ring. Tokens only, no raw
// palette classes.
function reorganiseBoxClassName(item, isActive, isQuiet, selectedSet) {
  const base = "absolute rounded-sm border-2 transition-none";
  const category = selectedSet.has(item.item_id)
    ? "border-primary bg-primary/10"
    : "border-dashed border-muted-foreground bg-muted-foreground/10";
  const state = isActive
    ? "z-20 border-4 ring-2 ring-ring ring-offset-1 opacity-100"
    : isQuiet
      ? "opacity-30"
      : "opacity-90";
  return `${base} ${category} ${state}`;
}

// Direct Reorganise's Select items screen. Every actionable detection
// starts included; the user may exclude false detections before moving
// to the separate Tidy plan screen. Identity is item_id throughout (the
// checkbox id, the React key, the overlay link and the only callback,
// onToggleItem(item_id)); nothing technical is rendered: no raw id, no
// confidence, no status. Position / size appear only where they help
// tell apart items that share a label. Selection never calls an API and
// contextual items are never selectable. Layout and long-list navigation
// match the Declutter review workspace: preview first on mobile, sticky
// preview beside the list from lg.
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

  // Counts come from actionable items only; contextual items are never
  // part of the plan and never counted.
  const detectedCount = actionableItems.length;
  const includedCount = actionableItems.filter((item) => selectedSet.has(item.item_id)).length;
  const excludedCount = detectedCount - includedCount;

  // Position / size are shown only for labels that appear more than once
  // among the actionable items, where they genuinely disambiguate.
  const labelCounts = new Map();
  for (const item of actionableItems) {
    labelCounts.set(item.effective_label, (labelCounts.get(item.effective_label) ?? 0) + 1);
  }

  return (
    <div ref={workspaceRef} tabIndex={-1} className="space-y-6 scroll-mt-4 focus:outline-none">
      {enableBackToTop && <span ref={topSentinelRef} aria-hidden="true" className="block h-px w-full" />}

      <header>
        <h2 className="text-title font-semibold tracking-tight text-foreground">Choose items for your tidy plan</h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          These are the objects ClearSpace will use to build your tidy plan. Remove anything detected incorrectly or
          anything you do not want included.
        </p>

        <dl aria-label="Selection summary" className="mt-3 flex flex-wrap gap-2 text-sm">
          <div className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1 text-foreground">
            <ScanSearch aria-hidden="true" width={14} height={14} className="shrink-0 text-muted-foreground" />
            <dt className="sr-only">Detected</dt>
            <dd>
              <span className="font-semibold tabular-nums">{detectedCount}</span> detected
            </dd>
          </div>
          <div className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-primary/50 bg-surface px-3 py-1 text-foreground">
            <Check aria-hidden="true" width={14} height={14} className="shrink-0 text-primary" />
            <dt className="sr-only">Included</dt>
            <dd>
              <span className="font-semibold tabular-nums">{includedCount}</span> included
            </dd>
          </div>
          <div className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border bg-surface-muted px-3 py-1 text-foreground">
            <CircleOff aria-hidden="true" width={14} height={14} className="shrink-0 text-muted-foreground" />
            <dt className="sr-only">Excluded</dt>
            <dd>
              <span className="font-semibold tabular-nums">{excludedCount}</span> excluded
            </dd>
          </div>
        </dl>

        {detectedCount > 0 && includedCount === 0 && (
          <p role="status" className="mt-3 flex items-start gap-2 text-sm font-medium text-warning-foreground">
            <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0 text-warning" />
            <span>Include at least one item to continue to your tidy plan.</span>
          </p>
        )}
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
          <section aria-labelledby="reorganise-selectable-heading">
            <h3 id="reorganise-selectable-heading" className="mb-2 text-sm font-semibold text-foreground">
              Detected items
            </h3>
            {actionableItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No actionable items were detected.</p>
            ) : (
              <ul className="space-y-2">
                {actionableItems.map((item) => {
                  const isSelected = selectedSet.has(item.item_id);
                  const isActive = item.item_id === activeItemId;
                  const inputId = `reorganise-item-${item.item_id}`;
                  const showWhere = (labelCounts.get(item.effective_label) ?? 0) > 1;
                  const whereBits = [item.position, item.relative_size].filter(
                    (v) => typeof v === "string" && v !== ""
                  );
                  return (
                    <li
                      key={item.item_id}
                      ref={(el) => registerItemRef(item.item_id, el)}
                      tabIndex={-1}
                      aria-current={isActive ? "true" : undefined}
                      data-selected={isSelected ? "true" : "false"}
                      onMouseEnter={() => activate(item.item_id)}
                      onMouseLeave={() => deactivate(item.item_id)}
                      onFocus={() => activate(item.item_id)}
                      onBlur={() => deactivate(item.item_id)}
                      className={cn(
                        "rounded-card border transition-colors",
                        isSelected ? "border-primary/60 bg-surface" : "border-border bg-surface-muted/60",
                        isActive && "border-primary ring-1 ring-primary"
                      )}
                    >
                      {/* The whole card is the label of its native checkbox,
                          so the entire row is the touch target while the
                          checkbox keeps real keyboard and screen-reader
                          semantics. */}
                      <label
                        htmlFor={inputId}
                        className={cn(
                          "flex min-h-14 items-center gap-3 p-3",
                          selectionDisabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"
                        )}
                      >
                        <ItemCropThumbnail
                          imageUrl={imageUrl}
                          box={item.box}
                          className={cn(!isSelected && "opacity-70 grayscale")}
                        />

                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-foreground">
                            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                              {itemNumberLabel(item.item_id)}
                            </span>
                            <span className="min-w-0 break-words">{item.effective_label}</span>
                          </span>
                          {showWhere && whereBits.length > 0 && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">{whereBits.join(", ")}</span>
                          )}
                        </span>

                        <span className="flex shrink-0 items-center gap-2">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-xs font-medium",
                              isSelected
                                ? "border-primary/40 bg-accent text-accent-foreground"
                                : "border-border bg-surface text-muted-foreground"
                            )}
                          >
                            {isSelected ? (
                              <Check aria-hidden="true" width={12} height={12} />
                            ) : (
                              <CircleOff aria-hidden="true" width={12} height={12} />
                            )}
                            {isSelected ? "Included" : "Excluded"}
                          </span>
                          <input
                            type="checkbox"
                            id={inputId}
                            checked={isSelected}
                            disabled={selectionDisabled}
                            onChange={() => onToggleItem(item.item_id)}
                            className="h-5 w-5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          />
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {contextualItems.length > 0 && (
            <section
              aria-labelledby="reorganise-contextual-heading"
              className="rounded-card border border-border bg-surface-muted p-3"
            >
              <h3 id="reorganise-contextual-heading" className="text-sm font-semibold text-muted-foreground">
                Contextual items ({contextualItems.length})
              </h3>
              <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
                Shown for context and not included in the plan.
              </p>
              <ul className="flex flex-wrap gap-1.5">
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
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-pill border bg-surface px-2.5 py-1 text-xs text-muted-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      item.item_id === activeItemId ? "border-primary ring-1 ring-primary" : "border-border"
                    )}
                  >
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">
                      {itemNumberLabel(item.item_id)}
                    </span>
                    {item.effective_label}
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
