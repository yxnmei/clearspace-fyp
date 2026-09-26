import { WORKFLOW_STEPS } from "./workflowProgress";

// Derives Declutter presentation and navigation from a state snapshot.

export const DECLUTTER_WIZARD_STEPS = WORKFLOW_STEPS.declutter; // Upload → Analyse → Review → Confirm → Listings

function describeViewedStep({
  viewedStepId,
  status,
  uploadError,
  hasAnalysis,
  confirmationStatus,
  hasConfirmation,
  correctingItemId,
  unresolvedCount,
  listingStatus,
  eligibleSellCount,
  regeneratingItemId,
  regenerationError,
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
          statusText: "Your analysed space is still here.",
          nextActionText: "Submit a new photo to start over, or return to Decide items.",
          processing: false,
        };
      }
      return {
        statusText: "Ready when you are.",
        nextActionText: "Add a space photo, then press Analyse space.",
        processing: false,
      };
    case "analyse":
      if (status === "uploading") {
        return {
          statusText: "Analysing your space…",
          nextActionText: "This can take up to two minutes, no action needed yet.",
          processing: true,
        };
      }
      if (status === "error") {
        return {
          statusText: "That analysis didn't go through.",
          nextActionText: "Go back to Upload photo and try again.",
          processing: false,
        };
      }
      if (hasAnalysis) {
        return {
          statusText: "Analysis complete.",
          nextActionText: "Continue to Decide items to check each item.",
          processing: false,
        };
      }
      return {
        statusText: "Ready when you are.",
        nextActionText: "Add a space photo, then press Analyse space.",
        processing: false,
      };
    case "review":
      if (correctingItemId !== null) {
        return {
          statusText: "A label correction is in progress.",
          nextActionText: "Continue to Confirm choices becomes available once it finishes.",
          processing: false,
        };
      }
      if (unresolvedCount > 0) {
        return {
          statusText: "Some items still need a valid decision.",
          nextActionText: "Resolve every unresolved item, then Continue to Confirm choices.",
          processing: false,
        };
      }
      return {
        statusText: "ClearSpace suggested an action for each item it found.",
        nextActionText: "Change anything you want, then Continue to Confirm choices.",
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
          nextActionText: "The confirmed summary is below. Continue to Results when you are ready.",
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
    case "listings": {
      // Single-item regeneration overlays the already-ready batch state.
      if (regeneratingItemId !== null) {
        return {
          statusText: "Regenerating one listing draft…",
          nextActionText: "This can take a moment. Every other draft is unaffected.",
          processing: true,
        };
      }
      if (regenerationError) {
        return {
          statusText: "One listing draft could not be regenerated.",
          nextActionText: "Its card explains what happened and offers to try again. Every other draft is unaffected.",
          processing: false,
        };
      }
      if (listingStatus === "generating") {
        return {
          statusText: "Generating your listing drafts…",
          nextActionText: "This can take a moment, no action needed yet.",
          processing: true,
        };
      }
      if (listingStatus === "error") {
        return {
          statusText: "Listing draft generation didn't go through.",
          nextActionText: "Your confirmed decisions are unchanged. Press Try again below.",
          processing: false,
        };
      }
      // Zero eligible Sell items is also a complete Declutter result.
      if (eligibleSellCount === 0) {
        return {
          statusText: "Your declutter is complete.",
          nextActionText: "Nothing was confirmed as Sell, so there are no listing drafts. Your confirmed choices are below.",
          processing: false,
        };
      }
      if (listingStatus === "ready") {
        return {
          statusText: "Your declutter is complete.",
          nextActionText: "Your confirmed choices and listing drafts are below. Edit, copy, regenerate or discard any draft.",
          processing: false,
        };
      }
      return {
        statusText: "Ready to generate listing drafts.",
        nextActionText: "Press Generate listing drafts when you are ready.",
        processing: false,
      };
    }
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
    // eligibleSellCount must come from server confirmation, never labels,
    // draft presence or Keep ids.
    listingStatus = "idle",
    eligibleSellCount = 0,
    regeneratingItemId = null,
    regenerationError = null,
  } = input;

  const steps = DECLUTTER_WIZARD_STEPS;

  const analyseUnlocked = status !== "idle";
  const reviewUnlocked = hasAnalysis;
  const confirmUnlocked = confirmAcknowledged && reviewUnlocked;
  // Listings requires a successful current confirmation.
  const listingsUnlocked = confirmationStatus === "confirmed" && hasConfirmation;

  const unlockedStepIds = ["upload"];
  if (analyseUnlocked) unlockedStepIds.push("analyse");
  if (reviewUnlocked) unlockedStepIds.push("review");
  if (confirmUnlocked) unlockedStepIds.push("confirm");
  if (listingsUnlocked) unlockedStepIds.push("listings");

  // Zero eligible Sell items completes Listings without a request.
  const listingsComplete = listingsUnlocked && (eligibleSellCount === 0 || listingStatus === "ready");

  const completedStepIds = [];
  if (analyseUnlocked) completedStepIds.push("upload");
  if (hasAnalysis) completedStepIds.push("analyse");
  if (confirmUnlocked) completedStepIds.push("review");
  if (confirmationStatus === "confirmed" && hasConfirmation) completedStepIds.push("confirm");
  if (listingsComplete) completedStepIds.push("listings");

  // Network mutations lock navigation; local listing edits do not.
  const navigationLocked =
    status === "uploading" ||
    confirmationStatus === "confirming" ||
    listingStatus === "generating" ||
    regeneratingItemId !== null;

  // Clamp a relocked viewed step to the furthest unlocked step.
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
    } else if (viewedStepId === "confirm") {
      // Navigation only, never a listing API call.
      canContinue = confirmationStatus === "confirmed" && hasConfirmation;
      continueTargetId = "listings";
    }
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
    listingStatus,
    eligibleSellCount,
    regeneratingItemId,
    regenerationError,
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
