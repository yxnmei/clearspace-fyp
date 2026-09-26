import { useCallback, useRef, useState } from "react";
import { generateConfirmedReorganisation } from "../api/client";
import { normaliseBothUploadResponse } from "../api/declutterContract";
import { serialiseDecisionOverrides } from "../api/confirmationContract";
import { normaliseConfirmedGenerateResponse } from "../api/reorganiseContract";
import { useDeclutterFlow } from "./useDeclutterFlow";

const TIDY_PLAN_ERROR = "We couldn't create your tidy plan.";

// The Both workflow state machine COMPOSES useDeclutterFlow rather than
// copying it: declutter/review/confirm is
// exactly Declutter's own hook, configured to hit path="both" and
// normaliseBothUploadResponse instead of path="declutter" and
// normaliseDeclutterUploadResponse. Everything upload/review/correction/
// confirmation-related below is a thin WRAPPER around the composed
// hook's own functions, it never reimplements their logic, only adds
// the one thing Both needs on top: invalidating this hook's own
// generation state whenever something the composed hook does could make
// a prior generation stale.
//
// Three independent concurrency domains, matching the project's
// established rule (see useDeclutterFlow's own extensive comment on why
// a single shared ref caused a real stuck-state bug there, the same
// lesson applies one layer further here):
//   1. Flow domain (flowGenerationRef), owned entirely by the composed
//      useDeclutterFlow, untouched by this hook.
//   2. Confirmation domain (confirmationGenerationRef), likewise owned
//      entirely by the composed hook.
//   3. Generation domain (generateGenerationRef + activeGenerationRef
//      ownership token, below), owned by THIS hook, mirroring
//      useReorganiseFlow's own exact two-part pattern (a monotonic
//      counter for "is this response still current" plus an ownership
//      token for "is a generation currently in flight", so a fast
//      double-click on Continue can never dispatch two /generate/confirmed
//      requests at once, and reset()/a new upload releases the slot
//      immediately rather than waiting for a stale request to settle).
//
// Every composed-hook operation that can change what confirmation MEANT
// (a new upload, a label correction, a decision/exclusion change, an
// override cleared, or a fresh confirm() itself) invalidates the
// generation domain here too, wrapped, not reimplemented: each wrapper
// below calls the composed hook's real function first (preserving its
// existing synchronous validation/throw behavior exactly, e.g.
// correctLabel/setDecisionOverride still throw synchronously for an
// invalid item_id, before this wrapper's own invalidateGeneration() ever
// runs), then invalidates generation as a second, separate step.
export function useBothFlow({ listingApi } = {}) {
  // The marketplace listing domain lives ENTIRELY in the
  // composed useDeclutterFlow -- its state, actions and concurrency slot
  // all flow out through the `...declutter` spread below, unwrapped.
  // useBothFlow only passes the `listingApi` injection seam straight
  // through (when omitted, useDeclutterFlow uses its own default), and
  // adds nothing: listing operations must NOT touch Reorganise state,
  // while the composed hook invalidates listing state internally when
  // confirmation meaning changes. The wrappers below separately
  // invalidate Reorganise generation state.
  const declutter = useDeclutterFlow({
    uploadPath: "both",
    normaliseUploadResponse: normaliseBothUploadResponse,
    listingApi,
  });

  // file/context are retained here (unlike useDeclutterFlow, which never
  // needs the image again after upload), POST /generate/confirmed must
  // resubmit the original image bytes; no server-side storage exists
  // anywhere in this codebase by design. Mirrors useReorganiseFlow's own
  // retention convention (captured in the hook, not just at the page
  // level like DeclutterPage's submittedFile).
  const [file, setFile] = useState(null);
  const [context, setContext] = useState(null);

  const [generationStatus, setGenerationStatus] = useState("idle"); // idle | generating | done | error
  const [generateResult, setGenerateResult] = useState(null);
  const [generateError, setGenerateError] = useState(null);

  const generateGenerationRef = useRef(0);
  const activeGenerationRef = useRef(null);

  const invalidateGeneration = useCallback(() => {
    generateGenerationRef.current += 1;
    activeGenerationRef.current = null; // release the slot now, do not wait for a stale request to settle
    setGenerationStatus("idle");
    setGenerateResult(null);
    setGenerateError(null);
  }, []);

  const submit = useCallback(
    async ({ file: nextFile, context: nextContext }) => {
      invalidateGeneration(); // a new upload invalidates any outstanding/completed generation too
      setFile(nextFile); // captured immediately, mirroring useReorganiseFlow's own submit()
      setContext(nextContext ?? null);
      return declutter.submit({ file: nextFile, context: nextContext });
    },
    [declutter.submit, invalidateGeneration]
  );

  const setDecisionOverride = useCallback(
    (...args) => {
      declutter.setDecisionOverride(...args); // throws synchronously on an invalid item_id, propagates before invalidateGeneration runs
      invalidateGeneration();
    },
    [declutter.setDecisionOverride, invalidateGeneration]
  );

  const setItemExcluded = useCallback(
    (...args) => {
      declutter.setItemExcluded(...args);
      invalidateGeneration();
    },
    [declutter.setItemExcluded, invalidateGeneration]
  );

  const clearDecisionOverride = useCallback(
    (...args) => {
      declutter.clearDecisionOverride(...args);
      invalidateGeneration();
    },
    [declutter.clearDecisionOverride, invalidateGeneration]
  );

  const correctLabel = useCallback(
    (...args) => {
      // declutter.correctLabel is itself a synchronous-validating wrapper
      // (see useDeclutterFlow's own docstring), an invalid itemId/blank
      // label throws HERE, synchronously, before invalidateGeneration()
      // ever runs, preserving that exact contract for callers of this
      // wrapper too. A validated call returns a promise; generation is
      // invalidated the moment the correction actually STARTS (matching
      // how useDeclutterFlow itself invalidates confirmation at the same
      // point), not when it later resolves.
      const result = declutter.correctLabel(...args);
      invalidateGeneration();
      return result;
    },
    [declutter.correctLabel, invalidateGeneration]
  );

  const confirm = useCallback(async () => {
    invalidateGeneration(); // a fresh confirmation invalidates any prior generation/handoff
    return declutter.confirm();
  }, [declutter.confirm, invalidateGeneration]);

  const generate = useCallback(async () => {
    // Silent no-op guards, mirroring useReorganiseFlow.generate()'s own
    // convention, a duplicate /generate/confirmed dispatch is expensive
    // (a real remote image-generation call), so this
    // hook stays safe even if the disabled-button UI is ever bypassed.
    if (declutter.confirmationStatus !== "confirmed") return null;
    if (!declutter.confirmation || declutter.confirmation.confirmedKeepIds.length === 0) return null; // empty Keep never reaches the network
    if (!declutter.runId || !declutter.analysis || !declutter.declutter || !declutter.inputImageSha256 || !file) {
      return null;
    }
    if (activeGenerationRef.current !== null) return null; // another generation currently owns the slot

    generateGenerationRef.current += 1;
    const generation = generateGenerationRef.current;
    activeGenerationRef.current = generation; // claim the slot

    const runIdSnapshot = declutter.runId;
    const analysisSnapshot = declutter.analysis;
    const declutterSnapshot = declutter.declutter;
    const overridesSnapshot = serialiseDecisionOverrides(declutter.overridesById, declutter.declutter.expected_item_ids);
    const inputImageSha256Snapshot = declutter.inputImageSha256;
    const fileSnapshot = file;
    const contextSnapshot = context;
    const priorConfirmedKeepIdsSnapshot = declutter.confirmation.confirmedKeepIds;

    setGenerationStatus("generating");
    setGenerateError(null);

    try {
      const response = await generateConfirmedReorganisation({
        runId: runIdSnapshot,
        analysis: analysisSnapshot,
        declutter: declutterSnapshot,
        overrides: overridesSnapshot,
        file: fileSnapshot,
        inputImageSha256: inputImageSha256Snapshot,
        userContext: contextSnapshot,
      });
      const normalised = normaliseConfirmedGenerateResponse(response, {
        runId: runIdSnapshot,
        sourceDeclutter: declutterSnapshot,
        priorConfirmedKeepIds: priorConfirmedKeepIdsSnapshot,
        inputImageSha256: inputImageSha256Snapshot,
      });

      if (generateGenerationRef.current !== generation) {
        return null; // superseded by a newer submit()/edit/confirm()/reset(), discard silently
      }
      setGenerateResult(normalised);
      setGenerationStatus("done");
      return normalised;
    } catch (err) {
      if (generateGenerationRef.current !== generation) {
        return null; // a stale REJECTION is discarded too, not only a stale success
      }
      // declutter's own review/confirmation state, file, context, and
      // overrides are deliberately left untouched here, a failed
      // generate() must never erase confirmed work already done, so a
      // retry can call generate() again immediately without re-confirming.
      setGenerateError(TIDY_PLAN_ERROR);
      setGenerationStatus("error");
      return null;
    } finally {
      // Release the slot ONLY if this call still owns it, a stale call
      // settling after a NEWER generate() (or a reset()) has already
      // claimed/released the slot must never clobber that newer state.
      if (activeGenerationRef.current === generation) {
        activeGenerationRef.current = null;
      }
    }
  }, [
    declutter.confirmationStatus,
    declutter.confirmation,
    declutter.runId,
    declutter.analysis,
    declutter.declutter,
    declutter.overridesById,
    declutter.inputImageSha256,
    file,
    context,
  ]);

  const reset = useCallback(() => {
    invalidateGeneration();
    setFile(null); // useObjectUrl(file) at the page level revokes the outstanding URL via its own tested effect
    setContext(null);
    declutter.reset();
  }, [declutter.reset, invalidateGeneration]);

  return {
    ...declutter,
    file,
    context,
    setDecisionOverride,
    setItemExcluded,
    clearDecisionOverride,
    correctLabel,
    confirm,
    submit,
    reset,
    generationStatus,
    generateResult,
    generateError,
    generate,
  };
}
