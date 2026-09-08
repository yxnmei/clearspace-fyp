// Pure, model-free progress and wizard-navigation derivation for the
// three workflows. Declutter has additional listing-specific rules in
// declutterWizard.js; Direct Reorganise and Both use the helpers here.

const DECLUTTER_STEPS = [
  { id: "upload", label: "Upload" },
  { id: "analyse", label: "Analyse" },
  { id: "review", label: "Review" },
  { id: "confirm", label: "Confirm" },
  { id: "listings", label: "Listings" },
];

const REORGANISE_STEPS = [
  { id: "upload", label: "Upload" },
  { id: "analyse", label: "Analyse" },
  { id: "review", label: "Review" },
  { id: "generate", label: "Generate" },
];

const BOTH_STEPS = [
  { id: "upload", label: "Upload" },
  { id: "analyse", label: "Analyse" },
  { id: "review", label: "Review" },
  { id: "confirm", label: "Confirm" },
  { id: "reorganise", label: "Reorganise" },
];

export const WORKFLOW_STEPS = {
  declutter: DECLUTTER_STEPS,
  reorganise: REORGANISE_STEPS,
  both: BOTH_STEPS,
};

function navigationModel({ steps, viewedStep, unlockedStepIds, completedStepIds, navigationLocked }) {
  const viewedStepId = unlockedStepIds.includes(viewedStep)
    ? viewedStep
    : unlockedStepIds[unlockedStepIds.length - 1];
  const viewedIndex = steps.findIndex((step) => step.id === viewedStepId);
  const backTargetId = viewedIndex > 0 ? steps[viewedIndex - 1].id : null;
  return {
    viewedStepId,
    completedStepIds,
    unlockedStepIds,
    navigationLocked,
    backTargetId,
    canGoBack: !navigationLocked && backTargetId !== null,
  };
}

function describeReorganiseStep({ viewedStepId, phase, uploadError, hasAnalysis, selectedItemCount }) {
  switch (viewedStepId) {
    case "upload":
      if (uploadError) return ["That upload didn't go through.", "Your photo and context are still here. Submit again to retry.", false];
      if (hasAnalysis) return ["Your analysed room is still here.", "Submit a new photo to start over, or return to Review.", false];
      return ["Ready when you are.", "Add a room photo, then press Analyse room.", false];
    case "analyse":
      if (phase === "analysing") return ["Analysing your room, scene and objects.", "This can take up to two minutes, no action needed yet.", true];
      if (uploadError) return ["That analysis didn't go through.", "Go back to Upload and try again.", false];
      if (hasAnalysis) return ["Analysis complete.", "Continue to Review to check the detected items.", false];
      return ["Ready when you are.", "Add a room photo, then press Analyse room.", false];
    case "review":
      if (selectedItemCount === 0) return ["Nothing is included in the room plan.", "Include at least one actionable item to continue.", false];
      return ["Your detected items are ready to review.", "Exclude anything incorrect, then continue to Generate.", false];
    case "generate":
      if (phase === "generating") return ["Planning the room and generating a preview…", "This can take several minutes, no action needed yet.", true];
      if (phase === "result") return ["Your reorganisation is complete.", "Review the room plan and visual preview below.", false];
      if (phase === "selecting" && uploadError == null) return ["Ready to generate your room plan.", "Press Generate room plan when you are ready.", false];
      return ["Room-plan generation is ready.", "Return to Review if you want to change the included items.", false];
    default:
      return ["", "", false];
  }
}

