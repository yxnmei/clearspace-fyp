import { useCallback, useRef, useState } from "react";
import { generateReorganisation, uploadImage } from "../api/client";
import { normaliseGenerateResponse, normaliseReorganiseUploadResponse } from "../api/reorganiseContract";

// Dedicated Direct Reorganise state machine, a SEPARATE hook from
// useDeclutterFlow rather than branches added to it, matching this
// project's existing per-workflow-hook convention. Reuses the same
// generation-counter concurrency pattern useDeclutterFlow already proved
// out (and the same lesson it records: separate counters for separate
// "things that can be superseded", never one shared ref for two
// unrelated operations).
//
// Five explicit phases, deliberately no standalone "error" phase.
// Recoverable errors are represented as a side field on the phase they
// belong to instead:
//   "upload"    , the upload form is shown; uploadError is set here
//                  after a failed upload attempt (the form/file/context
//                  the user already entered are still usable, see
//                  submit()'s own docstring for why analysis is always
//                  cleared first, never left stale).
//   "analysing" , POST /upload (path="reorganise") in flight.
//   "selecting" , a validated analysis exists; the user is choosing
//                  items, or a previous /generate attempt failed
//                  (generateError set here) and the file/analysis/
//                  selection are all still intact for an immediate retry.
//   "generating", POST /generate in flight.
//   "result"    , POST /generate succeeded (HTTP 200), this covers
//                  BOTH image_status "generated" and "unavailable": a
//                  plan-preserving unavailable result is a SUCCESSFUL
//                  outcome, never routed through generateError/"selecting".
//
// `file` is retained for the WHOLE flow (unlike useDeclutterFlow, which
// never needs the image again after upload), POST /generate must
// resubmit the original image bytes. The object-URL lifecycle for
// displaying it is NOT owned here, see useObjectUrl, composed at the
// page level against this hook's own `file` field, exactly like
// DeclutterPage composes useObjectUrl against its own captured
// submittedFile.
const INITIAL_UPLOAD_STATE = {
  runId: null,
  analysis: null,
  inputImageSha256: null,
  selectedItemIds: [],
};

