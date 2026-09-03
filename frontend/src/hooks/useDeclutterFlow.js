import { useCallback, useRef, useState } from "react";
import { confirmDecisions, overrideItem, uploadImage } from "../api/client";
import { normaliseDeclutterUploadResponse, normaliseOverrideResponse } from "../api/declutterContract";
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

export function useDeclutterFlow({
  uploadPath = "declutter",
  normaliseUploadResponse = normaliseDeclutterUploadResponse,
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

  const invalidateConfirmation = useCallback(() => {
    confirmationGenerationRef.current += 1;
    setConfirmation(null);
    setConfirmationStatus("idle");
    setConfirmationError(null);
  }, []);

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
    // while correctingItemId is set (see DeclutterReview), so reaching
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
  }, [correctingItemId, flow.declutter, flow.runId, overridesById]);

  // Deterministic full reset (R6, required correction 5): invalidates
  // BOTH concurrency domains (any in-flight upload/correction AND any
  // in-flight/completed confirmation) via the exact same refs
  // submit()/invalidateConfirmation() already use, then clears every
  // piece of state back to its initial value, matching
  // useReorganiseFlow's own reset() convention exactly. No existing
  // caller invokes this today (DeclutterPage has no "start over"
  // concept), so this is purely additive; useBothFlow (R6) is the first
  // caller, composing this alongside its own generation-state reset.
  const reset = useCallback(() => {
    flowGenerationRef.current += 1; // invalidates any in-flight upload/correction write
    invalidateConfirmation(); // separate ref, invalidates any in-flight/completed confirm()
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
  };
}
