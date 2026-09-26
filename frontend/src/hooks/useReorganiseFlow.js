import { useCallback, useMemo, useRef, useState } from "react";
import { generateReorganisation, uploadImage } from "../api/client";
import { normaliseGenerateResponse, normaliseReorganiseUploadResponse } from "../api/reorganiseContract";
import {
  applyLabelCorrections,
  serialiseLabelCorrections,
  validateCorrectedLabel,
} from "../lib/reorganiseLabelCorrections";

const ANALYSIS_ERROR = "We couldn't analyse your space.";
const TIDY_PLAN_ERROR = "We couldn't create your tidy plan.";

// Phases are upload, analysing, selecting, generating and result. Errors stay
// on their recoverable phase. A response with an unavailable image is still
// a successful result because its tidy plan remains usable.
//
// Generation resubmits the retained file. Label corrections are keyed only
// by item_id and applied to derived display items; analysis is never edited.
// A real correction clears any in-flight or completed plan.
const INITIAL_UPLOAD_STATE = {
  runId: null,
  analysis: null,
  inputImageSha256: null,
  selectedItemIds: [],
  labelCorrectionsById: {},
};

const LABEL_CORRECTION_PHASES = new Set(["selecting", "generating", "result"]);

export function useReorganiseFlow() {
  const [phase, setPhase] = useState("upload");
  const [file, setFile] = useState(null);
  const [context, setContext] = useState(null);

  const [uploadState, setUploadState] = useState(INITIAL_UPLOAD_STATE);
  const [uploadError, setUploadError] = useState(null);

  const [generateResult, setGenerateResult] = useState(null);
  const [generateError, setGenerateError] = useState(null);
  // Explains why a cleared plan must be generated again.
  const [labelsChangedSincePlan, setLabelsChangedSincePlan] = useState(false);

  // Separate counters guard upload and generation writes. submit/reset bump
  // the upload counter and invalidate generation; generate claims only its
  // own counter. Both late success and rejection must match their snapshot.
  const uploadGenerationRef = useRef(0);
  const generateGenerationRef = useRef(0);
  // The generation ID also owns the synchronous one-request slot. Invalidation
  // releases it immediately; finally clears it only while the same call owns it.
  const activeGenerationRef = useRef(null);

  const invalidateGeneration = useCallback(() => {
    generateGenerationRef.current += 1;
    activeGenerationRef.current = null;
    setGenerateResult(null);
    setGenerateError(null);
  }, []);

  const submit = useCallback(
    async ({ file: nextFile, context: nextContext }) => {
      uploadGenerationRef.current += 1;
      const generation = uploadGenerationRef.current;
      invalidateGeneration();
      setLabelsChangedSincePlan(false);

      setPhase("analysing");
      setFile(nextFile);
      setContext(nextContext ?? null);
      setUploadError(null);
      setUploadState(INITIAL_UPLOAD_STATE);

      try {
        const response = await uploadImage({ file: nextFile, path: "reorganise", context: nextContext });
        const normalised = normaliseReorganiseUploadResponse(response);

        if (uploadGenerationRef.current !== generation) {
          return;
        }

        const actionableIds = normalised.items
          .filter((item) => item.item_role === "actionable")
          .map((item) => item.item_id);

        setUploadState({
          runId: normalised.runId,
          analysis: normalised.analysis,
          inputImageSha256: normalised.inputImageSha256,
          selectedItemIds: actionableIds,
          labelCorrectionsById: {},
        });
        setPhase("selecting");
      } catch (err) {
        if (uploadGenerationRef.current !== generation) {
          return;
        }
        setUploadError(ANALYSIS_ERROR);
        setPhase("upload");
      }
    },
    [invalidateGeneration]
  );

  const toggleItemSelected = useCallback(
    (itemId) => {
      if (phase !== "selecting") return;
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

  // Any actual label change invalidates the plan.
  const applyLabelChange = useCallback(
    (itemId, nextLabel) => {
      const hadPlan = phase === "generating" || phase === "result";
      invalidateGeneration();
      setUploadState((prev) => {
        const nextCorrections = { ...prev.labelCorrectionsById };
        if (nextLabel === null) delete nextCorrections[itemId];
        else nextCorrections[itemId] = nextLabel;
        return { ...prev, labelCorrectionsById: nextCorrections };
      });
      if (phase !== "selecting") setPhase("selecting");
      if (hadPlan) setLabelsChangedSincePlan(true);
    },
    [phase, invalidateGeneration]
  );

  const findActionableItem = useCallback(
    (itemId, caller) => {
      const item = uploadState.analysis?.items.find(
        (candidate) => candidate.item_id === itemId && candidate.item_role === "actionable"
      );
      if (!item) throw new Error(`${caller}: unknown actionable item_id ${JSON.stringify(itemId)}`);
      return item;
    },
    [uploadState.analysis]
  );

  // Saving clean_label removes the correction; saving the current label is a no-op.
  const correctItemLabel = useCallback(
    (itemId, label) => {
      if (!LABEL_CORRECTION_PHASES.has(phase) || !uploadState.analysis) return false;
      const item = findActionableItem(itemId, "correctItemLabel");
      const validated = validateCorrectedLabel(label);
      if (!validated.ok) throw new Error(`correctItemLabel: ${validated.error}`);

      const current = uploadState.labelCorrectionsById[itemId] ?? null;
      const next = validated.value === item.clean_label ? null : validated.value;
      if (next === current) return false;
      applyLabelChange(itemId, next);
      return true;
    },
    [phase, uploadState.analysis, uploadState.labelCorrectionsById, findActionableItem, applyLabelChange]
  );

  const clearItemLabelCorrection = useCallback(
    (itemId) => {
      if (!LABEL_CORRECTION_PHASES.has(phase) || !uploadState.analysis) return false;
      findActionableItem(itemId, "clearItemLabelCorrection");
      if (!(itemId in uploadState.labelCorrectionsById)) return false;
      applyLabelChange(itemId, null);
      return true;
    },
    [phase, uploadState.analysis, uploadState.labelCorrectionsById, findActionableItem, applyLabelChange]
  );

  const generate = useCallback(async () => {
    // Guards also prevent duplicate remote generation outside the UI.
    if (phase !== "selecting") return null;
    if (uploadState.selectedItemIds.length === 0) return null;
    if (!uploadState.runId || !uploadState.analysis || !uploadState.inputImageSha256 || !file) return null;
    if (activeGenerationRef.current !== null) return null;

    generateGenerationRef.current += 1;
    const generation = generateGenerationRef.current;
    activeGenerationRef.current = generation;
    const runIdSnapshot = uploadState.runId;
    const analysisSnapshot = uploadState.analysis;
    const selectedSnapshot = uploadState.selectedItemIds;
    const labelCorrectionsSnapshot = serialiseLabelCorrections(
      uploadState.analysis.items,
      uploadState.labelCorrectionsById
    );
    const inputImageSha256Snapshot = uploadState.inputImageSha256;
    const fileSnapshot = file;
    const contextSnapshot = context;

    setPhase("generating");
    setGenerateError(null);
    setLabelsChangedSincePlan(false);

    try {
      const response = await generateReorganisation({
        runId: runIdSnapshot,
        analysis: analysisSnapshot,
        selectedItemIds: selectedSnapshot,
        labelCorrections: labelCorrectionsSnapshot,
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
        return null;
      }
      setGenerateResult(normalised);
      setPhase("result");
      return normalised;
    } catch (err) {
      if (generateGenerationRef.current !== generation) {
        return null;
      }
      // Preserve upload and selection state for an immediate retry.
      setGenerateError(TIDY_PLAN_ERROR);
      setPhase("selecting");
      return null;
    } finally {
      // Never release a newer call's ownership.
      if (activeGenerationRef.current === generation) {
        activeGenerationRef.current = null;
      }
    }
  }, [phase, uploadState, file, context]);

  const reset = useCallback(() => {
    uploadGenerationRef.current += 1;
    generateGenerationRef.current += 1;
    activeGenerationRef.current = null;
    setPhase("upload");
    setFile(null);
    setContext(null);
    setUploadState(INITIAL_UPLOAD_STATE);
    setUploadError(null);
    setGenerateResult(null);
    setGenerateError(null);
    setLabelsChangedSincePlan(false);
  }, []);

  const items = useMemo(
    () =>
      uploadState.analysis
        ? applyLabelCorrections(uploadState.analysis.items, uploadState.labelCorrectionsById)
        : [],
    [uploadState.analysis, uploadState.labelCorrectionsById]
  );

  return {
    phase,
    file,
    context,
    runId: uploadState.runId,
    analysis: uploadState.analysis,
    items,
    inputImageSha256: uploadState.inputImageSha256,
    selectedItemIds: uploadState.selectedItemIds,
    labelCorrectionsById: uploadState.labelCorrectionsById,
    labelsChangedSincePlan,
    uploadError,
    generateError,
    generateResult,
    submit,
    toggleItemSelected,
    selectAllActionable,
    deselectAll,
    correctItemLabel,
    clearItemLabelCorrection,
    generate,
    reset,
  };
}