// Direct Reorganise as a navigable four-screen wizard. `viewedStep` is
// presentation state; `phase` remains the hook-owned network state.
export function deriveReorganiseProgress({
  phase = "upload",
  uploadError = null,
  generateError = null,
  hasAnalysis: suppliedHasAnalysis,
  selectedItemCount = 0,
  viewedStep,
  reviewAcknowledged = false,
} = {}) {
  const hasAnalysis = suppliedHasAnalysis ?? ["selecting", "generating", "result"].includes(phase);
  const analysisAttempted = phase !== "upload" || uploadError !== null;
  const reviewComplete = reviewAcknowledged || phase === "generating" || phase === "result" || generateError !== null;
  const navigationLocked = phase === "analysing" || phase === "generating";

  const unlockedStepIds = ["upload"];
  if (analysisAttempted) unlockedStepIds.push("analyse");
  if (hasAnalysis) unlockedStepIds.push("review");
  if (hasAnalysis && reviewComplete) unlockedStepIds.push("generate");

  const completedStepIds = [];
  if (analysisAttempted) completedStepIds.push("upload");
  if (hasAnalysis) completedStepIds.push("analyse");
  if (hasAnalysis && reviewComplete) completedStepIds.push("review");
  if (phase === "result") completedStepIds.push("generate");

  const underlyingStep = phase === "analysing"
    ? "analyse"
    : phase === "generating" || phase === "result" || generateError
      ? "generate"
      : hasAnalysis
        ? "review"
        : "upload";
  const navigation = navigationModel({
    steps: REORGANISE_STEPS,
    viewedStep: viewedStep ?? underlyingStep,
    unlockedStepIds,
    completedStepIds,
    navigationLocked,
  });

  let canContinue = false;
  let continueTargetId = null;
  if (!navigationLocked && navigation.viewedStepId === "analyse" && hasAnalysis) {
    canContinue = true;
    continueTargetId = "review";
  } else if (!navigationLocked && navigation.viewedStepId === "review" && selectedItemCount > 0) {
    canContinue = true;
    continueTargetId = "generate";
  }

  const [statusText, nextActionText, processing] = describeReorganiseStep({
    viewedStepId: navigation.viewedStepId,
    phase,
    uploadError,
    hasAnalysis,
    selectedItemCount,
  });
  const finalStatusText = generateError && navigation.viewedStepId === "generate"
    ? "The room-plan generation didn't finish."
    : statusText;
  const finalNextActionText = generateError && navigation.viewedStepId === "generate"
    ? "Your selection is unchanged. Press Generate room plan to try again."
    : nextActionText;

  return {
    workflowName: "Reorganise",
    steps: REORGANISE_STEPS,
    currentStepId: underlyingStep,
    isComplete: phase === "result",
    ...navigation,
    processing,
    statusText: finalStatusText,
    nextActionText: finalNextActionText,
    canContinue,
    continueTargetId,
  };
}

function describeBothStep({
  viewedStepId,
  status,
  hasAnalysis,
  confirmationStatus,
  hasConfirmation,
  generationStatus,
  listingStatus,
  regeneratingItemId,
  unresolvedCount,
  correctingItemId,
}) {
  switch (viewedStepId) {
    case "upload":
      if (status === "error") return ["That upload didn't go through.", "Your photo and context are still here. Submit again to retry.", false];
      if (hasAnalysis) return ["Your analysed room is still here.", "Submit a new photo to start over, or return to Review.", false];
      return ["Ready when you are.", "Add a room photo, then press Analyse room.", false];
    case "analyse":
      if (status === "uploading") return ["Analysing your room, scene, objects and item reasoning.", "This can take up to two minutes, no action needed yet.", true];
      if (status === "error") return ["That analysis didn't go through.", "Go back to Upload and try again.", false];
      return hasAnalysis
        ? ["Analysis complete.", "Continue to Review to check each item.", false]
        : ["Ready when you are.", "Add a room photo, then press Analyse room.", false];
    case "review":
      if (correctingItemId !== null) return ["A label correction is in progress.", "Continue becomes available once it finishes.", false];
      if (unresolvedCount > 0) return ["Some items still need a valid decision.", "Resolve every item before continuing.", false];
      return ["ClearSpace suggested an action for each item.", "Change anything you want, then continue to Confirm.", false];
    case "confirm":
      if (confirmationStatus === "confirming") return ["Confirming your decisions…", "This finishes in a moment.", true];
      if (confirmationStatus === "error") return ["That confirmation didn't go through.", "Your review is unchanged. Try again below.", false];
      if (hasConfirmation) return ["Your decisions are locked in.", "Continue to the final actions when you are ready.", false];
      return ["Ready to confirm.", "Press Confirm decisions when your review is ready.", false];
    case "reorganise":
      if (generationStatus === "generating") return ["Planning the room and generating a preview…", "Listings remain independently available on this screen.", true];
      if (listingStatus === "generating") return ["Generating your listing drafts…", "Reorganisation remains independently available on this screen.", true];
      if (regeneratingItemId !== null) return ["Regenerating one listing draft…", "The room plan and other drafts are unaffected.", true];
      if (generationStatus === "error") return ["The reorganisation didn't finish.", "Your confirmed choices are unchanged. Try again below.", false];
      if (generationStatus === "done") return ["Your reorganisation is complete.", "Your room plan, preview and listing actions are below.", false];
      return ["Choose your next action.", "Generate listings and a reorganisation independently, in either order.", false];
    default:
      return ["", "", false];
  }
}

