import { WORKFLOW_STEPS } from "./workflowProgress";

// Pure derivation of the Declutter wizard's presentation + navigation
// model. It owns no state: DeclutterPage passes in the flow snapshot plus
// the two page-owned pieces of presentation state (which step is being
// viewed, and whether the user has acknowledged Review by pressing
// Continue to Confirm), and gets back everything WorkflowProgress and the
// Back/Continue controls need.
//
// Navigation never depends on this module doing anything with the network
// it is a plain function of state.

export const DECLUTTER_WIZARD_STEPS = WORKFLOW_STEPS.declutter; // Upload → Analyse → Review → Confirm

function describeViewedStep({
  viewedStepId,
  status,
  uploadError,
  hasAnalysis,
  confirmationStatus,
  hasConfirmation,
  correctingItemId,
  unresolvedCount,
}) {
  switch (viewedStepId) {
    case "upload":
      if (uploadError) {
        return {
          statusText: "That upload didn't go through.",
          nextActionText: "Your photo and context are still here. Submit again to retry.",
          processing: false,
        };
      }
      if (hasAnalysis) {
        return {
          statusText: "Your analysed room is still here.",
          nextActionText: "Submit a new photo to start over, or use the tracker to return to your review.",
          processing: false,
        };
      }
      return {
        statusText: "Ready when you are.",
        nextActionText: "Add a room photo, then press Analyse room.",
        processing: false,
      };
    case "analyse":
      if (status === "uploading") {
        return {
          statusText: "Analysing your room, scene, objects and item reasoning.",
          nextActionText: "This can take up to two minutes, no action needed yet.",
          processing: true,
        };
      }
      if (status === "error") {
        return {
          statusText: "That analysis didn't go through.",
          nextActionText: "Go back to Upload and try again.",
          processing: false,
        };
      }
      if (hasAnalysis) {
        return {
          statusText: "Analysis complete.",
          nextActionText: "Continue to Review to check each item.",
          processing: false,
        };
      }
      return {
        statusText: "Ready when you are.",
        nextActionText: "Add a room photo, then press Analyse room.",
        processing: false,
      };
    case "review":
      if (correctingItemId !== null) {
        return {
          statusText: "A label correction is in progress.",
          nextActionText: "Continue to Confirm becomes available once it finishes.",
          processing: false,
        };
      }
      if (unresolvedCount > 0) {
        return {
          statusText: "Some items still need a valid decision.",
          nextActionText: "Resolve every unresolved item, then Continue to Confirm.",
          processing: false,
        };
      }
      return {
        statusText: "ClearSpace suggested an action for each item it found.",
        nextActionText: "Change anything you want, then Continue to Confirm.",
        processing: false,
      };
    case "confirm":
      if (confirmationStatus === "confirming") {
        return {
          statusText: "Confirming your decisions…",
          nextActionText: "This finishes in a moment.",
          processing: true,
        };
      }
      if (confirmationStatus === "confirmed" && hasConfirmation) {
        return {
          statusText: "Your decisions are locked in.",
          nextActionText: "The confirmed summary is below. This declutter run is complete.",
          processing: false,
        };
      }
      if (confirmationStatus === "error") {
        return {
          statusText: "That confirmation didn't go through.",
          nextActionText: "Your review is unchanged. Press Confirm decisions again to retry.",
          processing: false,
        };
      }
      return {
        statusText: "Ready to confirm.",
        nextActionText: "Press Confirm decisions when your review is ready.",
        processing: false,
      };
    default:
      return { statusText: "", nextActionText: "", processing: false };
  }
}

export function deriveDeclutterWizard(input = {}) {
  const {
    status = "idle",
    uploadError = null,
    hasAnalysis = false,
    confirmationStatus = "idle",
    hasConfirmation = false,
    correctingItemId = null,
    unresolvedCount = 0,
    viewedStep = "upload",
    confirmAcknowledged = false,
  } = input;

  const steps = DECLUTTER_WIZARD_STEPS;

  // --- unlocking rules ---
  const analyseUnlocked = status !== "idle"; // a submit has been dispatched
  const reviewUnlocked = hasAnalysis; // analysis succeeded
  const confirmUnlocked = confirmAcknowledged && reviewUnlocked; // explicit Continue from Review

  const unlockedStepIds = ["upload"];
  if (analyseUnlocked) unlockedStepIds.push("analyse");
  if (reviewUnlocked) unlockedStepIds.push("review");
  if (confirmUnlocked) unlockedStepIds.push("confirm");

  const completedStepIds = [];
  if (analyseUnlocked) completedStepIds.push("upload");
  if (hasAnalysis) completedStepIds.push("analyse");
  if (confirmUnlocked) completedStepIds.push("review");
  if (confirmationStatus === "confirmed" && hasConfirmation) completedStepIds.push("confirm");

  // No navigation while a safety-critical request is in flight.
  const navigationLocked = status === "uploading" || confirmationStatus === "confirming";

  // The step actually shown. A stale viewedStep (e.g. "confirm" after a
  // re-upload relock) falls back to the furthest unlocked step.
  const viewedStepId = unlockedStepIds.includes(viewedStep)
    ? viewedStep
    : unlockedStepIds[unlockedStepIds.length - 1];

  const viewedIndex = steps.findIndex((step) => step.id === viewedStepId);
  const backTargetId = viewedIndex > 0 ? steps[viewedIndex - 1].id : null;
  const forwardStep = steps[viewedIndex + 1] ?? null;

  const canContinueFromReview = hasAnalysis && unresolvedCount === 0 && correctingItemId === null;

  let canContinue = false;
  let continueTargetId = null;
  if (!navigationLocked && forwardStep) {
    if (viewedStepId === "analyse") {
      canContinue = hasAnalysis;
      continueTargetId = "review";
    } else if (viewedStepId === "review") {
      canContinue = canContinueFromReview;
      continueTargetId = "confirm";
    }
    // Upload's forward action is the form's own "Analyse room" submit.
    // Confirm is the final step.
  }
  const canGoBack = !navigationLocked && backTargetId !== null;

  const { statusText, nextActionText, processing } = describeViewedStep({
    viewedStepId,
    status,
    uploadError,
    hasAnalysis,
    confirmationStatus,
    hasConfirmation,
    correctingItemId,
    unresolvedCount,
  });

  return {
    workflowName: "Declutter",
    steps,
    viewedStepId,
    completedStepIds,
    unlockedStepIds,
    navigationLocked,
    processing,
    statusText,
    nextActionText,
    ordinalText: `Step ${viewedIndex + 1} of ${steps.length} · ${steps[viewedIndex].label}`,
    nextStepLabel: forwardStep ? forwardStep.label : null,
    canContinue,
    continueTargetId,
    canGoBack,
    backTargetId,
    canContinueFromReview,
  };
}
