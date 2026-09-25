import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Copy, RefreshCw, Trash2, Undo2, TriangleAlert, PackageX, Info } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import ItemCropThumbnail from "./ItemCropThumbnail";
import ImageLightbox from "./ImageLightbox";
import ListingDetailsFields from "./ListingDetailsFields";
import { itemNumberLabel } from "../utils/format";
import {
  TITLE_MIN,
  TITLE_MAX,
  DESCRIPTION_MIN,
  DESCRIPTION_MAX,
  draftEditValidity,
  formatListingClipboardText,
  unavailableReasonMessage,
} from "../lib/listingDrafts";
import { cn } from "../lib/cn";

// One confirmed Sell item's marketplace draft, laid out as a usable
// listing: a large crop of the item on the left (a button that opens the
// original photo in the shared lightbox with only this item outlined) and
// the listing editor on the right; on phones the image, the editor and
// the actions stack. Shared by Declutter's Results and Both's Results.
//
// Identity is item_id throughout: the article key, every field id, the
// lightbox outline and the only value any callback receives. The header
// shows the listing name (the seller's own name for the item, defaulting
// to the reviewed label) with a Draft status badge; no numbered badge,
// because nothing on this screen refers to items by number.
//
// Seller details (listing name, condition) live beside the editor. They
// are metadata: changing them never rewrites the title or description.
// A generated draft whose details have since changed is flagged stale
// and only an explicit AI Regenerate replaces it; regenerating an edited
// draft still asks first. Copy writes only the edited title and
// description, never the condition or any internal field. There is no
// price anywhere by design.
//
// Clipboard discipline is unchanged from the first version: the write
// happens synchronously inside the click handler, a token plus a mounted
// flag mean only the newest attempt can set feedback, and a failure
// shows a fixed generic message, never the browser's exception text.

function defaultClipboardWriter(text) {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error("Clipboard API unavailable"));
}

const HIGHLIGHT_BOX_CLASS = "z-20 border-4 border-primary bg-primary/10 ring-2 ring-ring ring-offset-1";