// Both follows the same screen-by-screen pattern while keeping Listings
// and Reorganise as independent actions on the final screen.
export function deriveBothProgress({
  status = "idle",
  analysis = null,
  declutter = null,
  confirmationStatus = "idle",
  confirmation = null,
  generationStatus = "idle",
  generateResult = null,
  listingStatus = "idle",
  regeneratingItemId = null,
  unresolvedCount = 0,
  correctingItemId = null,
  viewedStep,
  reviewAcknowledged = false,
} = {}) {
  const hasAnalysis = Boolean(analysis && declutter);
  const hasConfirmation = confirmationStatus === "confirmed" && confirmation !== null;
  const analysisAttempted = status !== "idle";
  const reviewComplete = reviewAcknowledged || confirmationStatus !== "idle" || hasConfirmation;
  const navigationLocked =
    status === "uploading" ||
    confirmationStatus === "confirming" ||
    generationStatus === "generating" ||
    listingStatus === "generating" ||
    regeneratingItemId !== null;

  const unlockedStepIds = ["upload"];
  if (analysisAttempted) unlockedStepIds.push("analyse");
  if (hasAnalysis) unlockedStepIds.push("review");
  if (hasAnalysis && reviewComplete) unlockedStepIds.push("confirm");
  if (hasConfirmation) unlockedStepIds.push("reorganise");

  const completedStepIds = [];
  if (analysisAttempted) completedStepIds.push("upload");
  if (hasAnalysis) completedStepIds.push("analyse");
  if (hasAnalysis && reviewComplete) completedStepIds.push("review");
  if (hasConfirmation) completedStepIds.push("confirm");
  if (generationStatus === "done" || generateResult) completedStepIds.push("reorganise");

  const underlyingStep = generationStatus !== "idle" || generateResult || hasConfirmation
    ? "reorganise"
    : confirmationStatus !== "idle"
      ? "confirm"
      : hasAnalysis
        ? "review"
        : status === "uploading"
          ? "analyse"
          : "upload";
  const navigation = navigationModel({
    steps: BOTH_STEPS,
    viewedStep: viewedStep ?? underlyingStep,
    unlockedStepIds,
    completedStepIds,
    navigationLocked,
  });

  const canContinueFromReview = hasAnalysis && unresolvedCount === 0 && correctingItemId === null;
  let canContinue = false;
  let continueTargetId = null;
  if (!navigationLocked && navigation.viewedStepId === "analyse" && hasAnalysis) {
    canContinue = true;
    continueTargetId = "review";
  } else if (!navigationLocked && navigation.viewedStepId === "review" && canContinueFromReview) {
    canContinue = true;
    continueTargetId = "confirm";
  } else if (!navigationLocked && navigation.viewedStepId === "confirm" && hasConfirmation) {
    canContinue = true;
    continueTargetId = "reorganise";
  }

  const [statusText, nextActionText, processing] = describeBothStep({
    viewedStepId: navigation.viewedStepId,
    status,
    hasAnalysis,
    confirmationStatus,
    hasConfirmation,
    generationStatus,
    listingStatus,
    regeneratingItemId,
    unresolvedCount,
    correctingItemId,
  });

  return {
    workflowName: "Both",
    steps: BOTH_STEPS,
    currentStepId: underlyingStep,
    isComplete: generationStatus === "done" || Boolean(generateResult),
    ...navigation,
    processing,
    statusText,
    nextActionText,
    canContinue,
    continueTargetId,
    canContinueFromReview,
  };
}
