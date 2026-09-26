import { useCallback, useRef, useState } from "react";
import { generateConfirmedReorganisation } from "../api/client";
import { normaliseBothUploadResponse } from "../api/declutterContract";
import { serialiseDecisionOverrides } from "../api/confirmationContract";
import { normaliseConfirmedGenerateResponse } from "../api/reorganiseContract";
import { useDeclutterFlow } from "./useDeclutterFlow";

const TIDY_PLAN_ERROR = "We couldn't create your tidy plan.";

// Both composes Declutter's flow and owns a separate Reorganise generation
// counter plus active-owner token. Any operation that changes confirmation
// meaning invalidates this domain. Wrappers call the composed function first
// so its synchronous validation throw precedes generation invalidation.
export function useBothFlow({ listingApi } = {}) {
  // The composed hook owns the independent listing domain unchanged.
  const declutter = useDeclutterFlow({
    uploadPath: "both",
    normaliseUploadResponse: normaliseBothUploadResponse,
    listingApi,
  });

  // Confirmed generation resubmits the retained image bytes.
  const [file, setFile] = useState(null);
  const [context, setContext] = useState(null);

  const [generationStatus, setGenerationStatus] = useState("idle");
  const [generateResult, setGenerateResult] = useState(null);
  const [generateError, setGenerateError] = useState(null);

  const generateGenerationRef = useRef(0);
  const activeGenerationRef = useRef(null);

  const invalidateGeneration = useCallback(() => {
    generateGenerationRef.current += 1;
    activeGenerationRef.current = null;
    setGenerationStatus("idle");
    setGenerateResult(null);
    setGenerateError(null);
  }, []);

  const submit = useCallback(
    async ({ file: nextFile, context: nextContext }) => {
      invalidateGeneration();
      setFile(nextFile);
      setContext(nextContext ?? null);
      return declutter.submit({ file: nextFile, context: nextContext });
    },
    [declutter.submit, invalidateGeneration]
  );

  const setDecisionOverride = useCallback(
    (...args) => {
      declutter.setDecisionOverride(...args);
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
      // The composed synchronous validation runs before invalidation.
      const result = declutter.correctLabel(...args);
      invalidateGeneration();
      return result;
    },
    [declutter.correctLabel, invalidateGeneration]
  );

  const confirm = useCallback(async () => {
    invalidateGeneration();
    return declutter.confirm();
  }, [declutter.confirm, invalidateGeneration]);

  const generate = useCallback(async () => {
    // Guard duplicate remote generation even if UI disabling is bypassed.
    if (declutter.confirmationStatus !== "confirmed") return null;
    // confirmedKeepIds is server-derived; empty Keep never reaches the network.
    if (!declutter.confirmation || declutter.confirmation.confirmedKeepIds.length === 0) return null;
    if (!declutter.runId || !declutter.analysis || !declutter.declutter || !declutter.inputImageSha256 || !file) {
      return null;
    }
    if (activeGenerationRef.current !== null) return null;

    generateGenerationRef.current += 1;
    const generation = generateGenerationRef.current;
    activeGenerationRef.current = generation;

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
        return null;
      }
      setGenerateResult(normalised);
      setGenerationStatus("done");
      return normalised;
    } catch (err) {
      if (generateGenerationRef.current !== generation) {
        return null;
      }
      // Preserve confirmed work so generation can retry immediately.
      setGenerateError(TIDY_PLAN_ERROR);
      setGenerationStatus("error");
      return null;
    } finally {
      // Never release a newer call's ownership.
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
    setFile(null);
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
