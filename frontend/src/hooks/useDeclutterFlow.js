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

// Both composes this hook with a different upload path and normaliser.
// Responses are strictly normalised and joined only by item_id.
const EMPTY_FLOW = { runId: null, analysis: null, declutter: null, items: [], context: null, inputImageSha256: null };

// Injectable as one surface so tests can replace listing I/O and validation.
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
  const [status, setStatus] = useState("idle");
  const [flow, setFlow] = useState(EMPTY_FLOW);
  const [error, setError] = useState(null);

  const [overridesById, setOverridesById] = useState({});
  const [confirmation, setConfirmation] = useState(null);
  const [confirmationStatus, setConfirmationStatus] = useState("idle");
  const [confirmationError, setConfirmationError] = useState(null);

  // Correction state is item-scoped so errors stay with the matching card.
  const [correctingItemId, setCorrectingItemId] = useState(null);
  const [correctionError, setCorrectionError] = useState(null);

  // Listing state is independent of upload, confirmation and Both's
  // Reorganise state. The item_id-keyed cache survives reconfirmation and
  // is cleared only for a new upload or reset.
  const [listingPhase, setListingPhase] = useState("idle");
  const [listingCache, setListingCache] = useState({});
  const [listingProvenance, setListingProvenance] = useState(null);
  const [listingError, setListingError] = useState(null);
  const [regeneratingItemId, setRegeneratingItemId] = useState(null);
  const [regenerationError, setRegenerationError] = useState(null);
  const [listingEditsById, setListingEditsById] = useState({});
  const [discardedListingIds, setDiscardedListingIds] = useState({});
  // Seller details are item_id-keyed metadata, not decisions. They survive
  // confirmation invalidation; defaults are resolved from the reviewed label.
  const [listingDetailsById, setListingDetailsById] = useState({});

  // Separate counters protect flow replacements and confirmations.
  // submit and correction bump both; decision edits bump only confirmation.
  // Both success and rejection paths must match the captured counter.
  // Same-item correction re-entry supersedes the older call; a different
  // item is blocked because each response replaces the complete snapshot.
  const flowGenerationRef = useRef(0);
  const confirmationGenerationRef = useRef(0);

  // Listing uses its own staleness counter and active-owner token. One batch
  // or regeneration owns the slot; invalidation releases it immediately,
  // while the counter blocks both late success and late rejection writes.
  const listingGenerationRef = useRef(0);
  const activeListingRef = useRef(null);

  // Reconfirmation keeps cached drafts, edits, discards and seller details.
  const invalidateListing = useCallback(() => {
    listingGenerationRef.current += 1;
    activeListingRef.current = null;
    setListingPhase("idle");
    setListingError(null);
    setRegeneratingItemId(null);
    setRegenerationError(null);
  }, []);

  // A new photo or reset clears all run-scoped listing data.
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
    // Anything that changes confirmation meaning also invalidates listings.
    invalidateListing();
  }, [invalidateListing]);

  const submit = useCallback(
    async ({ file, context }) => {
      flowGenerationRef.current += 1;
      const generation = flowGenerationRef.current;
      invalidateConfirmation();
      clearListingCache();

      setStatus("uploading");
      setError(null);
      setFlow(EMPTY_FLOW);
      setOverridesById({});
      setCorrectingItemId(null);
      setCorrectionError(null);

      try {
        const response = await uploadImage({ file, path: uploadPath, context });
        const normalised = normaliseUploadResponse(response);

        if (flowGenerationRef.current !== generation) {
          return;
        }
        setFlow({ ...normalised, context });
        setStatus("ready");
      } catch (err) {
        if (flowGenerationRef.current !== generation) {
          return;
        }
        setError(ANALYSIS_ERROR);
        setStatus("error");
      }
    },
    [invalidateConfirmation, clearListingCache, uploadPath, normaliseUploadResponse]
  );

  // Only resolved expected items can receive decision overrides.
  const isReviewableItemId = useCallback(
    (itemId) => {
      const expectedItemIds = flow.declutter?.expected_item_ids ?? [];
      const unresolvedItemIds = flow.declutter?.unresolved_item_ids ?? [];
      return expectedItemIds.includes(itemId) && !unresolvedItemIds.includes(itemId);
    },
    [flow.declutter]
  );

  // Label correction also accepts unresolved expected items, never contextual ones.
  const isCorrectableItemId = useCallback(
    (itemId) => (flow.declutter?.expected_item_ids ?? []).includes(itemId),
    [flow.declutter]
  );

  const setDecisionOverride = useCallback(
    // undefined preserves the item's existing reason; null clears it.
    (itemId, decision, userReason = undefined) => {
      if (!isReviewableItemId(itemId)) {
        throw new Error(`setDecisionOverride: ${JSON.stringify(itemId)} is not a resolved expected item`);
      }
      setOverridesById((prev) => setDecisionOverrideEntry(prev, itemId, decision, userReason));
      invalidateConfirmation();
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

  // item_id is the only identity. clean_label is detector output,
  // effective_label is used for reasoning, and display_label is the
  // listing name or effective label shown to the user.
  const reviewItems = buildReviewItems(flow.items, overridesById).map((item) => {
    const name = listingDetailsById[item.item_id]?.listing_name;
    const trimmed = typeof name === "string" ? name.trim() : "";
    return { ...item, display_label: trimmed !== "" ? trimmed : item.effective_label ?? item.clean_label };
  });

  // A non-async wrapper preserves synchronous validation errors.
  const performCorrection = useCallback(
    async (itemId, trimmedLabel) => {
      // Same-item re-entry supersedes; a different in-flight item blocks.
      if (correctingItemId !== null && correctingItemId !== itemId) {
        return null;
      }
      if (!flow.analysis || !flow.declutter) {
        return null;
      }

      flowGenerationRef.current += 1;
      const generation = flowGenerationRef.current;
      invalidateConfirmation();
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
          return null;
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
          return null;
        }
        // A failed correction preserves analysis and review work.
        setCorrectingItemId(null);
        setCorrectionError({ itemId, message: LABEL_CORRECTION_ERROR });
        return null;
      }
    },
    [correctingItemId, flow.analysis, flow.declutter, flow.runId, flow.context, invalidateConfirmation]
  );

  const correctLabel = useCallback(
    // Invalid targets throw synchronously; transient contention is a no-op.
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
    // Returns the normalised result or null. Correction contention and stale
    // responses are state-neutral; callers read status/error for failures.
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

    // Snapshot the request and guard it with the confirmation counter.
    const generation = ++confirmationGenerationRef.current;
    // Reconfirmation invalidates listing requests but retains the cache.
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
        return null;
      }
      setConfirmation(normalised);
      setConfirmationStatus("confirmed");
      return normalised;
    } catch (err) {
      if (confirmationGenerationRef.current !== generation) {
        return null;
      }
      // A failed confirmation preserves analysis and review work.
      setConfirmationStatus("error");
      setConfirmationError(CONFIRMATION_ERROR);
      return null;
    }
  }, [correctingItemId, flow.declutter, flow.runId, overridesById, invalidateListing]);

  // Active drafts are derived from the current server confirmation. Requests
  // snapshot their validation inputs and guard every write with the listing
  // counter; the item_id-keyed cache itself survives reconfirmation.

  const hasCurrentConfirmation = confirmationStatus === "confirmed" && confirmation !== null;
  // Preserve result identity while inputs are unchanged.
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

  // Cached eligible drafts make a reconfirmed result ready without a request.
  let listingStatus;
  if (!hasCurrentConfirmation) listingStatus = "idle";
  else if (listingPhase === "generating") listingStatus = "generating";
  else if (activeListingIds.length > 0) listingStatus = "ready";
  else listingStatus = listingPhase;

  // Provenance is null exactly when the active result has no drafts.
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

  // Capture details and reasoning label so later changes mark a draft stale.
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
    // Explicitly generates only missing eligible drafts. An empty eligible
    // set or a fully cached set never reaches the network.
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
    if (missing.length === 0) return null;

    const generation = ++listingGenerationRef.current;
    activeListingRef.current = generation;
    const overrides = serialiseDecisionOverrides(overridesById, declutterSnapshot.expected_item_ids);
    setListingError(null);
    setRegenerationError(null);

    // First drafts use one batch request.
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
          return null;
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
          return null;
        }
        setListingError(LISTING_GENERATION_ERROR);
        setListingPhase("error");
        return null;
      } finally {
        if (activeListingRef.current === generation) activeListingRef.current = null;
      }
    }

    // Newly eligible items are generated individually without replacing cache.
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
        if (listingGenerationRef.current !== generation) return null;
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
      // Regeneration must match the batch provenance snapshot exactly.
      const provenanceSnapshot = listingProvenance;
      // Preserve edits made after regeneration starts.
      const editSnapshot = listingEditsById[itemId];
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
          return null;
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
          return null;
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

  // Seller details are frontend metadata. Existing text changes only through
  // explicit regeneration; older drafts are marked stale.
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
      // Only currently eligible drafts in a ready result can regenerate.
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
      // Store controlled-input edits verbatim; this makes no backend call.
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

  // Active drafts follow confirmed Sell order and use item_id identity.
  // effective_label is current reasoning text; is_stale compares it and
  // seller details with the generation snapshot.
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

  // Reset invalidates every concurrency domain before clearing state.
  const reset = useCallback(() => {
    flowGenerationRef.current += 1;
    invalidateConfirmation();
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
