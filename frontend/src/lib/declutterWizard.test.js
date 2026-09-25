import { describe, expect, test } from "vitest";
import { DECLUTTER_WIZARD_STEPS, deriveDeclutterWizard } from "./declutterWizard";

const idle = { status: "idle", hasAnalysis: false, confirmationStatus: "idle", hasConfirmation: false };
const analysed = { status: "ready", hasAnalysis: true, confirmationStatus: "idle", hasConfirmation: false };
const confirmedBase = {
  status: "ready",
  hasAnalysis: true,
  confirmationStatus: "confirmed",
  hasConfirmation: true,
  confirmAcknowledged: true,
};

describe("DECLUTTER_WIZARD_STEPS", () => {
  test("is Upload → Analyse → Review → Confirm → Listings", () => {
    expect(DECLUTTER_WIZARD_STEPS.map((s) => s.id)).toEqual([
      "upload",
      "analyse",
      "review",
      "confirm",
      "listings",
    ]);
    expect(DECLUTTER_WIZARD_STEPS.map((s) => s.label)).toEqual([
      "Upload photo",
      "Analyse space",
      "Decide items",
      "Confirm choices",
      "Results",
    ]);
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
    expect(w.ordinalText).toBe("Step 3 of 5 · Decide items");
    expect(w.nextStepLabel).toBe("Confirm choices");
    expect(JSON.stringify(w)).not.toMatch(/%|percent/i);
  });
});

