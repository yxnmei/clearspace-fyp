import { Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import ListingDraftCard from "./ListingDraftCard";
import { deriveEligibleSellItemIds } from "../lib/listingDrafts";

// The marketplace-listing review surface. Presentational: it takes the
// Stage 3 listing state and actions as props and never calls
// useDeclutterFlow / useBothFlow itself. Stage 4B wires it into the
// Declutter wizard and the Both page.
//
// Eligibility (which items get a draft) is derived STRICTLY from
// confirmation.confirmedDecisions: confirmed_decision === "sell" and
// excluded === false, in confirmation order. Never from labels, draft
// presence, Keep ids, or any client-supplied fallback list.
//
// Nothing here auto-generates. generateListingDrafts runs only from the
// explicit button (and its retry). A confirmation with zero eligible
// Sell items shows a truthful empty state and offers no pointless
// Generate button.

const HEADING_ID = "listings-view-heading";

// Module-level so its identity is stable across ListingsView renders,
// re-declaring it inside the component would remount the whole subtree
// (and drop input focus) on every keystroke while editing a draft.
function Frame({ children }) {
  return (
    <section
      aria-labelledby={HEADING_ID}
      className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6"
    >
      <h2 id={HEADING_ID} className="text-lg font-semibold text-foreground">
        Marketplace listing drafts
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
  clipboardWriter,
}) {
  // 1. No confirmation yet: no actionable listing UI, no generation.
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

  // 2. Confirmed, but nothing was marked Sell: truthful empty state, no
  // loading/error, no Generate button.
  if (eligibleItemIds.length === 0) {
    return (
      <Frame>
        <p className="mt-2 text-sm text-foreground">
          You did not confirm any items as Sell, so there are no marketplace listing drafts to
          generate.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          If you want listing drafts, go back to Decide items and change an item's decision to Sell, then
          confirm again.
        </p>
      </Frame>
    );
  }

  const reviewItemsById = new Map(reviewItems.map((item) => [item.item_id, item]));
  const eligibleCountLabel = `${eligibleItemIds.length} item${eligibleItemIds.length === 1 ? "" : "s"}`;
  const listingBusy = listingStatus === "generating" || regeneratingItemId !== null;

  // 3. Eligible items, not generated yet: explain, then an explicit action.
  if (listingStatus === "idle") {
    return (
      <Frame>
        <p className="mt-2 text-sm text-foreground">
          You confirmed {eligibleCountLabel} to sell. Generate a draft title and description for each
          one.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Drafts are editable suggestions. Nothing is published, listed, or sent to any marketplace.
        </p>
        <Button type="button" className="mt-4" onClick={() => generateListingDrafts()}>
          <Sparkles aria-hidden="true" width={16} height={16} />
          Generate listing drafts
        </Button>
      </Frame>
    );
  }

  // 4. Generating: accessible progress, duplicate generation disabled.
  if (listingStatus === "generating") {
    return (
      <Frame>
        <p
          className="mt-2 flex items-center gap-2 text-sm text-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 aria-hidden="true" width={16} height={16} className="animate-spin text-primary" />
          Generating {eligibleCountLabel} of listing drafts…
        </p>
        <p className="mt-1 text-sm text-muted-foreground">Nothing is being published.</p>
        <Button
          type="button"
          className="mt-4"
          disabled
          aria-busy="true"
          onClick={() => generateListingDrafts()}
        >
          <Loader2 aria-hidden="true" width={16} height={16} className="animate-spin" />
          Generating…
        </Button>
      </Frame>
    );
  }

  // 5. Error: concise message, decisions unchanged, explicit retry.
  if (listingStatus === "error") {
    return (
      <Frame>
        <p
          role="alert"
          className="mt-2 flex items-start gap-2 rounded-control border border-error/30 bg-error/10 p-3 text-sm text-error"
        >
          <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0" />
          <span>
            {listingError || "Listing draft generation failed."} Your confirmed Declutter decisions
            are unchanged.
          </span>
        </p>
        <Button type="button" className="mt-4" onClick={() => generateListingDrafts()}>
          <Sparkles aria-hidden="true" width={16} height={16} />
          Try again
        </Button>
      </Frame>
    );
  }

  // 6. Ready: render every draft in hook order, no silent filtering.
  if (listingDrafts.length === 0) {
    // Defensive: eligible items exist but no drafts arrived. Offer the
    // explicit action again rather than a blank panel.
    return (
      <Frame>
        <p className="mt-2 text-sm text-foreground">No listing drafts were returned.</p>
        <Button type="button" className="mt-4" onClick={() => generateListingDrafts()}>
          <Sparkles aria-hidden="true" width={16} height={16} />
          Generate listing drafts
        </Button>
      </Frame>
    );
  }

  return (
    <Frame>
      <p className="mt-2 text-sm text-muted-foreground">
        {listingDrafts.length} draft{listingDrafts.length === 1 ? "" : "s"}. Edits are local, and
        nothing is published automatically. Use Copy listing to paste a draft wherever you want it.
      </p>
      <ul className="mt-4 space-y-4">
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
              clipboardWriter={clipboardWriter}
            />
          </li>
        ))}
      </ul>
    </Frame>
  );
}
