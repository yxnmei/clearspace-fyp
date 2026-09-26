import { Loader2, PackageX, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import ListingDraftCard from "./ListingDraftCard";
import ListingDetailsFields from "./ListingDetailsFields";
import ItemCropThumbnail from "./ItemCropThumbnail";
import { deriveEligibleSellItemIds, resolveListingDetails } from "../lib/listingDrafts";

// Shared presentational listing surface. Eligibility comes only from confirmed,
// non-excluded Sell decisions in confirmation order. Generation is explicit.

const HEADING_ID = "listings-view-heading";

// Stable component identity prevents editor remounts on each keystroke.
function Frame({ children }) {
  return (
    <section
      aria-labelledby={HEADING_ID}
      className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-6"
    >
      <h2 id={HEADING_ID} className="text-lg font-semibold text-foreground">
        Marketplace listings
      </h2>
      {children}
    </section>
  );
}

export default function ListingsView({
  confirmation = null,
  reviewItems = [],
  imageUrl = null,
  listingStatus = "idle",
  listingDrafts = [],
  listingError = null,
  regeneratingItemId = null,
  regenerationError = null,
  generateListingDrafts = () => {},
  regenerateListingDraft = () => {},
  editListingDraft = () => {},
  discardListingDraft = () => {},
  restoreListingDraft = () => {},
  listingDetailsById = {},
  setListingDetails = () => {},
  missingListingItemIds = [],
  clipboardWriter,
}) {
  if (!confirmation) {
    return (
      <Frame>
        <p className="mt-2 text-sm text-muted-foreground">
          Confirm your Declutter decisions first. Once decisions are confirmed, you can generate
          editable listing drafts for the items you chose to sell.
        </p>
      </Frame>
    );
  }

  const eligibleItemIds = deriveEligibleSellItemIds(confirmation);

  if (eligibleItemIds.length === 0) {
    return (
      <Frame>
        <div className="mt-3 flex items-start gap-3 rounded-control border border-border bg-surface-muted p-3">
          <PackageX aria-hidden="true" width={18} height={18} className="mt-0.5 shrink-0 text-muted-foreground" />
          <div className="text-sm">
            <p className="font-medium text-foreground">
              You did not confirm any items as Sell, so there are no listing drafts to generate.
            </p>
            <p className="mt-1 text-muted-foreground">
              If you want listing drafts, go back to Decide items and change an item's decision to Sell, then
              confirm again.
            </p>
          </div>
        </div>
      </Frame>
    );
  }

  const reviewItemsById = new Map(reviewItems.map((item) => [item.item_id, item]));
  const displayLabelFor = (itemId) => {
    const item = reviewItemsById.get(itemId);
    return item?.display_label ?? item?.effective_label ?? item?.clean_label ?? itemId;
  };

  // Field labels use the stable reasoning label while listing names change.
  function renderDetailsList(itemIds, ariaLabel, pendingItemId = null) {
    return (
      <ul className="mt-4 space-y-3" aria-label={ariaLabel}>
        {itemIds.map((itemId) => {
          const reviewItem = reviewItemsById.get(itemId) ?? null;
          const fieldLabel = reviewItem?.effective_label ?? reviewItem?.clean_label ?? itemId;
          return (
            <li key={itemId} className="rounded-control border border-border bg-surface-muted p-3">
              <div className="flex items-center gap-3">
                <ItemCropThumbnail imageUrl={imageUrl} box={reviewItem?.box} className="h-12 w-12" />
                <p className="min-w-0 truncate text-sm font-semibold text-foreground">{displayLabelFor(itemId)}</p>
              </div>
              <ListingDetailsFields
                itemId={itemId}
                itemLabel={fieldLabel}
                details={resolveListingDetails(itemId, listingDetailsById, reviewItem)}
                onChange={setListingDetails}
                disabled={pendingItemId === itemId}
                className="mt-3"
              />
              {pendingItemId === itemId && (
                <p role="status" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 aria-hidden="true" width={14} height={14} className="animate-spin text-primary" />
                  Writing a draft for {displayLabelFor(itemId)}…
                </p>
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  const eligibleCount = eligibleItemIds.length;
  const eligibleCountLabel = `${eligibleCount} item${eligibleCount === 1 ? "" : "s"}`;
  const listingBusy = listingStatus === "generating" || regeneratingItemId !== null;

  if (listingStatus === "idle") {
    return (
      <Frame>
        <p className="mt-2 text-sm text-foreground">
          You confirmed {eligibleCountLabel} to sell. Generate a draft title and description for each one.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Drafts are editable suggestions. Nothing is published, listed, or sent to any marketplace.
        </p>
        {renderDetailsList(eligibleItemIds, "Items to list")}
        <p className="mt-2 text-xs text-muted-foreground">
          Leave the condition as Not specified if you are unsure; the draft will not guess it.
        </p>
        <Button
          type="button"
          className="mt-4 min-h-11 w-full sm:min-h-0 sm:w-auto"
          onClick={() => generateListingDrafts()}
        >
          <Sparkles aria-hidden="true" width={16} height={16} />
          Generate listing drafts
        </Button>
      </Frame>
    );
  }

  if (listingStatus === "generating") {
    return (
      <Frame>
        <p className="mt-2 flex items-center gap-2 text-sm text-foreground" role="status" aria-live="polite">
          <Loader2 aria-hidden="true" width={16} height={16} className="shrink-0 animate-spin text-primary" />
          Generating listing drafts for {eligibleCountLabel}…
        </p>
        <p className="mt-1 text-sm text-muted-foreground">Nothing is being published.</p>
        <Button
          type="button"
          className="mt-4 min-h-11 w-full sm:min-h-0 sm:w-auto"
          disabled
          aria-busy="true"
          onClick={() => generateListingDrafts()}
        >
          Generating…
        </Button>
      </Frame>
    );
  }

  if (listingStatus === "error") {
    return (
      <Frame>
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-control border border-error/30 bg-error/10 p-3 text-sm text-error"
        >
          <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0" />
          <span>
            {listingError || "Listing draft generation failed."} Your confirmed Declutter decisions
            are unchanged.
          </span>
        </p>
        <Button
          type="button"
          className="mt-4 min-h-11 w-full sm:min-h-0 sm:w-auto"
          onClick={() => generateListingDrafts()}
        >
          <Sparkles aria-hidden="true" width={16} height={16} />
          Try again
        </Button>
      </Frame>
    );
  }

  if (listingDrafts.length === 0) {
    // Keep a recovery action if an eligible ready state has no drafts.
    return (
      <Frame>
        <p className="mt-2 text-sm text-foreground">No listing drafts were returned.</p>
        <Button
          type="button"
          className="mt-4 min-h-11 w-full sm:min-h-0 sm:w-auto"
          onClick={() => generateListingDrafts()}
        >
          <Sparkles aria-hidden="true" width={16} height={16} />
          Generate listing drafts
        </Button>
      </Frame>
    );
  }

  const draftCount = listingDrafts.length;
  return (
    <Frame>
      <p className="mt-2 text-sm font-medium text-foreground">
        {draftCount} listing draft{draftCount === 1 ? "" : "s"} ready
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Edit any draft, then use Copy listing to paste it wherever you want. Edits stay on this device and
        nothing is published.
      </p>
      <ul className="mt-4 space-y-3">
        {listingDrafts.map((draft) => (
          <li key={draft.item_id}>
            <ListingDraftCard
              draft={draft}
              reviewItem={reviewItemsById.get(draft.item_id) ?? null}
              imageUrl={imageUrl}
              isRegenerating={regeneratingItemId === draft.item_id}
              regenerationErrorMessage={
                regenerationError && regenerationError.itemId === draft.item_id
                  ? regenerationError.message
                  : null
              }
              listingBusy={listingBusy}
              onEdit={editListingDraft}
              onRegenerate={regenerateListingDraft}
              onDiscard={discardListingDraft}
              onRestore={restoreListingDraft}
              onDetailsChange={setListingDetails}
              clipboardWriter={clipboardWriter}
            />
          </li>
        ))}
      </ul>

      {/* Generate only newly eligible items; preserve existing draft state. */}
      {missingListingItemIds.length > 0 && (
        <section
          aria-labelledby="listings-new-items-heading"
          className="mt-5 rounded-control border border-dashed border-primary/50 bg-accent/30 p-3 sm:p-4"
        >
          <h3 id="listings-new-items-heading" className="text-sm font-semibold text-foreground">
            New items to list ({missingListingItemIds.length})
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            You confirmed {missingListingItemIds.length === 1 ? "this item" : "these items"} as Sell after your other
            drafts were written. Drafts are written for these items only; your existing drafts stay as they are.
          </p>
          {renderDetailsList(
            missingListingItemIds,
            "New items to list",
            missingListingItemIds.includes(regeneratingItemId) ? regeneratingItemId : null
          )}
          {listingError && (
            <p
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-control border border-error/30 bg-error/10 p-3 text-sm text-error"
            >
              <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0" />
              <span>{listingError} Your existing drafts and confirmed decisions are unchanged.</span>
            </p>
          )}
          <Button
            type="button"
            className="mt-4 min-h-11 w-full sm:min-h-0 sm:w-auto"
            onClick={() => generateListingDrafts()}
            disabled={listingBusy}
            aria-busy={missingListingItemIds.includes(regeneratingItemId) || undefined}
          >
            <Sparkles aria-hidden="true" width={16} height={16} />
            {missingListingItemIds.length === 1 ? "Write a draft for this item" : "Write drafts for these items"}
          </Button>
        </section>
      )}
    </Frame>
  );
}