describe("deriveDeclutterWizard, Listings step (Stage 4B)", () => {
  test("Listings is locked before a successful current confirmation", () => {
    const confirming = deriveDeclutterWizard({
      ...analysed,
      viewedStep: "confirm",
      confirmAcknowledged: true,
      confirmationStatus: "confirming",
    });
    expect(confirming.unlockedStepIds).not.toContain("listings");

    const errored = deriveDeclutterWizard({
      ...analysed,
      viewedStep: "confirm",
      confirmAcknowledged: true,
      confirmationStatus: "error",
      hasConfirmation: false,
    });
    expect(errored.unlockedStepIds).not.toContain("listings");
  });

  test("a successful current confirmation unlocks Listings", () => {
    const w = deriveDeclutterWizard({ ...confirmedBase, viewedStep: "confirm" });
    expect(w.unlockedStepIds).toContain("listings");
  });

  test("Confirm offers an explicit Continue to Listings only once confirmed", () => {
    const notYet = deriveDeclutterWizard({ ...analysed, viewedStep: "confirm", confirmAcknowledged: true });
    expect(notYet.viewedStepId).toBe("confirm");
    expect(notYet.canContinue).toBe(false);

    const w = deriveDeclutterWizard({ ...confirmedBase, viewedStep: "confirm" });
    expect(w.canContinue).toBe(true);
    expect(w.continueTargetId).toBe("listings");
    expect(w.nextStepLabel).toBe("Results");
  });

  test("confirming alone does not navigate to or complete Listings (no automatic generation)", () => {
    const w = deriveDeclutterWizard({ ...confirmedBase, viewedStep: "confirm", eligibleSellCount: 2 });
    // Still viewing Confirm: reaching a successful confirmation never
    // moves the viewed step by itself, and with eligible Sell items
    // outstanding, Listings is not complete until it has actually been
    // asked to generate (listingStatus defaults to "idle" here).
    expect(w.viewedStepId).toBe("confirm");
    expect(w.completedStepIds).not.toContain("listings");
  });

  test("Back from Listings returns to Confirm", () => {
    const w = deriveDeclutterWizard({ ...confirmedBase, viewedStep: "listings" });
    expect(w.backTargetId).toBe("confirm");
    expect(w.canGoBack).toBe(true);
  });

  test("invalidating the confirmation relocks Listings and clamps a stale viewedStep back", () => {
    const w = deriveDeclutterWizard({
      status: "ready",
      hasAnalysis: true,
      confirmationStatus: "idle", // invalidated by a decision edit, e.g.
      hasConfirmation: false,
      confirmAcknowledged: true,
      viewedStep: "listings", // stale: was viewing Listings before invalidation
      listingStatus: "ready", // stale hook state too, does not resurrect the step
      eligibleSellCount: 2,
    });
    expect(w.unlockedStepIds).not.toContain("listings");
    expect(w.viewedStepId).toBe("confirm"); // clamped to the furthest still-unlocked step
  });

  test("a new upload relocks Listings along with Review and Confirm", () => {
    const w = deriveDeclutterWizard({
      status: "uploading",
      hasAnalysis: false,
      confirmationStatus: "idle",
      hasConfirmation: false,
      viewedStep: "listings",
      confirmAcknowledged: true,
      listingStatus: "ready",
      eligibleSellCount: 3,
    });
    expect(w.unlockedStepIds).toEqual(["upload", "analyse"]);
    expect(w.viewedStepId).toBe("analyse");
  });

  test("navigation is locked while a listing batch is generating", () => {
    const w = deriveDeclutterWizard({ ...confirmedBase, viewedStep: "listings", listingStatus: "generating" });
    expect(w.navigationLocked).toBe(true);
    expect(w.canGoBack).toBe(false);
    expect(w.processing).toBe(true);
  });

  test("navigation is locked while a single item is regenerating", () => {
    const w = deriveDeclutterWizard({
      ...confirmedBase,
      viewedStep: "listings",
      listingStatus: "ready",
      eligibleSellCount: 1,
      regeneratingItemId: "item_003",
    });
    expect(w.navigationLocked).toBe(true);
    expect(w.canGoBack).toBe(false);
  });

  test("editing, copying, discarding and restoring are presentation-only and never lock navigation", () => {
    // These local actions never change listingStatus or regeneratingItemId,
    // so a "ready" batch with edits/discards applied looks identical here
    // to one without: this module receives no edit/discard/copy signal at
    // all, which is itself the guarantee.
    const w = deriveDeclutterWizard({
      ...confirmedBase,
      viewedStep: "listings",
      listingStatus: "ready",
      eligibleSellCount: 2,
    });
    expect(w.navigationLocked).toBe(false);
    expect(w.canGoBack).toBe(true);
  });

  describe("Listings status/next-action text", () => {
    test("zero eligible Sell items", () => {
      const w = deriveDeclutterWizard({ ...confirmedBase, viewedStep: "listings", eligibleSellCount: 0 });
      expect(w.statusText).toMatch(/declutter is complete/i);
      expect(w.nextActionText).toMatch(/nothing was confirmed as sell/i);
      expect(w.nextActionText).toMatch(/no listing drafts/i);
    });

    test("idle with eligible items ready to generate", () => {
      const w = deriveDeclutterWizard({
        ...confirmedBase,
        viewedStep: "listings",
        listingStatus: "idle",
        eligibleSellCount: 2,
      });
      expect(w.statusText).toMatch(/ready to generate listing drafts/i);
      expect(w.nextActionText).toMatch(/press generate listing drafts/i);
    });

    test("batch generating", () => {
      const w = deriveDeclutterWizard({
        ...confirmedBase,
        viewedStep: "listings",
        listingStatus: "generating",
        eligibleSellCount: 2,
      });
      expect(w.statusText).toMatch(/generating your listing drafts/i);
      expect(w.processing).toBe(true);
    });

    test("batch error and retry", () => {
      const w = deriveDeclutterWizard({
        ...confirmedBase,
        viewedStep: "listings",
        listingStatus: "error",
        eligibleSellCount: 2,
      });
      expect(w.statusText).toMatch(/didn't go through/i);
      expect(w.nextActionText).toMatch(/press try again/i);
    });

    test("drafts ready", () => {
      const w = deriveDeclutterWizard({
        ...confirmedBase,
        viewedStep: "listings",
        listingStatus: "ready",
        eligibleSellCount: 2,
      });
      expect(w.statusText).toMatch(/declutter is complete/i);
      expect(w.nextActionText).toMatch(/confirmed choices and listing drafts are below/i);
      expect(w.nextActionText).toMatch(/edit, copy, regenerate or discard/i);
    });

    test("one item regenerating", () => {
      const w = deriveDeclutterWizard({
        ...confirmedBase,
        viewedStep: "listings",
        listingStatus: "ready",
        eligibleSellCount: 2,
        regeneratingItemId: "item_002",
      });
      expect(w.statusText).toMatch(/regenerating one listing draft/i);
      expect(w.processing).toBe(true);
    });

    test("item-specific regeneration failure", () => {
      const w = deriveDeclutterWizard({
        ...confirmedBase,
        viewedStep: "listings",
        listingStatus: "ready",
        eligibleSellCount: 2,
        regenerationError: { itemId: "item_002", message: "Listing draft regeneration failed" },
      });
      expect(w.statusText).toMatch(/could not be regenerated/i);
      expect(w.nextActionText).toMatch(/every other draft is unaffected/i);
    });
  });

  describe("Listings completion rules", () => {
    test("a confirmed run with zero eligible Sell items is complete without ever generating", () => {
      const w = deriveDeclutterWizard({
        ...confirmedBase,
        viewedStep: "listings",
        listingStatus: "idle",
        eligibleSellCount: 0,
      });
      expect(w.completedStepIds).toContain("listings");
    });

    test("is not complete while idle, generating, or errored with eligible items outstanding", () => {
      for (const listingStatus of ["idle", "generating", "error"]) {
        const w = deriveDeclutterWizard({
          ...confirmedBase,
          viewedStep: "listings",
          listingStatus,
          eligibleSellCount: 2,
        });
        expect(w.completedStepIds).not.toContain("listings");
      }
    });

    test("is complete once the batch is ready", () => {
      const w = deriveDeclutterWizard({
        ...confirmedBase,
        viewedStep: "listings",
        listingStatus: "ready",
        eligibleSellCount: 2,
      });
      expect(w.completedStepIds).toContain("listings");
    });

    test("local edits/discards (no listingStatus change) do not make a ready step incomplete", () => {
      // There is no edit/discard input to this module at all; a ready
      // batch stays complete regardless of any local overlay state.
      const w = deriveDeclutterWizard({
        ...confirmedBase,
        viewedStep: "listings",
        listingStatus: "ready",
        eligibleSellCount: 2,
      });
      expect(w.completedStepIds).toContain("listings");
    });
  });
});
