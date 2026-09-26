import { useState } from "react";
import { Maximize2 } from "lucide-react";
import { decisionBorderColor, itemNumberLabel } from "../utils/format";
import ImageLightbox from "./ImageLightbox";

// Percentage overlays stay aligned through responsive image scaling. Boxes
// use item_id identity, never labels. Hosts own selection and row focus;
// Direct Reorganise supplies a classifier for its different item shape.
function declutterBoxClassName(item, isActive, isQuiet) {
  const base = "absolute rounded-sm border-2 transition-none";
  const category = item.is_unresolved
    ? "border-dashed border-error bg-error/10"
    : !item.is_expected
      ? "border-dotted border-muted-foreground bg-muted-foreground/10"
      : `${decisionBorderColor(item.review_decision ?? item.ai_decision)} bg-surface/10`;

  const state = isActive
    ? "z-20 border-4 ring-2 ring-ring ring-offset-1 opacity-100"
    : isQuiet
      ? "opacity-30"
      : "opacity-90";

  return `${base} ${category} ${state}`;
}

export default function AnalysedRoomPanel({
  imageUrl,
  items,
  activeItemId,
  onBoxClick,
  showAllBoxes,
  onToggleShowAllBoxes,
  getBoxClassName = declutterBoxClassName,
}) {
  const visibleItems = showAllBoxes ? items : items.filter((item) => item.item_id === activeItemId);
  // Enlarging the photo does not change the active item.
  const [lightboxOpen, setLightboxOpen] = useState(false);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Analysed space</h3>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showAllBoxes}
            onChange={(event) => onToggleShowAllBoxes(event.target.checked)}
            className="h-3.5 w-3.5 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          Show all boxes
        </label>
      </div>

      {imageUrl ? (
        <div className="relative overflow-hidden rounded-card border border-border bg-surface-muted">
          <img
            src={imageUrl}
            alt="The space photo you uploaded, with detected item outlines overlaid"
            className="block h-auto w-full"
          />
          {visibleItems.map((item) => {
            const isActive = item.item_id === activeItemId;
            const isQuiet = showAllBoxes && activeItemId != null && !isActive;
            return (
              <button
                key={item.item_id}
                type="button"
                onClick={() => onBoxClick(item.item_id)}
                aria-label={`Detection ${itemNumberLabel(item.item_id)}: ${item.display_label ?? item.effective_label ?? item.clean_label}`}
                aria-current={isActive ? "true" : undefined}
                className={getBoxClassName(item, isActive, isQuiet)}
                style={{
                  left: `${item.box.x1 * 100}%`,
                  top: `${item.box.y1 * 100}%`,
                  width: `${(item.box.x2 - item.box.x1) * 100}%`,
                  height: `${(item.box.y2 - item.box.y1) * 100}%`,
                }}
              >
                <span className="absolute -left-0.5 -top-0.5 rounded bg-foreground px-1 text-[10px] font-semibold leading-tight text-background">
                  {itemNumberLabel(item.item_id)}
                </span>
              </button>
            );
          })}
          {/* The expand control sits on the image itself, top-right,
              above every outline (z-30 over the active box's z-20). A
              plain button, not the Button primitive: the review
              workspaces assert that nothing inside them carries a
              no-wrap or overflow class, and the primitive's base
              includes whitespace-nowrap. Placed after the boxes in DOM
              order so the tab sequence stays boxes then expand. */}
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="absolute right-2 top-2 z-30 inline-flex items-center gap-1.5 rounded-control border border-border bg-surface/90 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-card backdrop-blur transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Maximize2 aria-hidden="true" width={14} height={14} />
            Expand image
          </button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Image preview unavailable.</p>
      )}

      {imageUrl ? (
        <div>
          {/* The enlarged view carries the same outlines as the panel,
              drawn from the same normalised boxes and box classes, and
              starts from the panel's own Show all boxes setting. */}
          <ImageLightbox
            open={lightboxOpen}
            onClose={() => setLightboxOpen(false)}
            src={imageUrl}
            alt="The space photo you uploaded"
            title="Analysed space"
            description="Zoom in to inspect items. Use Show boxes to show or hide the detected item outlines."
            overlays={items.map((item) => ({
              id: item.item_id,
              box: item.box,
              label: itemNumberLabel(item.item_id),
              className: getBoxClassName(item, item.item_id === activeItemId, false),
            }))}
            initialShowOverlays={showAllBoxes}
          />
        </div>
      ) : null}

      <p className="mt-2 text-xs text-muted-foreground">
        AI detection may miss or misidentify belongings. Review the highlighted image before confirming.
      </p>
    </div>
  );
}
