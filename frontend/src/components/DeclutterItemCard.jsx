import { useState } from "react";
import { decisionColor, formatConfidence, itemNumberLabel } from "../utils/format";

const DECISIONS = [
  { value: "keep", label: "Keep" },
  { value: "sell", label: "Sell" },
  { value: "donate", label: "Donate" },
  { value: "discard", label: "Discard" },
];

// Shared by DeclutterItemCard (resolved items) and DeclutterReview's
// unresolved-items list — a label correction is available for both (see
// each call site for why), so the form itself lives here once rather
// than being duplicated. Collapsed to a single "Wrong label?" toggle
// until opened, so it doesn't visually compete with the primary decision
// controls on every card by default.
//
// isCorrecting/correctionDisabled/correctionError are the UI's local
// reflection of useDeclutterFlow's correctingItemId/correctionError —
// this component never calls the API itself (onCorrectLabel is the only
// way out), matching every other control in this file.
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
    if (!trimmed) return; // blank labels are never submitted — button is also disabled below
    onCorrectLabel(item.item_id, trimmed);
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        disabled={correctionDisabled}
        className="text-xs font-medium text-stone-600 underline decoration-dotted hover:text-stone-900 disabled:cursor-not-allowed disabled:text-stone-300"
      >
        Wrong label? Correct it
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-1">
      <label htmlFor={`correct-label-${item.item_id}`} className="mb-1 block text-xs font-medium text-stone-700">
        Corrected label
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={`correct-label-${item.item_id}`}
          type="text"
          value={labelInput}
          onChange={(event) => setLabelInput(event.target.value)}
          disabled={isCorrecting}
          className="rounded-md border border-stone-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
        />
        <button
          type="submit"
          disabled={isCorrecting || labelInput.trim() === ""}
          className="rounded-md bg-stone-800 px-3 py-1 text-xs font-medium text-white hover:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300"
        >
          {isCorrecting ? "Correcting…" : "Submit correction"}
        </button>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          disabled={isCorrecting}
          className="text-xs text-stone-500 underline disabled:cursor-not-allowed disabled:text-stone-300"
        >
          Cancel
        </button>
      </div>
      {isCorrecting && (
        <p role="status" className="sr-only">
          Correcting label for {item.effective_label ?? item.clean_label}…
        </p>
      )}
      {correctionError && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {correctionError}
        </p>
      )}
    </form>
  );
}

// One card per resolved, expected item — decision controls call back to
// useDeclutterFlow's setDecisionOverride/setItemExcluded, keyed only by
// item.item_id (never clean_label — two items sharing a label render as
// two independent cards with independent state, purely by item_id).
//
// isActive/onActivate/onDeactivate/registerRef connect this card to its
// box in AnalysedRoomPanel (owned by the parent DeclutterReview, not this
// component): hovering or focusing the card marks it active, which is
// what makes the overlay highlight the matching box, and a box click
// scrolls/focuses back to this card via the ref registered here. All four
// are optional/no-op by default so this component still works completely
// standalone (e.g. in isolation in a test) without the overlay wired up —
// none of the card's own review functionality depends on them.
export default function DeclutterItemCard({
  item,
  onDecisionChange,
  onExcludedChange,
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
      className={`rounded-lg border bg-white p-4 shadow-sm ${isActive ? "border-stone-900 ring-1 ring-stone-900" : "border-stone-200"}`}
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-stone-900">
            <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-stone-800 text-[11px] font-semibold text-white">
              {itemNumberLabel(item.item_id)}
            </span>
            {displayLabel}
          </p>
          <p className="text-xs text-stone-500">
            item_id: <code>{item.item_id}</code> · {item.position}, {item.relative_size} ·{" "}
            {formatConfidence(item.confidence)} detection confidence
          </p>
        </div>
        <div className="flex gap-2">
          {item.label_source === "user" && (
            <span className="rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800">
              Corrected by you
            </span>
          )}
          {item.decision_changed && (
            <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
              Changed
            </span>
          )}
          {item.review_excluded && (
            <span className="rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700">
              Excluded
            </span>
          )}
        </div>
      </div>

      <p className="mb-3 text-sm text-stone-700">
        <span className={`font-medium ${decisionColor(item.ai_decision)}`}>AI suggests: {item.ai_decision}</span>
        {item.ai_reason && <span className="text-stone-500"> — {item.ai_reason}</span>}
        <span className="ml-2 text-xs text-stone-400">({item.item_validity})</span>
      </p>

      <fieldset className="mb-3">
        <legend className="mb-1 text-sm font-medium text-stone-700">Your decision</legend>
        <div className="flex flex-wrap gap-3">
          {DECISIONS.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-1.5 text-sm text-stone-700">
              <input
                type="radio"
                name={groupName}
                value={value}
                checked={item.review_decision === value}
                onChange={() => onDecisionChange(item.item_id, value)}
                className="h-4 w-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-stone-700">
        <input
          type="checkbox"
          checked={item.review_excluded}
          onChange={(event) => onExcludedChange(item.item_id, event.target.checked)}
          className="h-4 w-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
        />
        Exclude this item — it will not be sent for confirmation or reach later stages
      </label>

      <div className="mt-3 border-t border-stone-100 pt-3">
        <LabelCorrectionControl
          item={item}
          isCorrecting={isCorrecting}
          correctionDisabled={correctionDisabled}
          correctionError={correctionError}
          onCorrectLabel={onCorrectLabel}
        />
      </div>
    </li>
  );
}
