import { useState } from "react";
import { Pencil } from "lucide-react";
import { itemNumberLabel } from "../utils/format";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import ItemCropThumbnail from "./ItemCropThumbnail";
import DecisionControl, { DECISION_OPTIONS_BY_VALUE } from "./DecisionControl";
import { cn } from "../lib/cn";

// Shared by DeclutterItemCard (resolved items) and DeclutterReview's
// unresolved-items list, a label correction is available for both, so
// the form lives here once. Collapsed to a single "Wrong label?" toggle
// until opened, so it doesn't visually compete with the primary decision
// controls.
//
// isCorrecting/correctionDisabled/correctionError are the UI's local
// reflection of useDeclutterFlow's correctingItemId/correctionError,
// this component never calls the API itself (onCorrectLabel is the only
// way out).
export function LabelCorrectionControl({ item, isCorrecting, correctionDisabled, correctionError, onCorrectLabel }) {
  const [isOpen, setIsOpen] = useState(false);
  const [labelInput, setLabelInput] = useState("");

  function handleOpen() {
    setLabelInput(item.effective_label ?? item.clean_label);
    setIsOpen(true);
  }

  function handleSubmit(event) {
    event.preventDefault();
    const trimmed = labelInput.trim();
    if (!trimmed) return; // blank labels are never submitted, button is also disabled below
    onCorrectLabel(item.item_id, trimmed);
  }

  if (!isOpen) {
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        onClick={handleOpen}
        disabled={correctionDisabled}
        className="h-auto gap-1.5 p-0 text-xs underline decoration-dotted underline-offset-2 disabled:no-underline"
      >
        <Pencil aria-hidden="true" width={12} height={12} />
        Wrong label? Correct it
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-1 w-full">
      <label
        htmlFor={`correct-label-${item.item_id}`}
        className="mb-1 block text-xs font-medium text-foreground"
      >
        Corrected label
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={`correct-label-${item.item_id}`}
          type="text"
          value={labelInput}
          onChange={(event) => setLabelInput(event.target.value)}
          disabled={isCorrecting}
          className="rounded-control border border-input bg-surface px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60"
        />
        <Button type="submit" variant="primary" size="sm" disabled={isCorrecting || labelInput.trim() === ""}>
          {isCorrecting ? "Correcting…" : "Submit correction"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setIsOpen(false)} disabled={isCorrecting}>
          Cancel
        </Button>
      </div>
      {isCorrecting && (
        <p role="status" className="sr-only">
          Correcting label for {item.effective_label ?? item.clean_label}…
        </p>
      )}
      {correctionError && (
        <p role="alert" className="mt-1 text-xs font-medium text-error">
          {correctionError}
        </p>
      )}
    </form>
  );
}

// One compact row per resolved, expected item: thumbnail, number badge,
// the effective label with its status badges, a short position / size
// line, the segmented decision control, then a secondary line with the
// AI suggestion and reason, the exclusion checkbox and the collapsed
// label correction. Raw item_id, detection confidence and item_validity
// are deliberately NOT rendered; item_id stays the row's identity for
// the key, every callback and the overlay link.
//
// Decision controls call back to useDeclutterFlow's setDecisionOverride/
// setItemExcluded, keyed only by item.item_id (never clean_label, two
// items sharing a label render as two independent rows with independent
// state, purely by item_id).
//
// isActive/onActivate/onDeactivate/registerRef link this row to its box
// in AnalysedRoomPanel (owned by the parent, not this component):
// hovering/focusing the row marks it active, which highlights the
// matching box, and a box click scrolls/focuses back here via the
// registered ref. All four are optional/no-op by default so the row
// still works standalone in a test without the overlay wired up.
//
// imageUrl is the single analysed-room source image; ItemCropThumbnail
// derives a small decorative crop from it and the item's normalized box.
// No per-item image or object URL is created.
export default function DeclutterItemCard({
  item,
  onDecisionChange,
  onExcludedChange,
  imageUrl = null,
  isActive = false,
  onActivate = () => {},
  onDeactivate = () => {},
  registerRef = () => {},
  onCorrectLabel = () => {},
  isCorrecting = false,
  correctionDisabled = false,
  correctionError = null,
}) {
  const displayLabel = item.effective_label ?? item.clean_label;
  const suggestion = item.ai_decision ? DECISION_OPTIONS_BY_VALUE[item.ai_decision] ?? null : null;
  const whereBits = [item.position, item.relative_size].filter((v) => typeof v === "string" && v !== "");

  return (
    <li
      ref={(el) => registerRef(item.item_id, el)}
      tabIndex={-1}
      aria-current={isActive ? "true" : undefined}
      onMouseEnter={onActivate}
      onMouseLeave={onDeactivate}
      onFocus={onActivate}
      onBlur={onDeactivate}
      className={cn(
        "rounded-card border bg-surface p-3 transition-colors",
        isActive ? "border-primary ring-1 ring-primary" : "border-border"
      )}
    >
      {/* One CSS grid, two placements. Below md: row 1 = thumbnail | item
          info, row 2 = the decision control spanning BOTH columns (the full
          card width, so four options fit without clipping), row 3 = the
          secondary lines. From md: thumbnail | info | control on row 1,
          secondary lines under the info on row 2. One control instance,
          moved by grid placement only. */}
      <div
        data-testid="item-card-grid"
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 md:grid-cols-[auto_minmax(0,1fr)_auto] md:gap-x-4"
      >
        <ItemCropThumbnail imageUrl={imageUrl} box={item.box} className="col-start-1 row-start-1 mt-0.5" />

        <div className="col-start-2 row-start-1 min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-foreground">
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              {itemNumberLabel(item.item_id)}
            </span>
            <span className="min-w-0 break-words">{displayLabel}</span>
            {item.label_source === "user" && <Badge variant="primary">Corrected by you</Badge>}
            {item.decision_changed && <Badge variant="warning">Changed</Badge>}
            {item.review_excluded && <Badge variant="outline">Excluded</Badge>}
          </p>
          {whereBits.length > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">{whereBits.join(", ")}</p>
          )}
        </div>

        <DecisionControl
          itemId={item.item_id}
          itemLabel={displayLabel}
          value={item.review_decision}
          onChange={onDecisionChange}
          className="col-span-2 col-start-1 row-start-2 md:col-span-1 md:col-start-3 md:row-start-1 md:justify-self-end"
        />

        <div className="col-span-2 col-start-1 row-start-3 min-w-0 md:col-start-2 md:row-start-2">
          <p className="text-xs text-muted-foreground">
            <span className={cn("inline-flex items-center gap-1 font-medium", suggestion ? suggestion.text : "text-foreground")}>
              {suggestion && <suggestion.Icon aria-hidden="true" width={12} height={12} />}
              AI suggests: {suggestion ? suggestion.label : item.ai_decision}
            </span>
            {item.ai_reason && <span>, {item.ai_reason}</span>}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={item.review_excluded}
                onChange={(event) => onExcludedChange(item.item_id, event.target.checked)}
                className="h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              Exclude this item from later steps
            </label>

            <LabelCorrectionControl
              item={item}
              isCorrecting={isCorrecting}
              correctionDisabled={correctionDisabled}
              correctionError={correctionError}
              onCorrectLabel={onCorrectLabel}
            />
          </div>
        </div>
      </div>
    </li>
  );
}
