import { WORKFLOW_STEPS } from "./workflowProgress";

// Pure derivation of the Declutter wizard's presentation + navigation
// model. It owns no state: DeclutterPage passes in the flow snapshot plus
// the two page-owned pieces of presentation state (which step is being
// viewed, and whether the user has acknowledged Review by pressing
// Continue to Confirm choices), and gets back everything WorkflowProgress and the
// Back/Continue controls need.
//
// Navigation never depends on this module doing anything with the network
// it is a plain function of state.

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
          nextActionText: "The confirmed summary is below. Continue to Listing drafts when you are ready.",
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
      // Order matters: an in-flight or just-failed single-item
      // regeneration is reported first, it overlays the (already "ready")
      // batch state rather than being hidden by it. Eligibility is a
      // truthful fact of the current confirmation regardless of
      // listingStatus, so "nothing to sell" is reported the same way
      // whether or not a (no-op) generation has run yet.
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
      if (eligibleSellCount === 0) {
        return {
          statusText: "Nothing was confirmed as Sell.",
          nextActionText: "There are no listing drafts to generate for this run.",
          processing: false,
        };
      }
      if (listingStatus === "ready") {
        return {
          statusText: "Your listing drafts are ready to review.",
          nextActionText: "Edit, copy, regenerate or discard any draft below.",
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
    // Marketplace listing state (Stage 4B), explicit inputs rather than
    // the raw confirmation/hook objects, so this module keeps its
    // existing plain-flag style. eligibleSellCount MUST be derived by the
    // caller only from the current confirmation's confirmedDecisions
    // (confirmed_decision === "sell" && excluded === false), never from
    // labels, draft presence or Keep ids, matching ListingsView's own
    // eligibility rule exactly (both consume
    // lib/listingDrafts.js's deriveEligibleSellItemIds).
    listingStatus = "idle",
    eligibleSellCount = 0,
    regeneratingItemId = null,
    regenerationError = null,
  } = input;

  const steps = DECLUTTER_WIZARD_STEPS;

  // --- unlocking rules ---
  const analyseUnlocked = status !== "idle"; // a submit has been dispatched
  const reviewUnlocked = hasAnalysis; // analysis succeeded
  const confirmUnlocked = confirmAcknowledged && reviewUnlocked; // explicit Continue from Review
  // Listings unlocks only on a genuinely successful CURRENT confirmation,
  // never merely by reaching/acknowledging Confirm. Confirming does not
  // navigate here and does not generate anything by itself, see confirm().
  const listingsUnlocked = confirmationStatus === "confirmed" && hasConfirmation;

  const unlockedStepIds = ["upload"];
  if (analyseUnlocked) unlockedStepIds.push("analyse");
  if (reviewUnlocked) unlockedStepIds.push("review");
  if (confirmUnlocked) unlockedStepIds.push("confirm");
  if (listingsUnlocked) unlockedStepIds.push("listings");

  // A confirmed run with zero eligible (non-excluded Sell) items has
  // nothing to generate, so Listings counts as complete without ever
  // calling generateListingDrafts, matching ListingsView's own truthful
  // empty state (no button, no request). Otherwise Listings is complete
  // only once a batch has actually finished (listingStatus === "ready");
  // local edits/discards never affect this, they never change
  // listingStatus.
  const listingsComplete = listingsUnlocked && (eligibleSellCount === 0 || listingStatus === "ready");

  const completedStepIds = [];
  if (analyseUnlocked) completedStepIds.push("upload");
  if (hasAnalysis) completedStepIds.push("analyse");
  if (confirmUnlocked) completedStepIds.push("review");
  if (confirmationStatus === "confirmed" && hasConfirmation) completedStepIds.push("confirm");
  if (listingsComplete) completedStepIds.push("listings");

  // No navigation while a safety-critical request is in flight. Batch
  // listing generation and a single-item regeneration both lock
  // navigation the same way upload/confirm do; purely local presentation
  // actions (editing, copying, discarding, restoring) never do, they
  // never touch listingStatus or regeneratingItemId.
  const navigationLocked =
    status === "uploading" ||
    confirmationStatus === "confirming" ||
    listingStatus === "generating" ||
    regeneratingItemId !== null;

  // The step actually shown. A stale viewedStep (e.g. "confirm" after a
  // re-upload relock, or "listings" after the confirmation it depended on
  // was invalidated) falls back to the furthest unlocked step.
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
      // Navigation only, never a listing API call, mirrors submit()'s
      // own separation from analysis.
      canContinue = confirmationStatus === "confirmed" && hasConfirmation;
      continueTargetId = "listings";
    }
    // Upload's forward action is the form's own "Analyse space" submit.
    // Listings is the final step.
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
