// Pure, model-free derivation of progress-stepper presentation data from
// the state each workflow page already owns. No React, no hooks, no side
// effects, every function takes a plain state snapshot and returns the
// exact shape <WorkflowProgress /> renders:
//
//   {
//     workflowName,      // e.g. "Declutter", used for the nav label
//     steps,             // ordered [{ id, label }]
//     currentStepId,     // the step currently in progress
//     isComplete,        // final step done and the workflow finished
//     processing,        // work is actively in flight right now
//     statusText,        // what ClearSpace is doing now
//     nextActionText,    // what the user should do next
//   }
//
// The three step sequences are each workflow's real state machine, never
// one shared sequence. "Review" is the existing optional detected-item
// review; a successful result completes the final step (Generate /
// Reorganise) rather than adding a separate "Result" step.

const DECLUTTER_STEPS = [
  { id: "upload", label: "Upload" },
  { id: "analyse", label: "Analyse" },
  { id: "review", label: "Review" },
  { id: "confirm", label: "Confirm" },
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

const READY_STATUS = "Ready when you are.";
const READY_NEXT = "Add a room photo (and optional context), then start the analysis.";
const UPLOAD_ERROR_STATUS = "That upload didn't go through.";
const UPLOAD_ERROR_NEXT = "Your photo and context are still here. Submit again to retry.";
const NO_ACTION_WAIT = "This can take up to two minutes, no action needed yet.";

// Declutter is no longer derived here. Its four-view wizard owns its own
// presentation + navigation model in lib/declutterWizard.js
// (deriveDeclutterWizard), which is the single Declutter source of truth.
// WORKFLOW_STEPS.declutter is still exported above and consumed there.

// Direct Reorganise: Upload → Analyse → Review → Generate.
// Derived from flow.phase, with uploadError / generateError as the
// recoverable-error side fields on their own step.
export function deriveReorganiseProgress({ phase, uploadError, generateError } = {}) {
  const base = { workflowName: "Reorganise", steps: REORGANISE_STEPS };

  switch (phase) {
    case "result":
      return {
        ...base,
        currentStepId: "generate",
        isComplete: true,
        processing: false,
        statusText: "Your reorganisation is complete.",
        nextActionText: "The plan and preview are below. Start over to run it again.",
      };
    case "generating":
      return {
        ...base,
        currentStepId: "generate",
        isComplete: false,
        processing: true,
        statusText: "Planning the room and generating a preview…",
        nextActionText: NO_ACTION_WAIT,
      };
    case "selecting":
      if (generateError) {
        return {
          ...base,
          currentStepId: "generate",
          isComplete: false,
          processing: false,
          statusText: "The room-plan generation didn't finish.",
          nextActionText: "Your selection is unchanged. Adjust it if you like, then generate again.",
        };
      }
      return {
        ...base,
        currentStepId: "review",
        isComplete: false,
        processing: false,
        statusText: "ClearSpace analysed your room. Actionable items are included by default.",
        nextActionText: "Optionally exclude wrong detections, then generate your room plan.",
      };
    case "analysing":
      return {
        ...base,
        currentStepId: "analyse",
        isComplete: false,
        processing: true,
        statusText: "Analysing your room, scene and object detection.",
        nextActionText: NO_ACTION_WAIT,
      };
    case "upload":
    default:
      if (uploadError) {
        return {
          ...base,
          currentStepId: "upload",
          isComplete: false,
          processing: false,
          statusText: UPLOAD_ERROR_STATUS,
          nextActionText: UPLOAD_ERROR_NEXT,
        };
      }
      return {
        ...base,
        currentStepId: "upload",
        isComplete: false,
        processing: false,
        statusText: READY_STATUS,
        nextActionText: READY_NEXT,
      };
  }
}

// Both: Upload → Analyse → Review → Confirm → Reorganise.
// Derived only from useBothFlow state (the composed Declutter fields plus
// this hook's own generationStatus / generateResult).
//
// Empty-Keep rule: if confirmation succeeds with zero confirmed Keep
// items, the workflow stays on Confirm, Reorganise is never shown active
// or complete, and the guidance says at least one item must be changed
// to Keep and confirmed before reorganisation can begin.
export function deriveBothProgress({
  status,
  analysis,
  declutter,
  confirmationStatus,
  confirmation,
  generationStatus,
  generateResult,
} = {}) {
  const base = { workflowName: "Both", steps: BOTH_STEPS };

  if (generationStatus === "done" || generateResult) {
    return {
      ...base,
      currentStepId: "reorganise",
      isComplete: true,
      processing: false,
      statusText: "Your reorganisation is complete.",
      nextActionText: "The plan and preview are below. This run is complete.",
    };
  }
  if (generationStatus === "generating") {
    return {
      ...base,
      currentStepId: "reorganise",
      isComplete: false,
      processing: true,
      statusText: "Planning the room and generating a preview…",
      nextActionText: NO_ACTION_WAIT,
    };
  }
  if (generationStatus === "error") {
    return {
      ...base,
      currentStepId: "reorganise",
      isComplete: false,
      processing: false,
      statusText: "The reorganisation didn't finish.",
      nextActionText: "Your confirmed choices are unchanged. Press the reorganisation button again to retry.",
    };
  }

  const hasConfirmation = confirmationStatus === "confirmed" && confirmation;
  if (hasConfirmation && confirmation.confirmedKeepIds.length > 0) {
    return {
      ...base,
      currentStepId: "reorganise",
      isComplete: false,
      processing: false,
      statusText: "Your Keep items are locked in.",
      nextActionText: "Press the reorganisation button to plan the room using those Keep items.",
    };
  }
  if (hasConfirmation && confirmation.confirmedKeepIds.length === 0) {
    return {
      ...base,
      currentStepId: "confirm",
      isComplete: false,
      processing: false,
      statusText: "Confirmed, but nothing is set to Keep yet.",
      nextActionText:
        "Change at least one item to Keep and confirm again before reorganisation can begin.",
    };
  }
  if (confirmationStatus === "confirming") {
    return {
      ...base,
      currentStepId: "confirm",
      isComplete: false,
      processing: true,
      statusText: "Saving your Keep, Sell, Donate and Discard choices…",
      nextActionText: NO_ACTION_WAIT,
    };
  }
  if (confirmationStatus === "error") {
    return {
      ...base,
      currentStepId: "confirm",
      isComplete: false,
      processing: false,
      statusText: "That confirmation didn't go through.",
      nextActionText: "Your review is unchanged. Press Confirm decisions again to retry.",
    };
  }
  if (status === "uploading") {
    return {
      ...base,
      currentStepId: "analyse",
      isComplete: false,
      processing: true,
      statusText: "Analysing your room, scene, objects and item reasoning.",
      nextActionText: NO_ACTION_WAIT,
    };
  }
  if (analysis && declutter) {
    return {
      ...base,
      currentStepId: "review",
      isComplete: false,
      processing: false,
      statusText: "ClearSpace suggested an action for each item it found.",
      nextActionText: "Review each item, then confirm the ones to Keep for reorganisation.",
    };
  }
  if (status === "error") {
    return {
      ...base,
      currentStepId: "upload",
      isComplete: false,
      processing: false,
      statusText: UPLOAD_ERROR_STATUS,
      nextActionText: UPLOAD_ERROR_NEXT,
    };
  }
  return {
    ...base,
    currentStepId: "upload",
    isComplete: false,
    processing: false,
    statusText: READY_STATUS,
    nextActionText: READY_NEXT,
  };
}
