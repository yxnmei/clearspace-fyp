import { describe, expect, test } from "vitest";
import { DECLUTTER_WIZARD_STEPS, deriveDeclutterWizard } from "./declutterWizard";

const idle = { status: "idle", hasAnalysis: false, confirmationStatus: "idle", hasConfirmation: false };
const analysed = { status: "ready", hasAnalysis: true, confirmationStatus: "idle", hasConfirmation: false };

describe("DECLUTTER_WIZARD_STEPS", () => {
  test("is Upload → Analyse → Review → Confirm", () => {
    expect(DECLUTTER_WIZARD_STEPS.map((s) => s.id)).toEqual(["upload", "analyse", "review", "confirm"]);
  });
});

describe("deriveDeclutterWizard, unlocking", () => {
  test("initially only Upload is unlocked and viewed; nothing is completed", () => {
    const w = deriveDeclutterWizard({ ...idle, viewedStep: "upload" });
    expect(w.unlockedStepIds).toEqual(["upload"]);
    expect(w.completedStepIds).toEqual([]);
    expect(w.viewedStepId).toBe("upload");
    expect(w.navigationLocked).toBe(false);
  });

  test("submitting Upload unlocks Analyse and completes Upload", () => {
    const w = deriveDeclutterWizard({ status: "uploading", hasAnalysis: false, confirmationStatus: "idle", viewedStep: "analyse" });
    expect(w.unlockedStepIds).toEqual(["upload", "analyse"]);
    expect(w.completedStepIds).toEqual(["upload"]);
    expect(w.viewedStepId).toBe("analyse");
    expect(w.navigationLocked).toBe(true); // uploading in flight
    expect(w.processing).toBe(true);
  });

  test("Review unlocks only after analysis succeeds, never merely by entering Analyse", () => {
    const uploading = deriveDeclutterWizard({ status: "uploading", hasAnalysis: false, viewedStep: "analyse" });
    expect(uploading.unlockedStepIds).not.toContain("review");

    const done = deriveDeclutterWizard({ ...analysed, viewedStep: "analyse" });
    expect(done.unlockedStepIds).toContain("review");
    expect(done.completedStepIds).toEqual(["upload", "analyse"]);
  });

  test("Analyse success is not auto-skipped, a Continue target to Review is offered, but the viewed step stays Analyse", () => {
    const w = deriveDeclutterWizard({ ...analysed, viewedStep: "analyse" });
    expect(w.viewedStepId).toBe("analyse");
    expect(w.canContinue).toBe(true);
    expect(w.continueTargetId).toBe("review");
  });

  test("Confirm unlocks only after explicit acknowledgement from Review", () => {
    const notYet = deriveDeclutterWizard({ ...analysed, viewedStep: "review", confirmAcknowledged: false });
    expect(notYet.unlockedStepIds).not.toContain("confirm");

    const acked = deriveDeclutterWizard({ ...analysed, viewedStep: "review", confirmAcknowledged: true });
    expect(acked.unlockedStepIds).toContain("confirm");
    expect(acked.completedStepIds).toContain("review");
  });

  test("Review Continue is blocked by unresolved items", () => {
    const w = deriveDeclutterWizard({ ...analysed, viewedStep: "review", unresolvedCount: 2 });
    expect(w.canContinueFromReview).toBe(false);
    expect(w.canContinue).toBe(false);
    expect(w.statusText).toMatch(/still need a valid decision/i);
  });

  test("Review Continue is blocked while a label correction is in flight", () => {
    const w = deriveDeclutterWizard({ ...analysed, viewedStep: "review", correctingItemId: "item_003" });
    expect(w.canContinueFromReview).toBe(false);
    expect(w.canContinue).toBe(false);
  });

  test("Review Continue is available when clean, and targets Confirm", () => {
    const w = deriveDeclutterWizard({ ...analysed, viewedStep: "review" });
    expect(w.canContinueFromReview).toBe(true);
    expect(w.canContinue).toBe(true);
    expect(w.continueTargetId).toBe("confirm");
  });

  test("a re-upload relocks Review and Confirm (analysis cleared, acknowledgement irrelevant without a result)", () => {
    // status "uploading" again, hasAnalysis false, even if the page still
    // carried confirmAcknowledged from a previous run.
    const w = deriveDeclutterWizard({
      status: "uploading",
      hasAnalysis: false,
      confirmationStatus: "idle",
      viewedStep: "confirm",
      confirmAcknowledged: true,
    });
    expect(w.unlockedStepIds).toEqual(["upload", "analyse"]);
    expect(w.viewedStepId).toBe("analyse"); // stale "confirm" clamped to furthest unlocked
  });

  test("navigation is locked while confirming, and unlocked again on confirmed/error", () => {
    const confirming = deriveDeclutterWizard({ ...analysed, viewedStep: "confirm", confirmAcknowledged: true, confirmationStatus: "confirming" });
    expect(confirming.navigationLocked).toBe(true);
    expect(confirming.canGoBack).toBe(false);
    expect(confirming.processing).toBe(true);

    const confirmed = deriveDeclutterWizard({ ...analysed, viewedStep: "confirm", confirmAcknowledged: true, confirmationStatus: "confirmed", hasConfirmation: true });
    expect(confirmed.navigationLocked).toBe(false);
    expect(confirmed.canGoBack).toBe(true);
    expect(confirmed.completedStepIds).toContain("confirm");
  });

  test("Back target follows the ordered sequence and is unavailable on Upload", () => {
    expect(deriveDeclutterWizard({ ...idle, viewedStep: "upload" }).backTargetId).toBe(null);
    expect(deriveDeclutterWizard({ ...analysed, viewedStep: "analyse" }).backTargetId).toBe("upload");
    expect(deriveDeclutterWizard({ ...analysed, viewedStep: "review" }).backTargetId).toBe("analyse");
    expect(
      deriveDeclutterWizard({ ...analysed, viewedStep: "confirm", confirmAcknowledged: true }).backTargetId
    ).toBe("review");
  });

  test("provides a factual stage ordinal and the next step label, never a percentage", () => {
    const w = deriveDeclutterWizard({ ...analysed, viewedStep: "review" });
    expect(w.ordinalText).toBe("Step 3 of 4 · Review");
    expect(w.nextStepLabel).toBe("Confirm");
    expect(JSON.stringify(w)).not.toMatch(/%|percent/i);
  });
});