export default function ListingDraftCard({
  draft,
  reviewItem = null,
  imageUrl = null,
  isRegenerating = false,
  regenerationErrorMessage = null,
  listingBusy = false,
  onEdit = () => {},
  onRegenerate = () => {},
  onDiscard = () => {},
  onRestore = () => {},
  onDetailsChange = () => {},
  clipboardWriter = defaultClipboardWriter,
}) {
  const itemId = draft.item_id;
  const detectedLabel = draft.effective_label ?? reviewItem?.effective_label ?? reviewItem?.clean_label ?? itemId;
  const listingName = typeof draft.listing_name === "string" && draft.listing_name.trim() !== "" ? draft.listing_name.trim() : detectedLabel;
  const details = { listing_name: draft.listing_name ?? detectedLabel, condition: draft.condition ?? "not_specified" };
  const canEnlarge = Boolean(imageUrl && reviewItem?.box);

  const [copyState, setCopyState] = useState("idle");
  const [showRegenWarning, setShowRegenWarning] = useState(false);
  const [enlarged, setEnlarged] = useState(false);

  const copyTokenRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyTokenRef.current += 1; // orphan any in-flight write
    };
  }, []);

  const copyTokenIsCurrent = useCallback(
    (token) => mountedRef.current && copyTokenRef.current === token,
    []
  );

  const invalidateCopy = useCallback(() => {
    copyTokenRef.current += 1;
    setCopyState("idle");
  }, []);

  useEffect(() => {
    invalidateCopy();
  }, [draft.edited_title, draft.edited_description, draft.is_discarded, isRegenerating, invalidateCopy]);

  useEffect(() => {
    if (!draft.is_edited || draft.is_discarded || isRegenerating) setShowRegenWarning(false);
  }, [draft.is_edited, draft.is_discarded, isRegenerating]);

  const ids = {
    heading: `listing-draft-${itemId}-heading`,
    title: `listing-title-${itemId}`,
    titleHelp: `listing-title-${itemId}-help`,
    description: `listing-description-${itemId}`,
    descriptionHelp: `listing-description-${itemId}-help`,
    copyStatus: `listing-copy-${itemId}-status`,
    regenStatus: `listing-regen-${itemId}-status`,
    stale: `listing-stale-${itemId}`,
  };

  const header = (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={ids.heading} className="min-w-0 truncate text-base font-semibold text-foreground">
          {listingName}
        </h3>
        <Badge variant="primary">Draft</Badge>
        {draft.is_edited && <Badge variant="outline">Edited</Badge>}
      </div>
      {listingName !== detectedLabel && (
        <p className="mt-0.5 text-xs text-muted-foreground">Detected as {detectedLabel}</p>
      )}
    </div>
  );

  const itemImage = (size) => (
    <button
      type="button"
      onClick={() => setEnlarged(true)}
      disabled={!canEnlarge}
      aria-label={`Show ${listingName} in the photo`}
      className="group relative shrink-0 rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default"
    >
      <ItemCropThumbnail imageUrl={imageUrl} box={reviewItem?.box} className={cn(size, "rounded-card")} />
      {canEnlarge && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-pill bg-surface/90 px-2 py-0.5 text-[11px] font-medium text-foreground shadow-card backdrop-blur group-hover:bg-surface"
        >
          View in photo
        </span>
      )}
    </button>
  );

  const lightbox = canEnlarge ? (
    <ImageLightbox
      open={enlarged}
      onClose={() => setEnlarged(false)}
      src={imageUrl}
      alt="The space photo you uploaded"
      title={`${listingName} in your photo`}
      description="Only this item's outline is shown. Use Show boxes to hide it."
      overlays={[{ id: itemId, box: reviewItem.box, label: itemNumberLabel(itemId), className: HIGHLIGHT_BOX_CLASS }]}
      initialShowOverlays
    />
  ) : null;

  const detailsFields = (
    <ListingDetailsFields
      itemId={itemId}
      itemLabel={detectedLabel}
      details={details}
      onChange={onDetailsChange}
      disabled={isRegenerating}
      compact
      className="mt-3"
    />
  );

  if (draft.is_discarded) {
    return (
      <article
        aria-labelledby={ids.heading}
        data-item-id={itemId}
        className="rounded-card border border-dashed border-border bg-surface-muted p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <ItemCropThumbnail imageUrl={imageUrl} box={reviewItem?.box} className="h-12 w-12" />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 id={ids.heading} className="truncate text-sm font-semibold text-foreground">
                {listingName}
              </h3>
              <Badge variant="outline">Discarded</Badge>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              invalidateCopy();
              onRestore(itemId);
            }}
            className="text-muted-foreground"
          >
            <Undo2 aria-hidden="true" width={14} height={14} />
            Restore draft
          </Button>
        </div>
      </article>
    );
  }

  const regenProgress = isRegenerating && (
    <p id={ids.regenStatus} role="status" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 aria-hidden="true" width={14} height={14} className="animate-spin text-primary" />
      Regenerating the listing draft for {listingName}…
    </p>
  );

  const regenError = regenerationErrorMessage && (
    <p role="alert" className="mt-2 rounded-control border border-error/30 bg-error/10 p-2 text-xs text-error">
      {regenerationErrorMessage} Your confirmed decisions are unchanged.
    </p>
  );

  if (draft.status === "unavailable") {
    return (
      <article
        aria-labelledby={ids.heading}
        data-item-id={itemId}
        className="rounded-card border border-border bg-surface p-3 shadow-card sm:p-4"
      >
        <div className="grid gap-4 md:grid-cols-[auto_minmax(0,1fr)] md:items-start">
          {itemImage("h-32 w-32 sm:h-40 sm:w-40")}
          <div className="min-w-0">
            {header}
            <p className="mt-2 flex items-start gap-2 text-sm text-foreground">
              <PackageX aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0 text-muted-foreground" />
              {unavailableReasonMessage(draft.unavailable_reason)}
            </p>
            {detailsFields}
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  invalidateCopy();
                  onRegenerate(itemId);
                }}
                disabled={isRegenerating || listingBusy}
                aria-busy={isRegenerating || undefined}
              >
                {isRegenerating ? (
                  <Loader2 aria-hidden="true" width={14} height={14} className="animate-spin" />
                ) : (
                  <RefreshCw aria-hidden="true" width={14} height={14} />
                )}
                {isRegenerating ? "Regenerating…" : "AI Regenerate"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  invalidateCopy();
                  onDiscard(itemId);
                }}
                className="text-muted-foreground"
              >
                <Trash2 aria-hidden="true" width={14} height={14} />
                Discard
              </Button>
            </div>
            {regenProgress}
            {regenError}
          </div>
        </div>
        {lightbox}
      </article>
    );
  }

  const validity = draftEditValidity(draft.edited_title, draft.edited_description);
  const copyDisabled = !validity.valid || isRegenerating;

  function handleFieldEdit(patch) {
    invalidateCopy();
    onEdit(itemId, patch);
  }

  function handleCopy() {
    const token = (copyTokenRef.current += 1);
    setCopyState("idle");
    const payload = formatListingClipboardText(draft.edited_title, draft.edited_description);
    try {
      const result = clipboardWriter(payload);
      Promise.resolve(result)
        .then(() => {
          if (copyTokenIsCurrent(token)) setCopyState("copied");
        })
        .catch(() => {
          if (copyTokenIsCurrent(token)) setCopyState("error");
        });
    } catch {
      if (copyTokenIsCurrent(token)) setCopyState("error");
    }
  }

  function startRegeneration() {
    invalidateCopy();
    onRegenerate(itemId);
  }

  function handleRegenerateClick() {
    if (draft.is_edited) {
      setShowRegenWarning(true);
      return;
    }
    startRegeneration();
  }

  function confirmRegenerate() {
    if (listingBusy || isRegenerating) return;
    setShowRegenWarning(false);
    startRegeneration();
  }

  const titleDescribedBy = validity.title.valid ? undefined : ids.titleHelp;
  const descriptionDescribedBy = validity.description.valid ? undefined : ids.descriptionHelp;

  return (
    <article
      aria-labelledby={ids.heading}
      data-item-id={itemId}
      className="rounded-card border border-border bg-surface p-3 shadow-card sm:p-4"
    >
      {/* Two columns from md: the item image, then the editor. Below md
          everything stacks: image, editor, actions. */}
      <div className="grid gap-4 md:grid-cols-[auto_minmax(0,1fr)] md:items-start">
        {itemImage("h-40 w-40 sm:h-48 sm:w-48 md:h-56 md:w-56")}

        <div className="min-w-0">
          {header}
          {detailsFields}

          {draft.is_stale && (
            <p
              id={ids.stale}
              role="status"
              className="mt-3 flex items-start gap-2 rounded-control border border-warning/40 bg-warning/10 p-2 text-xs text-foreground"
            >
              <Info aria-hidden="true" width={14} height={14} className="mt-0.5 shrink-0 text-warning" />
              This draft was generated with different listing details. Use AI Regenerate to update it; your
              text is unchanged until you do.
            </p>
          )}

          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={ids.title} className="text-xs font-medium text-foreground">
                Listing title for {detectedLabel}
              </label>
              <span className={cn("text-[11px]", validity.title.valid ? "text-muted-foreground" : "text-error")}>
                {validity.title.trimmedLength}/{TITLE_MAX}
              </span>
            </div>
            <input
              id={ids.title}
              type="text"
              value={draft.edited_title}
              onChange={(event) => handleFieldEdit({ title: event.target.value })}
              aria-invalid={validity.title.valid ? undefined : "true"}
              aria-describedby={titleDescribedBy}
              className={cn(
                "mt-1 w-full rounded-control border bg-surface px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                validity.title.valid ? "border-input" : "border-error"
              )}
            />
            {!validity.title.valid && (
              <p id={ids.titleHelp} className="mt-1 text-[11px] text-error">
                Title must be between {TITLE_MIN} and {TITLE_MAX} characters after trimming.
              </p>
            )}
          </div>

          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={ids.description} className="text-xs font-medium text-foreground">
                Listing description for {detectedLabel}
              </label>
              <span
                className={cn("text-[11px]", validity.description.valid ? "text-muted-foreground" : "text-error")}
              >
                {validity.description.trimmedLength}/{DESCRIPTION_MAX}
              </span>
            </div>
            <textarea
              id={ids.description}
              rows={5}
              value={draft.edited_description}
              onChange={(event) => handleFieldEdit({ description: event.target.value })}
              aria-invalid={validity.description.valid ? undefined : "true"}
              aria-describedby={descriptionDescribedBy}
              className={cn(
                "mt-1 w-full rounded-control border bg-surface px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                validity.description.valid ? "border-input" : "border-error"
              )}
            />
            {!validity.description.valid && (
              <p id={ids.descriptionHelp} className="mt-1 text-[11px] text-error">
                Description must be between {DESCRIPTION_MIN} and {DESCRIPTION_MAX} characters after
                trimming.
              </p>
            )}
          </div>

          {/* Footer actions: Copy is the one primary action (full width on
              phones), AI Regenerate secondary, Discard quiet. */}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Button
              type="button"
              onClick={handleCopy}
              disabled={copyDisabled}
              aria-describedby={ids.copyStatus}
              className="min-h-11 w-full sm:min-h-0 sm:w-auto"
            >
              <Copy aria-hidden="true" width={16} height={16} />
              Copy listing
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRegenerateClick}
                disabled={isRegenerating || listingBusy}
                aria-busy={isRegenerating || undefined}
                aria-describedby={draft.is_stale ? ids.stale : undefined}
              >
                {isRegenerating ? (
                  <Loader2 aria-hidden="true" width={14} height={14} className="animate-spin" />
                ) : (
                  <RefreshCw aria-hidden="true" width={14} height={14} />
                )}
                {isRegenerating ? "Regenerating…" : "AI Regenerate"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  invalidateCopy();
                  onDiscard(itemId);
                }}
                className="text-muted-foreground"
              >
                <Trash2 aria-hidden="true" width={14} height={14} />
                Discard
              </Button>
            </div>
          </div>

          <p id={ids.copyStatus} role="status" className="mt-2 min-h-4 text-xs">
            {copyState === "copied" && <span className="text-success">Listing copied to your clipboard.</span>}
            {copyState === "error" && (
              <span className="text-error">Could not copy the listing. Your text has not changed.</span>
            )}
          </p>

          {showRegenWarning && (
            <div className="mt-2 rounded-control border border-warning/40 bg-warning/10 p-3">
              <p className="flex items-start gap-2 text-xs text-foreground">
                <TriangleAlert aria-hidden="true" width={14} height={14} className="mt-0.5 shrink-0 text-warning" />
                Regenerating this draft will replace your local edits to the title and description.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowRegenWarning(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={confirmRegenerate}
                  disabled={listingBusy || isRegenerating}
                  aria-busy={isRegenerating || undefined}
                  className="bg-error text-error-foreground hover:bg-error/90"
                >
                  Replace my edits and regenerate
                </Button>
              </div>
            </div>
          )}

          {regenProgress}
          {regenError}
        </div>
      </div>
      {lightbox}
    </article>
  );
}