export function useReorganiseFlow() {
  const [phase, setPhase] = useState("upload");
  const [file, setFile] = useState(null);
  const [context, setContext] = useState(null);

  const [uploadState, setUploadState] = useState(INITIAL_UPLOAD_STATE);
  const [uploadError, setUploadError] = useState(null);

  const [generateResult, setGenerateResult] = useState(null);
  const [generateError, setGenerateError] = useState(null);

  // Two SEPARATE concurrency domains, see module docstring and
  // useDeclutterFlow's own extensive comment on why a single shared ref
  // caused a real stuck-state bug there.
  //
  // uploadGenerationRef: protects writes to file/context/uploadState,
  // bumped only by submit() and reset(), the two operations that replace
  // those fields. A response is only applied if this ref still holds the
  // exact value claimed before that call's own await.
  //
  // generateGenerationRef: protects generateResult/generateError/the
  // "generating" -> "result"/"selecting" transition, bumped by
  // generate() (its own claim), and by submit()/reset() (a new upload or
  // a full reset invalidates any in-flight generate() call's eventual
  // write, exactly like invalidateConfirmation() does for
  // useDeclutterFlow's confirm()). A stale generate() response, success
  // OR rejection, is discarded by this ref alone, never by
  // uploadGenerationRef, so an unrelated upload elsewhere can't make an
  // in-flight generate() call spuriously "still current" or vice versa.
  const uploadGenerationRef = useRef(0);
  const generateGenerationRef = useRef(0);
  // Ownership token for the "one generate() in flight at a time" rule,
  // NOT a plain boolean (a prior version used `isGeneratingRef = useRef(false)`,
  // which had a real bug: it was reset to false only in generate()'s own
  // `finally`, so a stale, still-in-flight generation held the "busy"
  // flag hostage even after submit()/reset() had already moved the whole
  // flow on to a brand-new upload, a legitimate NEW generate() call
  // would be wrongly blocked waiting for a request nobody cares about
  // anymore. activeGenerationRef instead holds the specific generation ID
  // that currently owns the slot, or null when the slot is free:
  //   - generate() checks it synchronously (no dependency on React's
  //     render cycle, two back-to-back synchronous generate() calls,
  //     e.g. a fast double-click, both read the same `phase` state,
  //     since the first call's setPhase("generating") hasn't flushed yet;
  //     only a synchronous ref check can catch the second call in time).
  //   - submit()/reset() RELEASE it immediately (set back to null) as
  //     part of invalidateGeneration() below, a new flow never has to
  //     wait for a superseded request to actually settle.
  //   - generate()'s own `finally` clears it ONLY if it still holds that
  //     exact call's generation ID, a stale call settling after a NEWER
  //     one has already claimed the slot must never clobber that newer
  //     claim's ownership.
  const activeGenerationRef = useRef(null);

  const invalidateGeneration = useCallback(() => {
    generateGenerationRef.current += 1;
    activeGenerationRef.current = null; // release the slot now, do not wait for the stale request to settle
    setGenerateResult(null);
    setGenerateError(null);
  }, []);

  const submit = useCallback(
    async ({ file: nextFile, context: nextContext }) => {
      uploadGenerationRef.current += 1; // invalidates a previous/in-flight upload's pending write
      const generation = uploadGenerationRef.current;
      invalidateGeneration(); // a new upload invalidates any outstanding/completed generate() too

      setPhase("analysing");
      setFile(nextFile); // captured immediately, an object-URL preview can show during "analysing"
      setContext(nextContext ?? null);
      setUploadError(null);
      setUploadState(INITIAL_UPLOAD_STATE); // never display stale analysis from an older upload

      try {
        const response = await uploadImage({ file: nextFile, path: "reorganise", context: nextContext });
        const normalised = normaliseReorganiseUploadResponse(response);

        if (uploadGenerationRef.current !== generation) {
          return; // superseded by a newer submit()/reset(), discard silently
        }

        const actionableIds = normalised.items
          .filter((item) => item.item_role === "actionable")
          .map((item) => item.item_id);

        setUploadState({
          runId: normalised.runId,
          analysis: normalised.analysis,
          inputImageSha256: normalised.inputImageSha256,
          selectedItemIds: actionableIds,
        });
        setPhase("selecting");
      } catch (err) {
        if (uploadGenerationRef.current !== generation) {
          return; // same staleness guard on the failure path, a stale rejection is discarded too
        }
        setUploadError(err instanceof Error ? err.message : "Reorganise upload failed");
        setPhase("upload"); // return to (retain) the upload form, file/context stay for a retry
      }
    },
    [invalidateGeneration]
  );

  const toggleItemSelected = useCallback(
    (itemId) => {
      if (phase !== "selecting") return; // no edits while a generate() request is in flight or a result is shown
      setUploadState((prev) => ({
        ...prev,
        selectedItemIds: prev.selectedItemIds.includes(itemId)
          ? prev.selectedItemIds.filter((id) => id !== itemId)
          : [...prev.selectedItemIds, itemId],
      }));
    },
    [phase]
  );

  const selectAllActionable = useCallback(() => {
    if (phase !== "selecting" || !uploadState.analysis) return;
    setUploadState((prev) => ({
      ...prev,
      selectedItemIds: prev.analysis
        ? prev.analysis.items.filter((item) => item.item_role === "actionable").map((item) => item.item_id)
        : [],
    }));
  }, [phase, uploadState.analysis]);

  const deselectAll = useCallback(() => {
    if (phase !== "selecting") return;
    setUploadState((prev) => ({ ...prev, selectedItemIds: [] }));
  }, [phase]);

  const generate = useCallback(async () => {
    // Silent no-op guards, mirroring useDeclutterFlow.performCorrection's
    // convention (not confirm()'s laxer one), a duplicate /generate
    // dispatch is far more expensive here (Phi-4-mini planning + a real
    // remote generation call) than Declutter's cheap /confirm, so this
    // hook stays safe even if the disabled-button UI is ever bypassed.
    if (phase !== "selecting") return null;
    if (uploadState.selectedItemIds.length === 0) return null;
    if (!uploadState.runId || !uploadState.analysis || !uploadState.inputImageSha256 || !file) return null;
    if (activeGenerationRef.current !== null) return null; // another generation currently owns the slot

    generateGenerationRef.current += 1;
    const generation = generateGenerationRef.current;
    activeGenerationRef.current = generation; // claim the slot
    const runIdSnapshot = uploadState.runId;
    const analysisSnapshot = uploadState.analysis;
    const selectedSnapshot = uploadState.selectedItemIds;
    const inputImageSha256Snapshot = uploadState.inputImageSha256;
    const fileSnapshot = file;
    const contextSnapshot = context;

    setPhase("generating");
    setGenerateError(null);

    try {
      const response = await generateReorganisation({
        runId: runIdSnapshot,
        analysis: analysisSnapshot,
        selectedItemIds: selectedSnapshot,
        file: fileSnapshot,
        inputImageSha256: inputImageSha256Snapshot,
        userContext: contextSnapshot,
      });
      const normalised = normaliseGenerateResponse(response, {
        runId: runIdSnapshot,
        selectedItemIds: selectedSnapshot,
        inputImageSha256: inputImageSha256Snapshot,
      });

      if (generateGenerationRef.current !== generation) {
        return null; // superseded by a newer submit()/reset()/generate(), discard silently
      }
      setGenerateResult(normalised);
      setPhase("result"); // covers BOTH image_status "generated" and "unavailable", see module docstring
      return normalised;
    } catch (err) {
      if (generateGenerationRef.current !== generation) {
        return null; // a stale REJECTION is discarded too, not only a stale success
      }
      // file/analysis/selectedItemIds/context are deliberately left
      // untouched, a failed generate() must never erase the user's
      // upload/selection work; returning to "selecting" (not a dead-end
      // error phase) lets them retry immediately without re-uploading.
      setGenerateError(err instanceof Error ? err.message : "Tidy-plan generation failed");
      setPhase("selecting");
      return null;
    } finally {
      // Release the slot ONLY if this call still owns it, a stale call
      // settling after a NEWER generate() has already claimed the slot
      // (or after submit()/reset() released it) must never clear that
      // newer claim.
      if (activeGenerationRef.current === generation) {
        activeGenerationRef.current = null;
      }
    }
  }, [phase, uploadState, file, context]);

  const reset = useCallback(() => {
    uploadGenerationRef.current += 1; // invalidates any in-flight upload's pending write
    generateGenerationRef.current += 1; // invalidates any in-flight generate()'s pending write
    activeGenerationRef.current = null; // release the slot immediately, a new flow need not wait for it
    setPhase("upload");
    setFile(null); // useObjectUrl(file) at the page level revokes the outstanding URL via its own tested effect
    setContext(null);
    setUploadState(INITIAL_UPLOAD_STATE);
    setUploadError(null);
    setGenerateResult(null);
    setGenerateError(null);
  }, []);

  return {
    phase,
    file,
    context,
    runId: uploadState.runId,
    analysis: uploadState.analysis,
    items: uploadState.analysis ? uploadState.analysis.items : [],
    inputImageSha256: uploadState.inputImageSha256,
    selectedItemIds: uploadState.selectedItemIds,
    uploadError,
    generateError,
    generateResult,
    submit,
    toggleItemSelected,
    selectAllActionable,
    deselectAll,
    generate,
    reset,
  };
}
