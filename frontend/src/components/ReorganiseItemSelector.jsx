import { useRef, useState } from "react";
import { formatConfidence, itemNumberLabel } from "../utils/format";
import AnalysedRoomPanel from "./AnalysedRoomPanel";

// Direct Reorganise's post-analysis screen, analogous to DeclutterReview
// in file role only, genuinely different in UX: this is NOT a "choose
// what to keep" step. useReorganiseFlow.submit() already auto-selects
// every actionable item, so Generate is available immediately after
// analysis with no required interaction here. Reviewing/excluding
// individual detections is an OPTIONAL correction, tucked behind a
// collapsed-by-default <details> disclosure, not a second Declutter-
// style mandatory decision screen. Selection itself is still a plain
// boolean (selected/not), keyed only by item_id, duplicate labels
// render as fully independent rows/boxes, exactly like Declutter's own
// established precedent.
//
// Reuses AnalysedRoomPanel via its generalised getBoxClassName prop
// (R5) rather than duplicating the box-geometry/list-linking logic.
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

export default function ReorganiseItemSelector({
  items,
  selectedItemIds,
  onToggleItem,
  imageUrl,
  phase,
  onGenerate,
  generateError,
  healthStatus,
}) {
  const isGenerating = phase === "generating";
  const selectedSet = new Set(selectedItemIds);

  const [activeItemId, setActiveItemId] = useState(null);
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
    setActiveItemId((current) => (current === itemId ? null : current));
  }

  function focusItem(itemId) {
    const el = itemRefs.current.get(itemId);
    if (!el) return;
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
    el.focus();
  }

  const actionableItems = items.filter((item) => item.item_role === "actionable");
  const contextualItems = items.filter((item) => item.item_role !== "actionable");

  const generateDisabled = selectedItemIds.length === 0 || isGenerating;

  return (
    <div className="mt-6 space-y-6">
      <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-lg font-medium text-stone-900">2. Generate room plan</h2>
        <p className="mb-4 text-sm text-stone-600">
          All {actionableItems.length} detected item{actionableItems.length === 1 ? "" : "s"} are automatically
          included in your plan and requested in the visual preview, the generated image is an AI impression, not
          a guarantee every object appears exactly as shown.
        </p>

        {healthStatus === "unavailable" && (
          // Deliberately distinct wording from ImageGenStatusBanner's own
          // message (mounted once, above this screen, in ReorganisePage)
          // this is a short, button-adjacent reminder, not a repeat of
          // the same sentence twice on one page.
          <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
            Note: the image service is offline right now, so this run will produce a plan without a visual preview.
          </p>
        )}

        <button
          type="button"
          onClick={onGenerate}
          disabled={generateDisabled}
          className="rounded-md bg-green-800 px-4 py-2 text-sm font-medium text-white hover:bg-green-900 disabled:cursor-not-allowed disabled:bg-stone-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
        >
          {isGenerating ? "Generating…" : "Generate room plan"}
        </button>

        {isGenerating && (
          <p role="status" className="mt-3 flex items-center gap-2 text-sm text-stone-600">
            <span aria-hidden="true" className="h-3 w-3 animate-pulse rounded-full bg-green-700" />
            Creating your room plan and visual preview. This may take several minutes.
          </p>
        )}

        {selectedItemIds.length === 0 && !isGenerating && (
          <p className="mt-2 text-xs text-stone-500">
            At least one detected item must be included to generate a plan. Reopen the review below to include one.
          </p>
        )}

        {generateError && (
          <p role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            {generateError} Your selection is unchanged. You can try again.
          </p>
        )}

        <details className="mt-5 rounded-md border border-stone-200 bg-stone-50">
          <summary className="cursor-pointer select-none rounded-md px-4 py-3 text-sm font-medium text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700">
            Review detected items (optional)
          </summary>

          <div className="border-t border-stone-200 p-4">
            <p className="mb-4 text-sm text-stone-600">
              Exclude anything detected incorrectly, or a fixture that shouldn't be part of the plan.
            </p>

            <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
              <div className="lg:sticky lg:top-4 lg:w-[42%] lg:flex-shrink-0">
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

              <div className="min-w-0 flex-1">
                {actionableItems.length === 0 ? (
                  <p className="text-sm text-stone-500">No actionable items were detected.</p>
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
                          onMouseEnter={() => activateItem(item.item_id)}
                          onMouseLeave={() => deactivateItem(item.item_id)}
                          onFocus={() => activateItem(item.item_id)}
                          onBlur={() => deactivateItem(item.item_id)}
                          className={`flex items-start gap-3 rounded-lg border bg-white p-3 shadow-sm ${isActive ? "border-stone-900 ring-1 ring-stone-900" : "border-stone-200"}`}
                        >
                          <input
                            type="checkbox"
                            id={`reorganise-item-${item.item_id}`}
                            checked={isSelected}
                            disabled={isGenerating}
                            onChange={() => onToggleItem(item.item_id)}
                            className="mt-1 h-4 w-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
                          />
                          <label htmlFor={`reorganise-item-${item.item_id}`} className="min-w-0 flex-1 cursor-pointer">
                            <p className="font-medium text-stone-900">
                              <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-stone-800 text-[11px] font-semibold text-white">
                                {itemNumberLabel(item.item_id)}
                              </span>
                              {item.effective_label}
                              <span
                                className={`ml-2 rounded-full border px-2 py-0.5 text-xs font-medium ${
                                  isSelected
                                    ? "border-green-300 bg-green-50 text-green-800"
                                    : "border-stone-300 bg-stone-100 text-stone-600"
                                }`}
                              >
                                {isSelected ? "Included in plan" : "Exclude from plan"}
                              </span>
                            </p>
                            <p className="text-xs text-stone-500">
                              item_id: <code>{item.item_id}</code> · {item.position}, {item.relative_size} ·{" "}
                              {formatConfidence(item.confidence)} detection confidence
                            </p>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {contextualItems.length > 0 && (
                  <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-3">
                    <h3 className="mb-1 text-sm font-medium text-stone-700">
                      Contextual items ({contextualItems.length})
                    </h3>
                    <p className="mb-2 text-xs text-stone-500">
                      Detected as room context, not part of the plan.
                    </p>
                    <ul className="space-y-1">
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
                          className="rounded-md border border-stone-200 bg-white p-2 text-xs text-stone-600"
                        >
                          {item.effective_label} <code>{item.item_id}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}
