import { useCallback, useMemo, useRef, useState } from "react";
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
  deriveEligibleSellItemIds,
  isListingCondition,
  listingDetailsMatch,
  resolveListingDetails,
  serialiseListingDetails,
} from "../lib/listingDrafts";
import {
  buildReviewItems,
  clearDecisionOverride as clearDecisionOverrideEntry,
  normaliseConfirmationResponse,
  serialiseDecisionOverrides,
  setDecisionOverride as setDecisionOverrideEntry,
  setItemExcluded as setItemExcludedEntry,
} from "../api/confirmationContract";

const ANALYSIS_ERROR = "We couldn't analyse your space.";
const LABEL_CORRECTION_ERROR = "We couldn't update that label.";
const CONFIRMATION_ERROR = "We couldn't confirm your decisions.";
const LISTING_GENERATION_ERROR = "We couldn't generate the listing drafts.";
const LISTING_REGENERATION_ERROR = "We couldn't regenerate that listing draft.";

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
  // listingPhase: the explicit batch/empty-result phase (idle | generating
  // | ready | error); the exported listingStatus is DERIVED from it and
  // the current confirmation below. listingCache: run-scoped drafts,
  // { [item_id]: { draft, generatedWith } }, kept across confirmation
  // changes so re-confirming never forces a new batch; cleared only by a
  // new upload or reset. listingProvenance: the run's model / prompt /
  // attempt budget, which every later single-item response must match.
  const [listingPhase, setListingPhase] = useState("idle");
  const [listingCache, setListingCache] = useState({});
  const [listingProvenance, setListingProvenance] = useState(null);
  const [listingError, setListingError] = useState(null);
  const [regeneratingItemId, setRegeneratingItemId] = useState(null);
  const [regenerationError, setRegenerationError] = useState(null);
  const [listingEditsById, setListingEditsById] = useState({});
  const [discardedListingIds, setDiscardedListingIds] = useState({});
  // Seller-supplied listing details per item_id ({ listing_name?, condition? },
  // explicit values only; defaults are resolved at read time from the
  // reviewed label) and, per drafted item, the details its current draft
  // was generated with. Details are listing metadata, not decisions: they
  // survive a confirmation invalidation and are cleared only by reset().
  // generated_with is cleared with the drafts it describes.
  const [listingDetailsById, setListingDetailsById] = useState({});

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

  // A confirmation change: any in-flight listing request is orphaned (the
  // bumped counter makes its late success or rejection write nothing) and
  // the transient phase/error state is reset, but the run's cached drafts,
  // edits, discards and seller details are KEPT, so re-confirming shows
  // them again for every item that is still a confirmed Sell item.
  const invalidateListing = useCallback(() => {
    listingGenerationRef.current += 1;
    activeListingRef.current = null;
    setListingPhase("idle");
    setListingError(null);
    setRegeneratingItemId(null);
    setRegenerationError(null);
  }, []);

  // A different photo (new upload) or Start over: everything listing-related
  // for the old run goes, including the cache, edits, discards and names.
  const clearListingCache = useCallback(() => {
    invalidateListing();
    setListingCache({});
    setListingProvenance(null);
    setListingEditsById({});
    setDiscardedListingIds({});
    setListingDetailsById({});
  }, [invalidateListing]);

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
      clearListingCache(); // a new photo is a new run: no draft, name or edit carries over

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
        setError(ANALYSIS_ERROR);
        setStatus("error");
      }
    },
    [invalidateConfirmation, clearListingCache, uploadPath, normaliseUploadResponse]
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

  // display_label is the ONE user-facing name per item_id shown on Decide
  // items, Confirm choices and Results: the name the person gave the item
  // on its listing, else the reasoning label (corrected or detected).
  // Setting it never calls /override, never reruns reasoning and never
  // changes a decision or the confirmation. effective_label stays the
  // label AI reasoning used; clean_label stays the detector's label.
  const reviewItems = buildReviewItems(flow.items, overridesById).map((item) => {
    const name = listingDetailsById[item.item_id]?.listing_name;
    const trimmed = typeof name === "string" ? name.trim() : "";
    return { ...item, display_label: trimmed !== "" ? trimmed : item.effective_label ?? item.clean_label };
  });

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
        setListingDetailsById((prev) => {
          if (!prev[itemId] || !("listing_name" in prev[itemId])) return prev;
          const rest = { ...prev[itemId] };
          delete rest.listing_name;
          return { ...prev, [itemId]: rest };
        });
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
        setCorrectionError({ itemId, message: LABEL_CORRECTION_ERROR });
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
    // Starting a fresh confirmation invalidates any in-flight listing
    // request and resets transient listing state. The current run's cache
    // is retained and filtered against the new confirmation on success.
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
      setConfirmationError(CONFIRMATION_ERROR);
      return null;
    }
  }, [correctingItemId, flow.declutter, flow.runId, overridesById, invalidateListing]);

  // -------------------------------------------------------------------------
  // Marketplace listing actions. Drafts live in a run-scoped cache keyed by
  // item_id (listingCache) that survives confirmation changes and is
  // cleared only by a new upload or reset. What is ACTIVE is always derived
  // from the current server confirmation: a cached draft is shown, edited,
  // copied or regenerated only while its item is a confirmed non-excluded
  // Sell item. Every request snapshots the exact runId / analysis /
  // declutter / confirmation / review items it is validated against BEFORE
  // awaiting, and every write-back checks listingGenerationRef, which any
  // confirmation change, upload or reset bumps, so a late response can
  // never write a draft for a confirmation that no longer exists.
  // -------------------------------------------------------------------------

  const hasCurrentConfirmation = confirmationStatus === "confirmed" && confirmation !== null;
  // Memoised so identities are stable across renders while nothing changed
  // (consumers and tests compare listingResult / drafts by identity).
  const eligibleListingIds = useMemo(
    () => (hasCurrentConfirmation ? deriveEligibleSellItemIds(confirmation) : []),
    [hasCurrentConfirmation, confirmation]
  );
  const activeListingIds = useMemo(
    () => eligibleListingIds.filter((id) => listingCache[id]),
    [eligibleListingIds, listingCache]
  );
  const missingListingItemIds = useMemo(
    () => eligibleListingIds.filter((id) => !listingCache[id]),
    [eligibleListingIds, listingCache]
  );

  // idle | generating | ready | error, as before. A confirmation whose Sell
  // items already have cached drafts is "ready" at once, with no request:
  // re-confirming never forces a new batch.
  let listingStatus;
  if (!hasCurrentConfirmation) listingStatus = "idle";
  else if (listingPhase === "generating") listingStatus = "generating";
  else if (activeListingIds.length > 0) listingStatus = "ready";
  else listingStatus = listingPhase;

  // Back-compatible aggregate view of the active drafts (the shape the
  // listing contract normalisers produce). Provenance is null exactly
  // when there are no active drafts, as the contract's empty shape says.
  const activeServerDrafts = useMemo(
    () => activeListingIds.map((id) => listingCache[id].draft),
    [activeListingIds, listingCache]
  );
  const listingResult = useMemo(
    () =>
      listingStatus === "ready"
        ? {
            runId: flow.runId,
            confirmation,
            eligibleItemIds: eligibleListingIds,
            drafts: activeServerDrafts,
            modelName: activeServerDrafts.length > 0 ? listingProvenance?.modelName ?? null : null,
            promptVersion: activeServerDrafts.length > 0 ? listingProvenance?.promptVersion ?? null : null,
            maxAttempts: activeServerDrafts.length > 0 ? listingProvenance?.maxAttempts ?? null : null,
          }
        : null,
    [listingStatus, flow.runId, confirmation, eligibleListingIds, activeServerDrafts, listingProvenance]
  );

  // What a draft is generated with: the serialised seller details plus
  // the reasoning label at that moment, so a later rename OR a later
  // Decide-items label correction both mark the draft as older.
  function generatedWithFor(serialised, reviewItem) {
    return {
      listing_name: serialised.listing_name,
      condition: serialised.condition,
      label: reviewItem?.effective_label ?? null,
    };
  }

  const provenanceMatches = (a, b) =>
    Boolean(a && b) && a.modelName === b.modelName && a.promptVersion === b.promptVersion && a.maxAttempts === b.maxAttempts;

  const generateListingDrafts = useCallback(async () => {
    // Never auto-runs; the Results screen's explicit button calls it.
    // Generates ONLY what is missing for the current confirmation:
    //   - nothing eligible  -> a ready empty result, no request;
    //   - every eligible item already drafted -> a no-op, no request;
    //   - nothing drafted yet -> one batch request, as before;
    //   - some drafted, some new -> one single-item request per NEW item
    //     (the single-item endpoint derives eligibility server-side and
    //     needs no prior draft), leaving every existing draft, edit,
    //     condition and discard untouched.
    if (confirmationStatus !== "confirmed" || !confirmation) return null;
    if (!flow.runId || !flow.analysis || !flow.declutter) return null;
    if (activeListingRef.current !== null) return null;

    const runId = flow.runId;
    const analysisSnapshot = flow.analysis;
    const declutterSnapshot = flow.declutter;
    const currentConfirmed = confirmation;
    const currentReviewItems = buildReviewItems(flow.items, overridesById);
    const reviewById = new Map(currentReviewItems.map((item) => [item.item_id, item]));

    const eligibleSellIds = deriveEligibleSellItemIds(currentConfirmed);
    if (eligibleSellIds.length === 0) {
      setListingError(null);
      setRegenerationError(null);
      setRegeneratingItemId(null);
      setListingPhase("ready");
      return {
        runId,
        confirmation: currentConfirmed,
        eligibleItemIds: [],
        drafts: [],
        modelName: null,
        promptVersion: null,
        maxAttempts: null,
      };
    }

    const missing = eligibleSellIds.filter((id) => !listingCache[id]);
    if (missing.length === 0) return null; // everything already drafted

    const generation = ++listingGenerationRef.current;
    activeListingRef.current = generation; // claim the slot for the round-trip(s)
    const overrides = serialiseDecisionOverrides(overridesById, declutterSnapshot.expected_item_ids);
    setListingError(null);
    setRegenerationError(null);

    // --- first drafts for this confirmation: one batch -------------------
    if (missing.length === eligibleSellIds.length) {
      const listingDetails = serialiseListingDetails(eligibleSellIds, listingDetailsById, currentReviewItems);
      setListingPhase("generating");
      try {
        const response = await listingApi.generateListings({
          runId,
          analysis: analysisSnapshot,
          declutter: declutterSnapshot,
          overrides,
          listingDetails,
        });
        const normalised = listingApi.normaliseListingResponse(response, {
          runId,
          sourceDeclutter: declutterSnapshot,
          currentConfirmed,
          currentReviewItems,
        });
        if (listingGenerationRef.current !== generation) {
          return null; // stale success: something newer already changed the confirmation
        }
        const detailsById = new Map(listingDetails.map((d) => [d.item_id, d]));
        setListingCache((prev) => {
          const next = { ...prev };
          for (const draft of normalised.drafts) {
            next[draft.item_id] = {
              draft,
              generatedWith: generatedWithFor(detailsById.get(draft.item_id), reviewById.get(draft.item_id)),
            };
          }
          return next;
        });
        setListingProvenance({
          modelName: normalised.modelName,
          promptVersion: normalised.promptVersion,
          maxAttempts: normalised.maxAttempts,
        });
        setListingPhase("ready");
        return normalised;
      } catch (err) {
        if (listingGenerationRef.current !== generation) {
          return null; // stale rejection discarded too -- no state change
        }
        setListingError(LISTING_GENERATION_ERROR);
        setListingPhase("error");
        return null;
      } finally {
        if (activeListingRef.current === generation) activeListingRef.current = null;
      }
    }

    // --- only the newly confirmed Sell items, one at a time --------------
    const provenanceSnapshot = listingProvenance;
    let generatedCount = 0;
    try {
      for (const itemId of missing) {
        const listingDetails = serialiseListingDetails([itemId], listingDetailsById, currentReviewItems);
        setRegeneratingItemId(itemId);
        let normalised;
        try {
          const response = await listingApi.regenerateListing({
            runId,
            analysis: analysisSnapshot,
            declutter: declutterSnapshot,
            overrides,
            itemId,
            listingDetails,
          });
          normalised = listingApi.normaliseSingleListingResponse(response, {
            runId,
            sourceDeclutter: declutterSnapshot,
            currentConfirmed,
            currentReviewItems,
            itemId,
          });
        } catch (err) {
          if (listingGenerationRef.current !== generation) return null;
          setListingError(LISTING_GENERATION_ERROR);
          return null;
        }
        if (listingGenerationRef.current !== generation) return null; // stale: write nothing
        if (!provenanceMatches(normalised, provenanceSnapshot)) {
          setListingError("Listing draft generation returned inconsistent provenance");
          return null;
        }
        setListingCache((prev) => ({
          ...prev,
          [itemId]: { draft: normalised.draft, generatedWith: generatedWithFor(listingDetails[0], reviewById.get(itemId)) },
        }));
        generatedCount += 1;
      }
      return { generatedItemIds: missing.slice(0, generatedCount) };
    } finally {
      if (listingGenerationRef.current === generation) setRegeneratingItemId(null);
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
    listingDetailsById,
    listingCache,
    listingProvenance,
  ]);

  const performListingRegeneration = useCallback(
    async (itemId) => {
      if (activeListingRef.current !== null) return null;

      const generation = ++listingGenerationRef.current;
      activeListingRef.current = generation;

      const runId = flow.runId;
      const analysisSnapshot = flow.analysis;
      const declutterSnapshot = flow.declutter;
      const currentConfirmed = confirmation;
      const currentReviewItems = buildReviewItems(flow.items, overridesById);
      const reviewById = new Map(currentReviewItems.map((item) => [item.item_id, item]));
      const overrides = serialiseDecisionOverrides(overridesById, declutterSnapshot.expected_item_ids);
      // The run's provenance must match the single response exactly, so a
      // merged view can never pair maxAttempts 3 with attempts 4.
      const provenanceSnapshot = listingProvenance;
      // The edit this regeneration may replace. If the person edits the
      // text again while the request is in flight, that NEWER edit is kept.
      const editSnapshot = listingEditsById[itemId];
      // Only the target's own current details travel with a regeneration.
      const listingDetails = serialiseListingDetails([itemId], listingDetailsById, currentReviewItems);

      setRegeneratingItemId(itemId);
      setRegenerationError(null);

      try {
        const response = await listingApi.regenerateListing({
          runId,
          analysis: analysisSnapshot,
          declutter: declutterSnapshot,
          overrides,
          itemId,
          listingDetails,
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
        if (!provenanceMatches(normalised, provenanceSnapshot)) {
          setRegeneratingItemId(null);
          setRegenerationError({
            itemId,
            message: "Listing draft regeneration returned inconsistent provenance",
          });
          return null;
        }
        setListingCache((prev) => ({
          ...prev,
          [itemId]: { draft: normalised.draft, generatedWith: generatedWithFor(listingDetails[0], reviewById.get(itemId)) },
        }));
        setListingEditsById((prev) => {
          if (!(itemId in prev) || prev[itemId] !== editSnapshot) return prev;
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
        setRegeneratingItemId(null);
        setRegenerationError({
          itemId,
          message: LISTING_REGENERATION_ERROR,
        });
        return null;
      } finally {
        if (activeListingRef.current === generation) activeListingRef.current = null;
      }
    },
    [
      flow.runId,
      flow.analysis,
      flow.declutter,
      flow.items,
      confirmation,
      overridesById,
      listingApi,
      listingProvenance,
      listingEditsById,
      listingDetailsById,
    ]
  );

  // Seller-supplied details for one item: a listing name and/or a declared
  // condition. The listing name is also the item's user-facing name on
  // Decide items, Confirm choices and Results (reviewItems[].display_label).
  // Frontend-only: never a backend call, never a decision, label-correction
  // or confirmation change, and never a change to existing draft text (a
  // draft made with older details is flagged is_stale; only an explicit
  // regeneration replaces it). Throws for a bad id or an invalid value.
  const setListingDetails = useCallback((itemId, patch) => {
    if (typeof itemId !== "string" || itemId.trim() === "") {
      throw new Error("setListingDetails: itemId must be a non-blank string");
    }
    if (!patch || typeof patch !== "object") {
      throw new Error("setListingDetails: patch must be an object");
    }
    const next = {};
    if ("listing_name" in patch) {
      if (typeof patch.listing_name !== "string") throw new Error("setListingDetails: listing_name must be a string");
      next.listing_name = patch.listing_name;
    }
    if ("condition" in patch) {
      if (!isListingCondition(patch.condition)) {
        throw new Error(`setListingDetails: unknown condition ${JSON.stringify(patch.condition)}`);
      }
      next.condition = patch.condition;
    }
    if (Object.keys(next).length === 0) throw new Error("setListingDetails: nothing to set");
    setListingDetailsById((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] ?? {}), ...next } }));
  }, []);

  const regenerateListingDraft = useCallback(
    (itemId) => {
      // Synchronous, fail-fast guards: only a currently eligible item of a
      // ready listing view may be regenerated. A cached draft for an item
      // that is no longer a confirmed Sell item is never reachable here.
      if (listingStatus !== "ready") {
        throw new Error("regenerateListingDraft: there is no current listing result to regenerate from");
      }
      if (typeof itemId !== "string" || !eligibleListingIds.includes(itemId)) {
        throw new Error(
          `regenerateListingDraft: ${JSON.stringify(itemId)} is not a currently eligible listing draft`
        );
      }
      return performListingRegeneration(itemId);
    },
    [listingStatus, eligibleListingIds, performListingRegeneration]
  );

  const editListingDraft = useCallback(
    (itemId, edit = {}) => {
      if (listingStatus !== "ready") {
        throw new Error("editListingDraft: there is no current listing result to edit");
      }
      const entry = activeListingIds.includes(itemId) ? listingCache[itemId] : null;
      if (!entry) {
        throw new Error(`editListingDraft: ${JSON.stringify(itemId)} is not a current listing draft`);
      }
      const draft = entry.draft;
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
    [listingStatus, activeListingIds, listingCache]
  );

  const discardListingDraft = useCallback(
    (itemId) => {
      if (listingStatus !== "ready") {
        throw new Error("discardListingDraft: there is no current listing result");
      }
      if (!activeListingIds.includes(itemId)) {
        throw new Error(`discardListingDraft: ${JSON.stringify(itemId)} is not a current listing draft`);
      }
      setDiscardedListingIds((prev) => (prev[itemId] ? prev : { ...prev, [itemId]: true }));
    },
    [listingStatus, activeListingIds]
  );

  const restoreListingDraft = useCallback(
    (itemId) => {
      if (listingStatus !== "ready") {
        throw new Error("restoreListingDraft: there is no current listing result");
      }
      if (!activeListingIds.includes(itemId)) {
        throw new Error(`restoreListingDraft: ${JSON.stringify(itemId)} is not a current listing draft`);
      }
      setDiscardedListingIds((prev) => {
        if (!prev[itemId]) return prev;
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
    },
    [listingStatus, activeListingIds]
  );

  // The active drafts, in confirmation (eligible-Sell) order. Identity is
  // item_id; server title/description are kept beside the editable values.
  // effective_label is the CURRENT reasoning label (it can differ from the
  // label the draft was written for after a Decide-items correction), and
  // is_stale says the draft was made with older details or an older label.
  const reviewItemsById = new Map(reviewItems.map((item) => [item.item_id, item]));
  const listingDrafts = activeListingIds.map((itemId) => {
    const { draft, generatedWith } = listingCache[itemId];
    const reviewItem = reviewItemsById.get(itemId);
    const edit = listingEditsById[itemId];
    const serverTitle = draft.title ?? "";
    const serverDescription = draft.description ?? "";
    const details = resolveListingDetails(itemId, listingDetailsById, reviewItem);
    const currentLabel = reviewItem?.effective_label ?? draft.effective_label;
    const labelChanged = generatedWith?.label != null && generatedWith.label !== currentLabel;
    return {
      ...draft,
      effective_label: currentLabel,
      edited_title: edit ? edit.title : serverTitle,
      edited_description: edit ? edit.description : serverDescription,
      is_edited: Boolean(edit) && (edit.title !== serverTitle || edit.description !== serverDescription),
      is_discarded: Boolean(discardedListingIds[itemId]),
      listing_name: details.listing_name,
      condition: details.condition,
      generated_with: generatedWith ?? null,
      is_stale:
        draft.status === "generated" &&
        generatedWith != null &&
        (labelChanged || !listingDetailsMatch(generatedWith, details)),
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
    clearListingCache();
  }, [invalidateConfirmation, clearListingCache]);

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
    listingDetailsById,
    setListingDetails,
    missingListingItemIds,
    generateListingDrafts,
    regenerateListingDraft,
    editListingDraft,
    discardListingDraft,
    restoreListingDraft,
    resetListing: invalidateListing,
  };
}
