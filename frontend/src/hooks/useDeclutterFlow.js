import { useCallback, useRef, useState } from "react";
import { confirmDecisions, uploadImage } from "../api/client";
import { normaliseDeclutterUploadResponse } from "../api/declutterContract";
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
// POST /upload and POST /confirm are both implemented — see
// app/api/routes.py, app/services/declutter_service.py and
// app/services/confirmation_service.py. Their nested responses are
// passed through normaliseDeclutterUploadResponse()/
// normaliseConfirmationResponse() (api/declutterContract.js,
// api/confirmationContract.js), which join by item_id and throw on a
// malformed contract rather than silently returning empty output.
//
// There is no `override` method here (there was, briefly, calling the
// still-unimplemented /override label-correction endpoint — removed: it
// had zero real consumers, and reusing that name for a *decision*
// override would have been actively misleading — decision overrides go
// through setDecisionOverride()/confirm() below, never /override).
// client.js's overrideItem() is left untouched for that future task.
//
// No React Testing Library is installed in this project, so the
// concurrency guard below (confirmGenerationRef) is unit-tested only at
// the pure-helper level (confirmationContract.test.js) — it is NOT
// exercised by a rendered-hook test here. Treat it as reviewed-by-
// inspection, not test-proven, until RTL (or an equivalent) is added.

const EMPTY_FLOW = { runId: null, analysis: null, declutter: null, items: [] };

export function useDeclutterFlow() {
  const [status, setStatus] = useState("idle"); // idle | uploading | ready | error
  const [flow, setFlow] = useState(EMPTY_FLOW);
  const [error, setError] = useState(null);

  const [overridesById, setOverridesById] = useState({});
  const [confirmation, setConfirmation] = useState(null);
  const [confirmationStatus, setConfirmationStatus] = useState("idle"); // idle | confirming | confirmed | error
  const [confirmationError, setConfirmationError] = useState(null);

  // Bumped by: a new upload starting, every override edit/clear, and
  // every confirm() invocation itself. A confirm() call captures the
  // post-bump value as its own "generation" — when its request resolves,
  // it's only allowed to touch confirmation/confirmationStatus/
  // confirmationError if this ref still holds that exact value, i.e. no
  // newer upload/edit/confirm has started in the meantime. This is what
  // prevents a stale in-flight response (superseded by a later edit or a
  // newer confirm() call) from clobbering fresher state after the fact.
  const confirmGenerationRef = useRef(0);

  const invalidatePreviousConfirmation = useCallback(() => {
    confirmGenerationRef.current += 1;
    setConfirmation(null);
    setConfirmationStatus("idle");
    setConfirmationError(null);
  }, []);

  const submit = useCallback(
    async ({ file, context }) => {
      setStatus("uploading");
      setError(null);
      setFlow(EMPTY_FLOW); // clear the previous result before a new upload starts
      setOverridesById({});
      invalidatePreviousConfirmation(); // also invalidates any outstanding confirm() request

      try {
        const response = await uploadImage({ file, path: "declutter", context });
        setFlow(normaliseDeclutterUploadResponse(response));
        setStatus("ready");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Declutter upload failed");
        setStatus("error");
      }
    },
    [invalidatePreviousConfirmation]
  );

  // An item is reviewable only if it's a real *resolved* expected item —
  // never a contextual detection (not in expected_item_ids) and never
  // an unresolved one (still_invalid, no AiDecision to override yet).
  const isReviewableItemId = useCallback(
    (itemId) => {
      const expectedItemIds = flow.declutter?.expected_item_ids ?? [];
      const unresolvedItemIds = flow.declutter?.unresolved_item_ids ?? [];
      return expectedItemIds.includes(itemId) && !unresolvedItemIds.includes(itemId);
    },
    [flow.declutter]
  );

  const setDecisionOverride = useCallback(
    // userReason defaults to undefined here too (not null) — see
    // api/confirmationContract.js's setDecisionOverride for the full
    // omitted-vs-null-vs-blank semantics; omitting it entirely preserves
    // whatever reason text the user already entered for this item.
    (itemId, decision, userReason = undefined) => {
      if (!isReviewableItemId(itemId)) {
        throw new Error(`setDecisionOverride: ${JSON.stringify(itemId)} is not a resolved expected item`);
      }
      setOverridesById((prev) => setDecisionOverrideEntry(prev, itemId, decision, userReason));
      invalidatePreviousConfirmation();
    },
    [isReviewableItemId, invalidatePreviousConfirmation]
  );

  const setItemExcluded = useCallback(
    (itemId, excluded) => {
      if (!isReviewableItemId(itemId)) {
        throw new Error(`setItemExcluded: ${JSON.stringify(itemId)} is not a resolved expected item`);
      }
      setOverridesById((prev) => setItemExcludedEntry(prev, itemId, excluded));
      invalidatePreviousConfirmation();
    },
    [isReviewableItemId, invalidatePreviousConfirmation]
  );

  const clearDecisionOverride = useCallback(
    (itemId) => {
      if (!isReviewableItemId(itemId)) {
        throw new Error(`clearDecisionOverride: ${JSON.stringify(itemId)} is not a resolved expected item`);
      }
      setOverridesById((prev) => clearDecisionOverrideEntry(prev, itemId));
      invalidatePreviousConfirmation();
    },
    [isReviewableItemId, invalidatePreviousConfirmation]
  );

  const reviewItems = buildReviewItems(flow.items, overridesById);

  const confirm = useCallback(async () => {
    // Returns the normalized ConfirmationResult on success, or null on
    // any failure/no-op/staleness — never rethrows. Callers that need to
    // react to failure should read confirmationStatus/confirmationError;
    // a stale response makes NO state changes at all (not even setting
    // an error), since by definition something newer has already
    // superseded it.
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
    // runId/DeclutterResult this request will use and validate against —
    // before awaiting, so a later edit or a newer confirm() call can
    // never retroactively change what THIS request is judged by.
    const generation = ++confirmGenerationRef.current;
    const runId = flow.runId;
    const declutterSnapshot = flow.declutter;

    setConfirmationStatus("confirming");
    setConfirmationError(null);

    try {
      const overrides = serialiseDecisionOverrides(overridesById, declutterSnapshot.expected_item_ids);
      const response = await confirmDecisions({ runId, declutter: declutterSnapshot, overrides });
      const normalised = normaliseConfirmationResponse(response, declutterSnapshot);

      if (confirmGenerationRef.current !== generation) {
        return null; // superseded by a newer upload/edit/confirm() — discard silently
      }
      setConfirmation(normalised);
      setConfirmationStatus("confirmed");
      return normalised;
    } catch (err) {
      if (confirmGenerationRef.current !== generation) {
        return null; // same staleness guard on the failure path
      }
      // Declutter analysis/items and the user's overridesById are
      // deliberately left untouched here — a failed confirmation must
      // never erase review work already done.
      setConfirmationStatus("error");
      setConfirmationError(err instanceof Error ? err.message : "Decision confirmation failed");
      return null;
    }
  }, [flow.declutter, flow.runId, overridesById]);

  return {
    status,
    runId: flow.runId,
    analysis: flow.analysis,
    declutter: flow.declutter,
    items: flow.items,
    error,
    submit,
    reviewItems,
    overridesById,
    confirmation,
    confirmationStatus,
    confirmationError,
    setDecisionOverride,
    setItemExcluded,
    clearDecisionOverride,
    confirm,
  };
}
