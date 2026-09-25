import { LISTING_CONDITIONS, LISTING_NAME_MAX } from "../lib/listingDrafts";
import { cn } from "../lib/cn";

// The two seller-supplied listing details for ONE item: a listing name
// (pre-filled from the reviewed label) and a declared condition (defaults
// to "Not specified"). Shared by the pre-generation list in ListingsView
// and by every ListingDraftCard, so the same controls and labels appear
// before the first draft and beside a generated one.
//
// Listing metadata only. onChange forwards { listing_name } or
// { condition } for this item_id to the hook's setListingDetails; nothing
// here touches the detected label, the decision, the confirmation or any
// draft text. Condition is never inferred from the image: the person
// picks it, or it stays "Not specified" and the model is told to say
// nothing about it. There is no price field by design.
export default function ListingDetailsFields({
  itemId,
  itemLabel,
  details,
  onChange,
  disabled = false,
  compact = false,
  className,
}) {
  const nameId = `listing-name-${itemId}`;
  const conditionId = `listing-condition-${itemId}`;
  const nameLength = (details?.listing_name ?? "").length;

  // Both columns use the SAME header row and the SAME control height, so on
  // desktop the two labels share a top line and the input and select line
  // up. The row has explicit line heights (the 11px counter would otherwise
  // inherit the taller body line box and push its column down) and a fixed
  // minimum height, whether or not it holds a counter. Below sm the grid is
  // one column, so the fields still stack.
  const headerClass = "flex min-h-5 items-end justify-between gap-2";
  const labelClass = "text-xs font-medium leading-4 text-foreground";
  const controlClass =
    "mt-1 block h-9 w-full rounded-control border border-input bg-surface px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-60";

  return (
    <div
      className={cn(
        "grid gap-3 sm:items-start",
        compact ? "sm:grid-cols-2" : "sm:grid-cols-[minmax(0,1fr)_12rem]",
        className
      )}
    >
      <div>
        <div data-testid="listing-field-header" className={headerClass}>
          <label htmlFor={nameId} className={labelClass}>
            Listing name for {itemLabel}
          </label>
          <span
            className={cn(
              "shrink-0 text-[11px] leading-4 tabular-nums",
              nameLength > LISTING_NAME_MAX ? "text-error" : "text-muted-foreground"
            )}
          >
            {nameLength}/{LISTING_NAME_MAX}
          </span>
        </div>
        <input
          id={nameId}
          type="text"
          value={details?.listing_name ?? ""}
          onChange={(event) => onChange(itemId, { listing_name: event.target.value })}
          disabled={disabled}
          maxLength={LISTING_NAME_MAX}
          placeholder={itemLabel}
          className={controlClass}
        />
      </div>
      <div>
        <div data-testid="listing-field-header" className={headerClass}>
          <label htmlFor={conditionId} className={labelClass}>
            Condition for {itemLabel}
          </label>
        </div>
        <select
          id={conditionId}
          value={details?.condition ?? LISTING_CONDITIONS[0].value}
          onChange={(event) => onChange(itemId, { condition: event.target.value })}
          disabled={disabled}
          className={controlClass}
        >
          {LISTING_CONDITIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
