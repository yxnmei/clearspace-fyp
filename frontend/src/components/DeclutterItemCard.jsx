import { useState } from "react";
import { Check, Pencil } from "lucide-react";
import { itemNumberLabel } from "../utils/format";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import ItemCropThumbnail from "./ItemCropThumbnail";
import DecisionControl, { DECISION_OPTIONS_BY_VALUE } from "./DecisionControl";
import { cn } from "../lib/cn";

// Shared label-correction form for resolved and unresolved items. It calls
// onCorrectLabel only; request state remains in the flow hook.
export function LabelCorrectionControl({ item, isCorrecting, correctionDisabled, correctionError, onCorrectLabel }) {
  const [isOpen, setIsOpen] = useState(false);
  const [labelInput, setLabelInput] = useState("");

  function handleOpen() {
    // Pre-fill the displayed name; submission still targets this item_id.
    setLabelInput(item.display_label ?? item.effective_label ?? item.clean_label);
    setIsOpen(true);
  }

  // Derive applied/update state from the item returned by the hook.
  const trimmed = labelInput.trim();
  const appliedByUser = item.label_source === "user";
  const isApplied = appliedByUser && trimmed !== "" && trimmed === (item.effective_label ?? "").trim();
  const submitText = isCorrecting
    ? "Correcting…"
    : isApplied
      ? "Correction applied"
      : appliedByUser
        ? "Update correction"
        : "Submit correction";

  function handleSubmit(event) {
    event.preventDefault();
    if (!trimmed || isApplied) return;
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
        <Button type="submit" variant="primary" size="sm" disabled={isCorrecting || trimmed === "" || isApplied}>
          {isApplied && <Check aria-hidden="true" width={12} height={12} />}
          {submitText}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setIsOpen(false)} disabled={isCorrecting}>
          Cancel
        </Button>
      </div>
      {isCorrecting && (
        <p role="status" className="sr-only">
          Correcting label for {item.display_label ?? item.effective_label ?? item.clean_label}…
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

// Resolved item row linked to its overlay. item_id keys every callback and
// link, so duplicate labels remain independent.
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
  // Show a listing rename while retaining detector/reasoning provenance.
  const reasoningLabel = item.effective_label ?? item.clean_label;
  const displayLabel = item.display_label ?? reasoningLabel;
  const isRenamed = displayLabel !== reasoningLabel;
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
          {isRenamed && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Your listing name. Detected as {item.clean_label}
              {reasoningLabel !== item.clean_label ? `, corrected to ${reasoningLabel}` : ""}.
            </p>
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
