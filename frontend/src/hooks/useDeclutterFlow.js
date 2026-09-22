import { useCallback, useRef, useState } from "react";
import {
  confirmDecisions,
  generateListings,
  overrideItem,
  regenerateListing,
  uploadImage,
} from "../api/client";
import { normaliseDeclutterUploadResponse, normaliseOverrideResponse } from "../api/declutterContract";
import { normaliseListingResponse, normaliseSingleListingResponse } from "../api/listingContract";
import {
  buildReviewItems,
  clearDecisionOverride as clearDecisionOverrideEntry,
  normaliseConfirmationResponse,
  serialiseDecisionOverrides,
  setDecisionOverride as setDecisionOverrideEntry,
  setItemExcluded as setItemExcludedEntry,
} from "../api/confirmationContract";

// Per-flow state + logic pulled into a hook from the start (§4), rather
// than living inline inside a growing DeclutterPage component. Backend
// POST /upload, POST /confirm and POST /override are all implemented,
// see app/api/routes.py, app/services/declutter_service.py and
// app/services/confirmation_service.py. Their nested responses are
// passed through normaliseDeclutterUploadResponse()/
// normaliseOverrideResponse()/normaliseConfirmationResponse()
// (api/declutterContract.js, api/confirmationContract.js), which join by
// item_id and throw on a malformed contract rather than silently
// returning empty output.
//
// React Testing Library is installed in this project, the two
// concurrency guards below (flowGenerationRef/confirmationGenerationRef)
// are exercised directly by rendered-hook tests
// (useDeclutterFlow.test.jsx), not just reviewed by inspection.
//
// uploadPath/normaliseUploadResponse (R6, Both, required correction 5):
// optional, default-compatible configuration so useBothFlow can COMPOSE
// this hook (path="both" + normaliseBothUploadResponse) rather than
// copying it, every existing call site (DeclutterPage) calls
// useDeclutterFlow() with no arguments at all, so the defaults below
// reproduce today's exact behavior byte-for-byte; nothing about
// submit()/confirm()/correctLabel()/the two concurrency domains changes
// for Declutter. inputImageSha256 is exposed on the returned object for
// the same reason, normaliseBothUploadResponse's extra field flows
// through `flow` and out of the hook untouched; normaliseDeclutterUploadResponse
// never sets it, so it's simply null for ordinary Declutter use.
const EMPTY_FLOW = { runId: null, analysis: null, declutter: null, items: [], context: null, inputImageSha256: null };

// Default listing I/O surface. `listingApi` is a default-compatible
// injection seam (Stage 3): every existing caller invokes useDeclutterFlow()
// with no arguments and gets exactly this, so nothing about listing
// behaviour depends on a test double being supplied. useBothFlow passes
// its own `listingApi` straight through to the composed hook. All four
// members are the committed Stage 2 functions; a fake replaces the
// network round-trip (generateListings/regenerateListing) and may
// optionally replace the pure normalisers too.
const DEFAULT_LISTING_API = {
  generateListings,
  regenerateListing,
  normaliseListingResponse,
  normaliseSingleListingResponse,
};

