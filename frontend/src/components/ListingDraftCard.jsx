import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Copy, RefreshCw, Trash2, Undo2, TriangleAlert, PackageX } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import ItemCropThumbnail from "./ItemCropThumbnail";
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

// One marketplace-listing draft. Identity is item_id: it is the React key
// (set by the parent), every field id, and the only join key back to the
// review item (never label text). This component is presentational, it
// calls back into the Stage 3 hook actions passed as props and never
// touches the API, the clipboard writer, or any other card's state.
//
// draft is one entry of useDeclutterFlow().listingDrafts: the server
// fields (item_id, effective_label, status, title, description,
// unavailable_reason, was_repaired, attempts) plus the local overlay
// (edited_title, edited_description, is_edited, is_discarded).
//
// reviewItem is the current review item with the same item_id, or null:
// it supplies the decorative crop box and the location metadata. Missing
// values are simply not shown, never invented.
//
// clipboardWriter(text) -> Promise is an injectable seam. The production
// default calls navigator.clipboard.writeText, but only ever in direct
// response to the user's Copy click, and treats a missing API as an
// ordinary copy failure.
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
  clipboardWriter = defaultClipboardWriter,
}) {
  const itemId = draft.item_id;
  const label = draft.effective_label ?? reviewItem?.effective_label ?? reviewItem?.clean_label ?? itemId;

  // idle | copied | error. Local to this card, so one card's copy status
  // can never appear on another.
  const [copyState, setCopyState] = useState("idle");
  // The edited-draft regenerate warning. Not window.confirm: an inline
  // Cancel / destructive-confirm pair rendered in the card.
  const [showRegenWarning, setShowRegenWarning] = useState(false);

  // Clipboard concurrency guard. Every Copy click claims the next token;
  // a writer promise (success OR rejection) may only touch copyState if
  // its token is still current AND the card is still mounted. So a
  // pending write that settles AFTER an edit / regeneration / discard /
  // restore / unmount, or after a newer Copy click, cannot restore stale
  // feedback. mountedRef stops a late continuation writing state at all.
  const copyTokenRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    // React.StrictMode replays effect setup -> cleanup -> setup once in
    // development while the component stays mounted. Re-asserting `true`
    // on every setup (not just at the initial useRef value) means that
    // replay leaves mountedRef correctly true afterwards, instead of
    // stuck false from the throwaway cleanup and silently swallowing
    // every real clipboard completion for the component's whole life.
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

  // Invalidate any pending copy and clear visible feedback. Bumping the
  // token is what makes an already-pending clipboardWriter promise inert.
  const invalidateCopy = useCallback(() => {
    copyTokenRef.current += 1;
    setCopyState("idle");
  }, []);

  // Editing, regeneration, discard and restore all make any prior
  // "Copied" / copy-error feedback stale, and must also neutralise a
  // still-pending write. edited_* change on every edit and on a
  // successful regen (which also clears this item's edit); is_discarded
  // covers discard and restore; isRegenerating covers the in-flight
  // transition. This effect catches those transitions however they are
  // driven, including externally (prop changes). No timers.
  useEffect(() => {
    invalidateCopy();
  }, [draft.edited_title, draft.edited_description, draft.is_discarded, isRegenerating, invalidateCopy]);

  // Close a stale regenerate warning when it can no longer apply: the
  // edits are gone (draft replaced / not edited), the card was discarded,
  // or regeneration has already started. It is never re-opened here, so a
  // discard followed by a restore does not resurrect the old warning.
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
  };

  const identityHeader = (
    <div className="flex min-w-0 items-center gap-2">
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
        {itemNumberLabel(itemId)}
      </span>
      <h3 id={ids.heading} className="truncate text-sm font-medium text-foreground">
        {label}
      </h3>
    </div>
  );

  const locationBits = reviewItem
    ? [reviewItem.position, reviewItem.relative_size].filter((v) => typeof v === "string" && v !== "")
    : [];

  const metaLine = (
    <p className="mt-0.5 text-xs text-muted-foreground">
      item_id: <code>{itemId}</code>
      {locationBits.length > 0 && <> · {locationBits.join(", ")}</>}
    </p>
  );

  // ---------------------------------------------------------------- discarded
  if (draft.is_discarded) {
    return (
      <article
        aria-labelledby={ids.heading}
        className="rounded-card border border-dashed border-border bg-surface-muted p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ItemCropThumbnail imageUrl={imageUrl} box={reviewItem?.box} className="h-8 w-8" />
              {identityHeader}
              <Badge variant="outline">Discarded locally</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              item_id: <code>{itemId}</code>
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              invalidateCopy();
              onRestore(itemId);
            }}
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
      Regenerating the listing draft for {label}…
    </p>
  );

  const regenError = regenerationErrorMessage && (
    <p role="alert" className="mt-2 rounded-control border border-error/30 bg-error/10 p-2 text-xs text-error">
      {regenerationErrorMessage} Your confirmed decisions are unchanged.
    </p>
  );

  // -------------------------------------------------------------- unavailable
  if (draft.status === "unavailable") {
    return (
      <article
        aria-labelledby={ids.heading}
        className="rounded-card border border-border bg-surface p-4 shadow-card"
      >
        <div className="flex items-start gap-3">
          <ItemCropThumbnail imageUrl={imageUrl} box={reviewItem?.box} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            {identityHeader}
            {metaLine}

            <p className="mt-2 flex items-start gap-2 text-sm text-foreground">
              <PackageX aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0 text-muted-foreground" />
              {unavailableReasonMessage(draft.unavailable_reason)}
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
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
                {isRegenerating ? "Regenerating…" : "Regenerate draft"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  invalidateCopy();
                  onDiscard(itemId);
                }}
              >
                <Trash2 aria-hidden="true" width={14} height={14} />
                Discard draft
              </Button>
            </div>

            {regenProgress}
            {regenError}
          </div>
        </div>
      </article>
    );
  }

  // ---------------------------------------------------------------- generated
  const validity = draftEditValidity(draft.edited_title, draft.edited_description);
  const copyDisabled = !validity.valid || isRegenerating;

  function handleFieldEdit(patch) {
    // Any edit invalidates a pending copy and clears feedback BEFORE the
    // new text is forwarded, so a write in flight for the old text can
    // never land as "Copied" against what is now on screen.
    invalidateCopy();
    onEdit(itemId, patch);
  }

  function handleCopy() {
    // Exactly one write per click, using the CURRENT edited text.
    // clipboardWriter is called SYNCHRONOUSLY, directly in this click
    // handler, rather than deferred into a later microtask: real
    // Clipboard API permissions are gated on user activation, which a
    // later microtask can lose. The click claims the next token; only a
    // settlement whose token is still current (and while mounted) may
    // set feedback, so overlapping clicks and late settlements are
    // inert. A synchronous throw and an async rejection both funnel into
    // the same generic, token-guarded error state, so nothing is ever
    // uncaught and no raw browser error text is shown.
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
    // This confirm control is itself a regeneration trigger: honour the
    // same busy guard as the main button so a click during another
    // listing operation cannot fire onRegenerate.
    if (listingBusy || isRegenerating) return;
    setShowRegenWarning(false);
    startRegeneration();
  }

  const titleDescribedBy = validity.title.valid ? undefined : ids.titleHelp;
  const descriptionDescribedBy = validity.description.valid ? undefined : ids.descriptionHelp;

  return (
    <article
      aria-labelledby={ids.heading}
      className="rounded-card border border-border bg-surface p-4 shadow-card"
    >
      <div className="flex items-start gap-3">
        <ItemCropThumbnail imageUrl={imageUrl} box={reviewItem?.box} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
            {identityHeader}
            {draft.is_edited && <Badge variant="warning">Edited</Badge>}
          </div>
          {metaLine}

          <p className="mt-2 text-xs text-muted-foreground">
            These are editable suggestions. Nothing is published, and editing here changes only your
            local copy.
          </p>

          {/* title */}
          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={ids.title} className="text-xs font-medium text-foreground">
                Listing title for {label}
              </label>
              <span
                className={cn("text-[11px]", validity.title.valid ? "text-muted-foreground" : "text-error")}
              >
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

          {/* description */}
          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={ids.description} className="text-xs font-medium text-foreground">
                Listing description for {label}
              </label>
              <span
                className={cn(
                  "text-[11px]",
                  validity.description.valid ? "text-muted-foreground" : "text-error"
                )}
              >
                {validity.description.trimmedLength}/{DESCRIPTION_MAX}
              </span>
            </div>
            <textarea
              id={ids.description}
              rows={4}
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

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleCopy}
              disabled={copyDisabled}
              aria-describedby={ids.copyStatus}
            >
              <Copy aria-hidden="true" width={14} height={14} />
              Copy listing
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRegenerateClick}
              disabled={isRegenerating || listingBusy}
              aria-busy={isRegenerating || undefined}
            >
              {isRegenerating ? (
                <Loader2 aria-hidden="true" width={14} height={14} className="animate-spin" />
              ) : (
                <RefreshCw aria-hidden="true" width={14} height={14} />
              )}
              {isRegenerating ? "Regenerating…" : "Regenerate draft"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                invalidateCopy();
                onDiscard(itemId);
              }}
            >
              <Trash2 aria-hidden="true" width={14} height={14} />
              Discard draft
            </Button>
          </div>

          {/* copy feedback, scoped to this card */}
          <p id={ids.copyStatus} role="status" className="mt-2 min-h-[1rem] text-xs">
            {copyState === "copied" && (
              <span className="text-success">Listing copied to your clipboard.</span>
            )}
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
    </article>
  );
}
