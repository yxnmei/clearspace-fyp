import { useState } from "react";
import { Pencil } from "lucide-react";
import { decisionColor, formatConfidence, itemNumberLabel } from "../utils/format";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import ItemCropThumbnail from "./ItemCropThumbnail";
import { cn } from "../lib/cn";

const DECISIONS = [
  { value: "keep", label: "Keep" },
  { value: "sell", label: "Sell" },
  { value: "donate", label: "Donate" },
  { value: "discard", label: "Discard" },
];

// Keep / Sell / Donate / Discard reuse the green / blue / amber / red
// category mapping already used by the detection-overlay boxes
// (decisionColor / decisionBorderColor). Colour is only a secondary cue,
// every control keeps its visible text label and its native checked
// radio. Class strings are written out in full so Tailwind's scanner
// keeps them; nothing here is built by interpolation.
const DECISION_STYLES = {
  keep: {
    unselected: "border-green-200 text-green-800 hover:bg-green-50",
    selected: "border-green-600 bg-green-50 text-green-900",
    accent: "accent-green-600",
  },
  sell: {
    unselected: "border-blue-200 text-blue-800 hover:bg-blue-50",
    selected: "border-blue-600 bg-blue-50 text-blue-900",
    accent: "accent-blue-600",
  },
  donate: {
    unselected: "border-amber-200 text-amber-800 hover:bg-amber-50",
    selected: "border-amber-600 bg-amber-50 text-amber-900",
    accent: "accent-amber-600",
  },
  discard: {
    unselected: "border-red-200 text-red-800 hover:bg-red-50",
    selected: "border-red-600 bg-red-50 text-red-900",
    accent: "accent-red-600",
  },
};

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

// One compact row per resolved, expected item. Decision controls call
// back to useDeclutterFlow's setDecisionOverride/setItemExcluded, keyed
// only by item.item_id (never clean_label, two items sharing a label
// render as two independent rows with independent state, purely by
// item_id).
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
  const groupName = `decision-${item.item_id}`;
  const displayLabel = item.effective_label ?? item.clean_label;

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
        "rounded-card border bg-surface p-3 shadow-card transition-colors",
        isActive ? "border-primary ring-1 ring-primary" : "border-border"
      )}
    >
      <div className="flex gap-3">
        <ItemCropThumbnail imageUrl={imageUrl} box={item.box} className="mt-0.5" />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
            <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                {itemNumberLabel(item.item_id)}
              </span>
              {displayLabel}
            </p>
            <div className="flex flex-wrap gap-1">
              {item.label_source === "user" && <Badge variant="primary">Corrected by you</Badge>}
              {item.decision_changed && <Badge variant="warning">Changed</Badge>}
              {item.review_excluded && <Badge variant="outline">Excluded</Badge>}
            </div>
          </div>

          <p className="mt-0.5 text-xs text-muted-foreground">
            item_id: <code>{item.item_id}</code> · {item.position}, {item.relative_size} ·{" "}
            {formatConfidence(item.confidence)} detection confidence
          </p>

          <p className="mt-1 text-xs">
            <span className={cn("font-medium", decisionColor(item.ai_decision))}>
              AI suggests: {item.ai_decision}
            </span>
            {item.ai_reason && <span className="text-muted-foreground">, {item.ai_reason}</span>}
            <span className="ml-1.5 text-[11px] text-muted-foreground/70">({item.item_validity})</span>
          </p>

          <fieldset className="mt-2">
            <legend className="mb-1 text-xs font-medium text-foreground">Your decision</legend>
            <div className="flex flex-wrap gap-1.5">
              {DECISIONS.map(({ value, label }) => {
                const selected = item.review_decision === value;
                const style = DECISION_STYLES[value];
                return (
                  <label
                    key={value}
                    className={cn(
                      "flex cursor-pointer items-center gap-1.5 rounded-control border px-2.5 py-1 text-sm font-medium transition-colors",
                      selected ? style.selected : style.unselected
                    )}
                  >
                    <input
                      type="radio"
                      name={groupName}
                      value={value}
                      checked={selected}
                      onChange={() => onDecisionChange(item.item_id, value)}
                      className={cn(
                        "h-3.5 w-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                        style.accent
                      )}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={item.review_excluded}
                onChange={(event) => onExcludedChange(item.item_id, event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              Exclude this item, it will not be sent for confirmation or reach later stages
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