export function useDeclutterFlow({
  uploadPath = "declutter",
  normaliseUploadResponse = normaliseDeclutterUploadResponse,
  listingApi = DEFAULT_LISTING_API,
} = {}) {
  const [status, setStatus] = useState("idle"); // idle | uploading | ready | error
  const [flow, setFlow] = useState(EMPTY_FLOW);
  const [error, setError] = useState(null);

  const [overridesById, setOverridesById] = useState({});
  const [confirmation, setConfirmation] = useState(null);
  const [confirmationStatus, setConfirmationStatus] = useState("idle"); // idle | confirming | confirmed | error
  const [confirmationError, setConfirmationError] = useState(null);

  // Label-correction state (POST /override), correctingItemId is the
  // single item_id currently in flight, or null. correctionError is
  // { itemId, message } (which item's last attempt failed) or null, so
  // the UI can show a failure next to the right card without it bleeding
  // onto every other item.
  const [correctingItemId, setCorrectingItemId] = useState(null);
  const [correctionError, setCorrectionError] = useState(null);

  // Marketplace listing domain (Stage 3). Its own state, its own
  // concurrency slot (listingGenerationRef + activeListingRef below),
  // fully independent of the upload/correction and confirmation domains
  // -- and, one layer up in useBothFlow, of the Reorganise generate
  // slot. Nothing in this domain ever writes flow.*, overridesById,
  // confirmation, or any Reorganise state.
  //
  //   listingStatus:        idle | generating | ready | error
  //   listingResult:        the normalised batch result (or the
  //                         contract's empty shape for zero eligible
  //                         Sell items), or null
  //   listingError:         batch-generation failure message, or null
  //   regeneratingItemId:   the one item_id whose single regen is in
  //                         flight, or null
  //   regenerationError:    { itemId, message } for the item whose last
  //                         regen failed, or null (never bleeds onto
  //                         another card)
  //   listingEditsById:     { [item_id]: { title, description } } -- the
  //                         user's local edits, stored VERBATIM (never
  //                         trimmed/coerced), keyed strictly by item_id
  //   discardedListingIds:  { [item_id]: true } -- local presentation
  //                         state only; not backend eligibility
  const [listingStatus, setListingStatus] = useState("idle");
  const [listingResult, setListingResult] = useState(null);
  const [listingError, setListingError] = useState(null);
  const [regeneratingItemId, setRegeneratingItemId] = useState(null);
  const [regenerationError, setRegenerationError] = useState(null);
  const [listingEditsById, setListingEditsById] = useState({});
  const [discardedListingIds, setDiscardedListingIds] = useState({});

  // Two SEPARATE concurrency domains, not one shared counter, this used
  // to be a single flowGenerationRef covering upload/correctLabel/confirm
  // AND every decision/exclusion edit, which had a real stuck-state bug:
  // starting a label correction, then editing a decision (setDecisionOverride
  // /setItemExcluded/clearDecisionOverride) while it was still in flight,
  // bumped the SAME ref the correction was checking, so the correction's
  // own (perfectly valid, not actually superseded) response was discarded
  // as "stale", leaving correctingItemId stuck non-null forever. Decision
  // edits must invalidate a *confirmation*, but they have nothing to do
  // with whether an in-flight *correction*'s flow-replacing response is
  // still current.
  //
  // flowGenerationRef: protects writes to flow.analysis/declutter/items,
  // bumped only by submit() and performCorrection() (the two operations
  // that actually replace those fields). A response is only applied if
  // this ref still holds the exact value claimed before that call's own
  // await.
  //
  // confirmationGenerationRef: protects confirmation/confirmationStatus/
  // confirmationError, bumped by submit(), performCorrection() (starting
  // a correction invalidates any confirmed result, see below), every
  // decision/exclusion edit, AND confirm() itself for its own generation
  // claim. A stale confirm() response is only discarded by THIS ref, never
  // by flowGenerationRef, so an unrelated correction elsewhere can't make
  // a confirm() call spuriously stale, and vice versa.
  //
  // submit() bumps BOTH, a new upload invalidates a previous upload/
  // correction's pending flow write AND any confirmation. performCorrection()
  // also bumps both, a correction beginning invalidates an older
  // correction (or is blocked/superseded per the same-item/different-item
  // rule below) AND invalidates confirmation, since the AI reasoning
  // behind any confirmed result is about to change. Decision/exclusion
  // edits bump ONLY confirmationGenerationRef.
  //
  // correctLabel() allows re-entry for the SAME item_id while a
  // correction for that exact item is still in flight (the second call
  // supersedes the first, via flowGenerationRef), but is blocked
  // outright (a silent no-op, no request even sent) if a DIFFERENT item
  // is currently being corrected. Two full-replacement /override
  // responses for two different items racing each other could otherwise
  // let whichever happens to resolve first be silently overwritten by
  // the other's now-stale (pre-correction) snapshot, even though both
  // corrections were individually valid, serializing cross-item
  // corrections avoids that without needing per-item generation tracking.
  const flowGenerationRef = useRef(0);
  const confirmationGenerationRef = useRef(0);

  // Listing concurrency domain: a monotonic counter ("is this listing
  // response still current") plus an ownership token ("is a batch OR a
  // single regen currently in flight"). Deliberately NOT any of the refs
  // above, and (in useBothFlow) NOT that hook's generate slot. A duplicate
  // batch/regen dispatch while the slot is owned is a state-neutral no-op;
  // any invalidation releases the slot immediately rather than waiting
  // for a stale request to settle, and the bumped counter guarantees a
  // late stale success OR rejection can never repopulate listing state.
  const listingGenerationRef = useRef(0);
  const activeListingRef = useRef(null);

  const invalidateListing = useCallback(() => {
    listingGenerationRef.current += 1;
    activeListingRef.current = null;
    setListingStatus("idle");
    setListingResult(null);
    setListingError(null);
    setRegeneratingItemId(null);
    setRegenerationError(null);
    setListingEditsById({});
    setDiscardedListingIds({});
  }, []);

  const invalidateConfirmation = useCallback(() => {
    confirmationGenerationRef.current += 1;
    setConfirmation(null);
    setConfirmationStatus("idle");
    setConfirmationError(null);
    // A dropped/changed confirmation makes any listing result stale --
    // every caller that changes what a confirmation MEANT (submit,
    // setDecisionOverride, setItemExcluded, clearDecisionOverride, a
    // correction that actually starts, reset) routes through here, so
    // listing invalidation is chained off it once. confirm() bumps
    // confirmationGenerationRef directly and calls invalidateListing()
    // itself.
    invalidateListing();
  }, [invalidateListing]);

  const submit = useCallback(
    async ({ file, context }) => {
      flowGenerationRef.current += 1; // invalidates a previous upload/in-flight correction's flow write
      const generation = flowGenerationRef.current;
      invalidateConfirmation(); // separate ref, invalidates any outstanding confirm()

      setStatus("uploading");
      setError(null);
      setFlow(EMPTY_FLOW); // clear the previous result before a new upload starts
      setOverridesById({});
      setCorrectingItemId(null);
      setCorrectionError(null);

      try {
        const response = await uploadImage({ file, path: uploadPath, context });
        const normalised = normaliseUploadResponse(response);

        if (flowGenerationRef.current !== generation) {
          return; // superseded by a newer submit()/correctLabel(), discard silently
        }
        setFlow({ ...normalised, context });
        setStatus("ready");
      } catch (err) {
        if (flowGenerationRef.current !== generation) {
          return; // same staleness guard on the failure path
        }
        setError(err instanceof Error ? err.message : "Declutter upload failed");
        setStatus("error");
      }
    },
    [invalidateConfirmation, uploadPath, normaliseUploadResponse]
  );

  // An item is reviewable (decision override eligible) only if it's a
  // real *resolved* expected item, never a contextual detection (not in
  // expected_item_ids) and never an unresolved one (still_invalid, no
  // AiDecision to override yet).
  const isReviewableItemId = useCallback(
    (itemId) => {
      const expectedItemIds = flow.declutter?.expected_item_ids ?? [];
      const unresolvedItemIds = flow.declutter?.unresolved_item_ids ?? [];
      return expectedItemIds.includes(itemId) && !unresolvedItemIds.includes(itemId);
    },
    [flow.declutter]
  );

  // A label CORRECTION, unlike a decision override, is available for
  // BOTH resolved and unresolved expected items, correcting an
  // unresolved item's label is exactly how it might become resolved.
  // Never contextual (not in expected_item_ids), never an unknown id.
  const isCorrectableItemId = useCallback(
    (itemId) => (flow.declutter?.expected_item_ids ?? []).includes(itemId),
    [flow.declutter]
  );

  const setDecisionOverride = useCallback(
    // userReason defaults to undefined here too (not null), see
    // api/confirmationContract.js's setDecisionOverride for the full
    // omitted-vs-null-vs-blank semantics; omitting it entirely preserves
    // whatever reason text the user already entered for this item.
    (itemId, decision, userReason = undefined) => {
      if (!isReviewableItemId(itemId)) {
        throw new Error(`setDecisionOverride: ${JSON.stringify(itemId)} is not a resolved expected item`);
      }
      setOverridesById((prev) => setDecisionOverrideEntry(prev, itemId, decision, userReason));
      invalidateConfirmation(); // confirmationGenerationRef only, never touches an in-flight correction
    },
    [isReviewableItemId, invalidateConfirmation]
  );

  const setItemExcluded = useCallback(
    (itemId, excluded) => {
      if (!isReviewableItemId(itemId)) {
        throw new Error(`setItemExcluded: ${JSON.stringify(itemId)} is not a resolved expected item`);
      }
      setOverridesById((prev) => setItemExcludedEntry(prev, itemId, excluded));
      invalidateConfirmation();
    },
    [isReviewableItemId, invalidateConfirmation]
  );

  const clearDecisionOverride = useCallback(
    (itemId) => {
      if (!isReviewableItemId(itemId)) {
        throw new Error(`clearDecisionOverride: ${JSON.stringify(itemId)} is not a resolved expected item`);
      }
      setOverridesById((prev) => clearDecisionOverrideEntry(prev, itemId));
      invalidateConfirmation();
    },
    [isReviewableItemId, invalidateConfirmation]
  );

  const reviewItems = buildReviewItems(flow.items, overridesById);

  // Split into a synchronous validating wrapper (correctLabel) and an
  // async worker (performCorrection): an `async` function's body never
  // throws synchronously, even a throw before the first `await` becomes
  // a rejected promise, so a plain `async (itemId, label) => {...}`
  // here would silently turn setDecisionOverride's established
  // "invalid itemId throws synchronously" contract into an unhandled
  // rejection instead. Keeping the validation in a non-async function
  // preserves that contract (and keeps it testable the same way:
  // `expect(() => correctLabel(...)).toThrow()`), while still returning
  // the awaitable promise callers need for the real (async) work.
  const performCorrection = useCallback(
    async (itemId, trimmedLabel) => {
      // A DIFFERENT item is already being corrected, blocked as a
      // silent no-op (no request sent, no state change), not a thrown
      // error: this is a transient precondition a fast double-click or a
      // disabled-button race can trigger, not caller misuse. Re-entry
      // for the SAME item is allowed (see module-level comment above).
      if (correctingItemId !== null && correctingItemId !== itemId) {
        return null;
      }
      if (!flow.analysis || !flow.declutter) {
        return null; // nothing to correct yet
      }

      flowGenerationRef.current += 1; // this call's own claim, invalidates an older in-flight correction/upload write
      const generation = flowGenerationRef.current;
      invalidateConfirmation(); // separate ref, a correction invalidates any confirmed result / in-flight confirm()
      const runId = flow.runId;
      const analysisSnapshot = flow.analysis;
      const declutterSnapshot = flow.declutter;
      const userContext = flow.context;

      setCorrectingItemId(itemId);
      setCorrectionError(null);

      try {
        const response = await overrideItem({
          runId,
          analysis: analysisSnapshot,
          declutter: declutterSnapshot,
          itemId,
          correctedLabel: trimmedLabel,
          userContext,
        });
        const normalised = normaliseOverrideResponse(response);

        if (flowGenerationRef.current !== generation) {
          return null; // superseded by a newer submit()/correctLabel(), discard silently (never by a decision edit or confirm())
        }
        setFlow((prev) => ({ ...prev, analysis: normalised.analysis, declutter: normalised.declutter, items: normalised.items }));
        setCorrectingItemId(null);
        return normalised;
      } catch (err) {
        if (flowGenerationRef.current !== generation) {
          return null; // same staleness guard on the failure path
        }
        // flow.analysis/declutter/items and the user's overridesById are
        // deliberately left untouched here, a failed correction must
        // never erase review work already done, and the user's typed
        // correction text stays in the UI's own local input state (this
        // hook never held it).
        setCorrectingItemId(null);
        setCorrectionError({ itemId, message: err instanceof Error ? err.message : "Label correction failed" });
        return null;
      }
    },
    [correctingItemId, flow.analysis, flow.declutter, flow.runId, flow.context, invalidateConfirmation]
  );

  const correctLabel = useCallback(
    // Caller-input validation, thrown synchronously, matching
    // setDecisionOverride's convention for "this itemId is not a
    // legitimate target at all" (a programming error, not a transient
    // precondition like "another item is already being corrected",
    // which performCorrection above handles as a silent no-op instead).
    (itemId, correctedLabel) => {
      if (!isCorrectableItemId(itemId)) {
        throw new Error(`correctLabel: ${JSON.stringify(itemId)} is not an expected item`);
      }
      const trimmedLabel = typeof correctedLabel === "string" ? correctedLabel.trim() : "";
      if (trimmedLabel === "") {
        throw new Error("correctLabel: correctedLabel must be a non-empty string");
      }
      return performCorrection(itemId, trimmedLabel);
    },
    [isCorrectableItemId, performCorrection]
  );

  const confirm = useCallback(async () => {
    // Returns the normalized ConfirmationResult on success, or null on
    // any failure/no-op/staleness, never rethrows. Callers that need to
    // react to failure should read confirmationStatus/confirmationError;
    // a stale response makes NO state changes at all (not even setting
    // an error), since by definition something newer has already
    // superseded it.
    //
    // Blocked-by-in-flight-correction is a deliberately STATE-NEUTRAL
    // no-op, not an error: the UI already disables the Confirm button
    // while correctingItemId is set (isConfirmBlocked in
    // lib/declutterReview, applied by DeclutterPage and BothPage), so reaching
    // this branch at all means either a direct/programmatic call or a
    // brief disabled-button race, setting a real confirmationError here
    // would otherwise leave a stale "correction in progress" message
    // visible after the correction has long since finished, since
    // nothing else would ever clear it.
    if (correctingItemId !== null) {
      return null;
    }
    if (!flow.declutter) {
      setConfirmationStatus("error");
      setConfirmationError("Cannot confirm: no Declutter result to confirm yet.");
      return null;
    }
    if ((flow.declutter.unresolved_item_ids ?? []).length > 0) {
      setConfirmationStatus("error");
      setConfirmationError("Cannot confirm: all Declutter items must be resolved first.");
      return null;
    }

    // Claim a unique generation for this call, and capture the exact
    // runId/DeclutterResult this request will use and validate against,
    // before awaiting, so a later edit or a newer confirm() call can
    // never retroactively change what THIS request is judged by.
    // confirmationGenerationRef only, a correction or a decision edit
    // elsewhere invalidates this via invalidateConfirmation() (which
    // bumps this same ref), but never via flowGenerationRef.
    const generation = ++confirmationGenerationRef.current;
    // Starting a fresh confirmation invalidates any prior listing result:
    // the drafts it produced were keyed to the OLD confirmation. This is
    // the one invalidation not chained off invalidateConfirmation()
    // (which confirm() does not call).
    invalidateListing();
    const runId = flow.runId;
    const declutterSnapshot = flow.declutter;

    setConfirmationStatus("confirming");
    setConfirmationError(null);

    try {
      const overrides = serialiseDecisionOverrides(overridesById, declutterSnapshot.expected_item_ids);
      const response = await confirmDecisions({ runId, declutter: declutterSnapshot, overrides });
      const normalised = normaliseConfirmationResponse(response, declutterSnapshot);

      if (confirmationGenerationRef.current !== generation) {
        return null; // superseded by a newer edit/correction/confirm(), discard silently
      }
      setConfirmation(normalised);
      setConfirmationStatus("confirmed");
      return normalised;
    } catch (err) {
      if (confirmationGenerationRef.current !== generation) {
        return null; // same staleness guard on the failure path
      }
      // Declutter analysis/items and the user's overridesById are
      // deliberately left untouched here, a failed confirmation must
      // never erase review work already done.
      setConfirmationStatus("error");
      setConfirmationError(err instanceof Error ? err.message : "Decision confirmation failed");
      return null;
    }
  }, [correctingItemId, flow.declutter, flow.runId, overridesById, invalidateListing]);

  // -------------------------------------------------------------------------
  // Marketplace listing actions (Stage 3). All snapshot the exact runId /
  // analysis / declutter / confirmation / review items they will validate
  // against BEFORE awaiting, so a later edit/correction/upload/reset can
  // never retroactively change what a response is judged by.
  // -------------------------------------------------------------------------

  const generateListingDrafts = useCallback(async () => {
    // Never auto-runs; a caller (Stage 4's explicit "Generate listing
    // drafts" button) invokes this. Silent no-op unless there is a
    // successful current confirmation and complete source data.
    if (confirmationStatus !== "confirmed" || !confirmation) return null;
    if (!flow.runId || !flow.analysis || !flow.declutter) return null;
    // A batch or a regen already owns the slot: a duplicate click is a
    // state-neutral no-op, no second request.
    if (activeListingRef.current !== null) return null;

    const generation = ++listingGenerationRef.current;

    const runId = flow.runId;
    const analysisSnapshot = flow.analysis;
    const declutterSnapshot = flow.declutter;
    const currentConfirmed = confirmation;
    const currentReviewItems = buildReviewItems(flow.items, overridesById);

    // Zero eligible Sell items: a valid completed empty result built to
    // the contract's own empty shape, with NO network call.
    const eligibleSellIds = currentConfirmed.confirmedDecisions
      .filter((d) => d.confirmed_decision === "sell" && d.excluded === false)
      .map((d) => d.item_id);
    if (eligibleSellIds.length === 0) {
      const emptyResult = {
        runId,
        confirmation: currentConfirmed,
        eligibleItemIds: [],
        drafts: [],
        modelName: null,
        promptVersion: null,
        maxAttempts: null,
      };
      setListingResult(emptyResult);
      setListingEditsById({});
      setDiscardedListingIds({});
      setListingError(null);
      setRegenerationError(null);
      setRegeneratingItemId(null);
      setListingStatus("ready");
      return emptyResult;
    }

    activeListingRef.current = generation; // claim the slot for the round-trip
    const overrides = serialiseDecisionOverrides(overridesById, declutterSnapshot.expected_item_ids);

    setListingStatus("generating");
    setListingError(null);
    setRegenerationError(null);

    try {
      const response = await listingApi.generateListings({
        runId,
        analysis: analysisSnapshot,
        declutter: declutterSnapshot,
        overrides,
      });
      const normalised = listingApi.normaliseListingResponse(response, {
        runId,
        sourceDeclutter: declutterSnapshot,
        currentConfirmed,
        currentReviewItems,
      });
      if (listingGenerationRef.current !== generation) {
        return null; // stale success: something newer already invalidated listing
      }
      setListingResult(normalised);
      setListingEditsById({});
      setDiscardedListingIds({});
      setListingStatus("ready");
      return normalised;
    } catch (err) {
      if (listingGenerationRef.current !== generation) {
        return null; // stale rejection discarded too -- no state change
      }
      // confirmation / overridesById / flow.* are deliberately untouched:
      // a batch failure must never disturb confirmed Declutter work.
      setListingError(err instanceof Error ? err.message : "Listing draft generation failed");
      setListingStatus("error");
      return null;
    } finally {
      if (activeListingRef.current === generation) activeListingRef.current = null;
    }
  }, [
    confirmationStatus,
    confirmation,
    flow.runId,
    flow.analysis,
    flow.declutter,
    flow.items,
    overridesById,
    listingApi,
  ]);

  const performListingRegeneration = useCallback(
    async (itemId) => {
      // A batch or another regen owns the slot: no duplicate dispatch.
      // A transient precondition, handled as a silent no-op (not a throw)
      // like performCorrection's cross-item block.
      if (activeListingRef.current !== null) return null;

      const generation = ++listingGenerationRef.current;
      activeListingRef.current = generation;

      const runId = flow.runId;
      const analysisSnapshot = flow.analysis;
      const declutterSnapshot = flow.declutter;
      const currentConfirmed = confirmation;
      const currentReviewItems = buildReviewItems(flow.items, overridesById);
      const overrides = serialiseDecisionOverrides(overridesById, declutterSnapshot.expected_item_ids);
      // The batch result this regen will merge one draft into. Its
      // aggregate provenance (modelName/promptVersion/maxAttempts)
      // describes every OTHER draft, so the single response MUST report
      // exactly the same values -- otherwise the merged result is
      // internally inconsistent (e.g. maxAttempts 3 alongside a draft
      // whose attempts is 4).
      const resultSnapshot = listingResult;

      setRegeneratingItemId(itemId);
      setRegenerationError(null);

      try {
        const response = await listingApi.regenerateListing({
          runId,
          analysis: analysisSnapshot,
          declutter: declutterSnapshot,
          overrides,
          itemId,
        });
        const normalised = listingApi.normaliseSingleListingResponse(response, {
          runId,
          sourceDeclutter: declutterSnapshot,
          currentConfirmed,
          currentReviewItems,
          itemId,
        });
        if (listingGenerationRef.current !== generation) {
          return null; // stale success: NO state change at all
        }
        // Aggregate-provenance invariant: the single response's
        // modelName / promptVersion / maxAttempts must EXACTLY equal the
        // batch result's. A difference is contract drift -- reject it
        // exactly like a regen failure: keep the prior draft, edits,
        // discards, batch result and confirmation untouched, and surface
        // the item-specific error. It is NOT fixed by overwriting the
        // batch-level provenance from the single response, which would
        // mis-attribute the new provenance to every untouched draft.
        if (
          !resultSnapshot ||
          normalised.modelName !== resultSnapshot.modelName ||
          normalised.promptVersion !== resultSnapshot.promptVersion ||
          normalised.maxAttempts !== resultSnapshot.maxAttempts
        ) {
          setRegeneratingItemId(null);
          setRegenerationError({
            itemId,
            message: "Listing draft regeneration returned inconsistent provenance",
          });
          return null;
        }
        // Replace ONLY the target draft; every other draft keeps its
        // exact object identity. Batch-level provenance
        // (confirmation/eligibleItemIds/model/prompt/max_attempts) is
        // now verified equal above, so prev's references stay.
        setListingResult((prev) =>
          prev
            ? { ...prev, drafts: prev.drafts.map((d) => (d.item_id === itemId ? normalised.draft : d)) }
            : prev
        );
        // The fresh server draft supersedes THIS item's local edit and
        // discard state (and only this item's).
        setListingEditsById((prev) => {
          if (!(itemId in prev)) return prev;
          const next = { ...prev };
          delete next[itemId];
          return next;
        });
        setDiscardedListingIds((prev) => {
          if (!(itemId in prev)) return prev;
          const next = { ...prev };
          delete next[itemId];
          return next;
        });
        setRegeneratingItemId(null);
        setRegenerationError(null);
        return normalised;
      } catch (err) {
        if (listingGenerationRef.current !== generation) {
          return null; // stale rejection: NO state change
        }
        // listingResult / edits / discards are left EXACTLY as they were:
        // a failed regen must keep the prior generated-or-edited draft
        // and every unrelated piece of state.
        setRegeneratingItemId(null);
        setRegenerationError({
          itemId,
          message: err instanceof Error ? err.message : "Listing draft regeneration failed",
        });
        return null;
      } finally {
        if (activeListingRef.current === generation) activeListingRef.current = null;
      }
    },
    [flow.runId, flow.analysis, flow.declutter, flow.items, confirmation, overridesById, listingApi, listingResult]
  );

  const regenerateListingDraft = useCallback(
    (itemId) => {
      // Synchronous caller-input validation, thrown -- matching
      // setDecisionOverride / correctLabel's "this is not a legitimate
      // target" convention. The "slot is busy" case is a silent no-op
      // inside performListingRegeneration instead.
      if (listingStatus !== "ready" || !listingResult) {
        throw new Error("regenerateListingDraft: there is no current listing result to regenerate from");
      }
      if (typeof itemId !== "string" || !listingResult.eligibleItemIds.includes(itemId)) {
        throw new Error(
          `regenerateListingDraft: ${JSON.stringify(itemId)} is not a currently eligible listing draft`
        );
      }
      return performListingRegeneration(itemId);
    },
    [listingStatus, listingResult, performListingRegeneration]
  );

  const editListingDraft = useCallback(
    (itemId, edit = {}) => {
      if (listingStatus !== "ready" || !listingResult) {
        throw new Error("editListingDraft: there is no current listing result to edit");
      }
      const draft = listingResult.drafts.find((d) => d.item_id === itemId);
      if (!draft) {
        throw new Error(`editListingDraft: ${JSON.stringify(itemId)} is not a current listing draft`);
      }
      if (draft.status !== "generated") {
        throw new Error(`editListingDraft: ${JSON.stringify(itemId)} has no draft text to edit`);
      }
      const { title, description } = edit;
      if (title !== undefined && typeof title !== "string") {
        throw new Error("editListingDraft: title must be a string");
      }
      if (description !== undefined && typeof description !== "string") {
        throw new Error("editListingDraft: description must be a string");
      }
      if (title === undefined && description === undefined) {
        throw new Error("editListingDraft: nothing to edit");
      }
      // Frontend only -- never a backend call. Stored VERBATIM: the
      // intermediate string states a controlled input produces are kept
      // exactly, never trimmed or coerced.
      setListingEditsById((prev) => {
        const base = prev[itemId] ?? { title: draft.title, description: draft.description };
        return {
          ...prev,
          [itemId]: {
            title: title === undefined ? base.title : title,
            description: description === undefined ? base.description : description,
          },
        };
      });
    },
    [listingStatus, listingResult]
  );

  const discardListingDraft = useCallback(
    (itemId) => {
      if (listingStatus !== "ready" || !listingResult) {
        throw new Error("discardListingDraft: there is no current listing result");
      }
      if (!listingResult.drafts.some((d) => d.item_id === itemId)) {
        throw new Error(`discardListingDraft: ${JSON.stringify(itemId)} is not a current listing draft`);
      }
      // Local presentation state ONLY: no API call, no confirmation
      // change, no decision/exclusion change, no other draft touched.
      setDiscardedListingIds((prev) => (prev[itemId] ? prev : { ...prev, [itemId]: true }));
    },
    [listingStatus, listingResult]
  );

  const restoreListingDraft = useCallback(
    (itemId) => {
      if (listingStatus !== "ready" || !listingResult) {
        throw new Error("restoreListingDraft: there is no current listing result");
      }
      if (!listingResult.drafts.some((d) => d.item_id === itemId)) {
        throw new Error(`restoreListingDraft: ${JSON.stringify(itemId)} is not a current listing draft`);
      }
      // Reverses ONLY the local discarded flag.
      setDiscardedListingIds((prev) => {
        if (!prev[itemId]) return prev;
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
    },
    [listingStatus, listingResult]
  );

  // Ordered draft collection with the local edit/discard overlay applied.
  // Order is exactly listingResult.drafts (confirmation / eligible-Sell
  // order). Identity stays item_id; server title/description are kept
  // alongside the editable values so a consumer can tell them apart.
  const listingDrafts = (listingResult?.drafts ?? []).map((draft) => {
    const edit = listingEditsById[draft.item_id];
    const serverTitle = draft.title ?? "";
    const serverDescription = draft.description ?? "";
    return {
      ...draft,
      edited_title: edit ? edit.title : serverTitle,
      edited_description: edit ? edit.description : serverDescription,
      is_edited: Boolean(edit) && (edit.title !== serverTitle || edit.description !== serverDescription),
      is_discarded: Boolean(discardedListingIds[draft.item_id]),
    };
  });

  // Deterministic full reset (R6, required correction 5): invalidates
  // ALL concurrency domains (any in-flight upload/correction, any
  // in-flight/completed confirmation, AND -- via invalidateConfirmation
  // chaining to invalidateListing -- any in-flight/completed listing
  // batch or regen) via the exact same refs the individual operations
  // already use, then clears every piece of state back to its initial
  // value, matching useReorganiseFlow's own reset() convention exactly.
  // useBothFlow composes this alongside its own generation-state reset.
  const reset = useCallback(() => {
    flowGenerationRef.current += 1; // invalidates any in-flight upload/correction write
    invalidateConfirmation(); // separate refs; also chains to invalidateListing()
    setStatus("idle");
    setError(null);
    setFlow(EMPTY_FLOW);
    setOverridesById({});
    setCorrectingItemId(null);
    setCorrectionError(null);
  }, [invalidateConfirmation]);

  return {
    status,
    runId: flow.runId,
    analysis: flow.analysis,
    declutter: flow.declutter,
    items: flow.items,
    inputImageSha256: flow.inputImageSha256 ?? null,
    error,
    submit,
    reset,
    reviewItems,
    overridesById,
    confirmation,
    confirmationStatus,
    confirmationError,
    setDecisionOverride,
    setItemExcluded,
    clearDecisionOverride,
    confirm,
    correctingItemId,
    correctionError,
    correctLabel,
    // Marketplace listing domain (Stage 3)
    listingStatus,
    listingResult,
    listingDrafts,
    listingError,
    regeneratingItemId,
    regenerationError,
    listingEditsById,
    discardedListingIds,
    generateListingDrafts,
    regenerateListingDraft,
    editListingDraft,
    discardListingDraft,
    restoreListingDraft,
    resetListing: invalidateListing,
  };
}
