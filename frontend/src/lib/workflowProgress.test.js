import { describe, expect, test } from "vitest";
import {
  WORKFLOW_STEPS,
  deriveReorganiseProgress,
  deriveBothProgress,
} from "./workflowProgress";

const ids = (steps) => steps.map((s) => s.id);
const labels = (steps) => steps.map((s) => s.label);

describe("WORKFLOW_STEPS, each workflow's exact sequence", () => {
  test("Declutter: Upload → Analyse → Review → Confirm → Listings", () => {
    expect(ids(WORKFLOW_STEPS.declutter)).toEqual(["upload", "analyse", "review", "confirm", "listings"]);
    expect(labels(WORKFLOW_STEPS.declutter)).toEqual(["Upload photo", "Analyse space", "Decide items", "Confirm choices", "Listing drafts"]);
  });

  test("Direct Reorganise: Upload → Analyse → Review → Generate", () => {
    expect(ids(WORKFLOW_STEPS.reorganise)).toEqual(["upload", "analyse", "review", "generate"]);
    expect(labels(WORKFLOW_STEPS.reorganise)).toEqual(["Upload photo", "Analyse space", "Select items", "Tidy plan"]);
  });

  test("Both: Upload → Analyse → Review → Confirm → Reorganise", () => {
    expect(ids(WORKFLOW_STEPS.both)).toEqual(["upload", "analyse", "review", "confirm", "reorganise"]);
    expect(labels(WORKFLOW_STEPS.both)).toEqual(["Upload photo", "Analyse space", "Decide items", "Confirm choices", "Results"]);
  });
});

describe("deriveReorganiseProgress, all five phases", () => {
  test('"upload" → Upload current', () => {
    expect(deriveReorganiseProgress({ phase: "upload" }).currentStepId).toBe("upload");
  });

  test('"upload" with uploadError → still Upload, retry guidance', () => {
    const p = deriveReorganiseProgress({ phase: "upload", uploadError: "boom" });
    expect(p.currentStepId).toBe("upload");
    expect(p.processing).toBe(false);
    expect(p.nextActionText).toMatch(/retry/i);
  });

  test('"analysing" → Analyse current and processing', () => {
    const p = deriveReorganiseProgress({ phase: "analysing" });
    expect(p.currentStepId).toBe("analyse");
    expect(p.processing).toBe(true);
  });

  test('"selecting" → Review current', () => {
    const p = deriveReorganiseProgress({ phase: "selecting" });
    expect(p.currentStepId).toBe("review");
    expect(p.processing).toBe(false);
  });

  test('"selecting" with generateError → Generate current, retry guidance, not processing, not complete', () => {
    const p = deriveReorganiseProgress({ phase: "selecting", generateError: "nope" });
    expect(p.currentStepId).toBe("generate");
    expect(p.processing).toBe(false);
    expect(p.isComplete).toBe(false);
    expect(p.nextActionText).toMatch(/again/i);
  });

  test('"generating" → Generate current and processing', () => {
    const p = deriveReorganiseProgress({ phase: "generating" });
    expect(p.currentStepId).toBe("generate");
    expect(p.processing).toBe(true);
  });

  test('"result" → Generate completed and workflow complete', () => {
    const p = deriveReorganiseProgress({ phase: "result" });
    expect(p.currentStepId).toBe("generate");
    expect(p.isComplete).toBe(true);
    expect(p.processing).toBe(false);
  });
});

describe("deriveBothProgress", () => {
  const analysed = { status: "ready", analysis: {}, declutter: {} };

  test("initial → Upload", () => {
    expect(deriveBothProgress({ status: "idle" }).currentStepId).toBe("upload");
  });

  test("upload error without analysis → Upload with retry guidance", () => {
    const p = deriveBothProgress({ status: "error", analysis: null, declutter: null });
    expect(p.currentStepId).toBe("upload");
    expect(p.nextActionText).toMatch(/retry/i);
  });

  test("uploading → Analyse and processing", () => {
    const p = deriveBothProgress({ status: "uploading" });
    expect(p.currentStepId).toBe("analyse");
    expect(p.processing).toBe(true);
  });

  test("analysis available before confirmation → Review", () => {
    const p = deriveBothProgress({ ...analysed, confirmationStatus: "idle", confirmation: null });
    expect(p.currentStepId).toBe("review");
  });

  test("confirming → Confirm and processing", () => {
    const p = deriveBothProgress({ ...analysed, confirmationStatus: "confirming", confirmation: null });
    expect(p.currentStepId).toBe("confirm");
    expect(p.processing).toBe(true);
  });

  test("confirmation error → Confirm with retry guidance", () => {
    const p = deriveBothProgress({ ...analysed, confirmationStatus: "error", confirmation: null });
    expect(p.currentStepId).toBe("confirm");
    expect(p.processing).toBe(false);
    expect(p.nextActionText).toMatch(/try again/i);
  });

  test("confirmed Keep set with ≥1 item → Reorganise current (ready to continue), not complete", () => {
    const p = deriveBothProgress({ ...analysed, confirmationStatus: "confirmed", confirmation: { confirmedKeepIds: ["item_001"] } });
    expect(p.currentStepId).toBe("reorganise");
    expect(p.isComplete).toBe(false);
    expect(p.processing).toBe(false);
  });

  test("confirmed with ZERO Keep items unlocks the final actions screen for possible Sell listings", () => {
    const p = deriveBothProgress({ ...analysed, confirmationStatus: "confirmed", confirmation: { confirmedKeepIds: [] } });
    expect(p.currentStepId).toBe("reorganise");
    expect(p.unlockedStepIds).toContain("reorganise");
    expect(p.isComplete).toBe(false);
    expect(p.processing).toBe(false);
    expect(p.nextActionText).toMatch(/independently/i);
  });

  test("generating → Reorganise and processing", () => {
    const p = deriveBothProgress({ ...analysed, confirmationStatus: "confirmed", confirmation: { confirmedKeepIds: ["item_001"] }, generationStatus: "generating" });
    expect(p.currentStepId).toBe("reorganise");
    expect(p.processing).toBe(true);
    expect(p.isComplete).toBe(false);
  });

  test("generation error → Reorganise with retry guidance, not complete", () => {
    const p = deriveBothProgress({ ...analysed, confirmationStatus: "confirmed", confirmation: { confirmedKeepIds: ["item_001"] }, generationStatus: "error" });
    expect(p.currentStepId).toBe("reorganise");
    expect(p.processing).toBe(false);
    expect(p.isComplete).toBe(false);
    expect(p.nextActionText).toMatch(/try again/i);
  });

  test("generated result → Reorganise completed and workflow complete", () => {
    const p = deriveBothProgress({ ...analysed, confirmationStatus: "confirmed", confirmation: { confirmedKeepIds: ["item_001"] }, generationStatus: "done", generateResult: {} });
    expect(p.currentStepId).toBe("reorganise");
    expect(p.isComplete).toBe(true);
    expect(p.processing).toBe(false);
  });

  test("honest unavailable-preview result still completes Reorganise", () => {
    // useBothFlow reports generationStatus "done" with a generateResult
    // whose imageStatus is "unavailable", a successful outcome.
    const p = deriveBothProgress({
      ...analysed,
      confirmationStatus: "confirmed",
      confirmation: { confirmedKeepIds: ["item_001"] },
      generationStatus: "done",
      generateResult: { imageStatus: "unavailable" },
    });
    expect(p.isComplete).toBe(true);
    expect(p.currentStepId).toBe("reorganise");
  });

  describe("Results status copy uses the redesigned terms without changing state logic", () => {
    const confirmed = { ...analysed, confirmationStatus: "confirmed", confirmation: { confirmedKeepIds: ["item_001"] }, viewedStep: "reorganise" };

    test("idle: either action, in either order", () => {
      const p = deriveBothProgress(confirmed);
      expect(p.statusText).toBe("Choose your next action.");
      expect(p.nextActionText).toBe("Create a tidy plan or listing drafts independently, in either order.");
      expect(p.processing).toBe(false);
      expect(p.isComplete).toBe(false);
    });

    test("tidy plan generating: listings remain available", () => {
      const p = deriveBothProgress({ ...confirmed, generationStatus: "generating" });
      expect(p.statusText).toBe("Creating your tidy plan…");
      expect(p.nextActionText).toBe("Listings remain independently available on this screen.");
      expect(p.processing).toBe(true);
    });

    test("listings generating: Tidy up remains available", () => {
      const p = deriveBothProgress({ ...confirmed, listingStatus: "generating" });
      expect(p.statusText).toBe("Generating your listing drafts…");
      expect(p.nextActionText).toBe("Tidy up remains independently available on this screen.");
      expect(p.processing).toBe(true);
    });

    test("one draft regenerating: Tidy up and other drafts unaffected", () => {
      const p = deriveBothProgress({ ...confirmed, regeneratingItemId: "item_002" });
      expect(p.statusText).toBe("Regenerating one listing draft…");
      expect(p.nextActionText).toBe("Tidy up and your other drafts are unaffected.");
      expect(p.processing).toBe(true);
    });

    test("tidy plan error and completion wording", () => {
      const failed = deriveBothProgress({ ...confirmed, generationStatus: "error" });
      expect(failed.statusText).toBe("The tidy plan didn't finish.");
      expect(failed.nextActionText).toMatch(/try again below/i);
      expect(failed.isComplete).toBe(false);
      const done = deriveBothProgress({ ...confirmed, generationStatus: "done", generateResult: {} });
      expect(done.statusText).toBe("Your tidy plan is ready.");
      expect(done.isComplete).toBe(true);
      expect(done.processing).toBe(false);
    });

    test("no user-facing reorganisation or room wording remains in the Results copy", () => {
      for (const extra of [{}, { generationStatus: "generating" }, { listingStatus: "generating" }, { regeneratingItemId: "item_002" }, { generationStatus: "error" }, { generationStatus: "done", generateResult: {} }]) {
        const p = deriveBothProgress({ ...confirmed, ...extra });
        expect(`${p.statusText} ${p.nextActionText}`).not.toMatch(/reorganis|\broom\b/i);
      }
      // step ids, count and unlock rules are untouched
      const p = deriveBothProgress({ ...confirmed, generationStatus: "generating" });
      expect(p.steps.map((s) => s.id)).toEqual(["upload", "analyse", "review", "confirm", "reorganise"]);
      expect(p.unlockedStepIds).toContain("reorganise");
      expect(p.navigationLocked).toBe(true);
    });
  });
});

describe("deriveReorganiseProgress, tidy plan and analysing copy (cleanup pass)", () => {
  test("Tidy plan step uses tidy plan terms, never reorganisation-plan or generate wording", () => {
    const ready = deriveReorganiseProgress({ phase: "selecting", viewedStep: "generate", reviewAcknowledged: true });
    expect(ready.statusText).toBe("Ready to create your tidy plan.");
    expect(ready.nextActionText).toBe("Press Create tidy plan when you are ready.");

    const generating = deriveReorganiseProgress({ phase: "generating" });
    expect(generating.statusText).toBe("Creating your tidy plan…");
    expect(generating.processing).toBe(true);

    const result = deriveReorganiseProgress({ phase: "result" });
    expect(result.statusText).toBe("Your tidy plan is ready.");
    expect(result.nextActionText).toBe("Review your checklist, any storage and organisation ideas and the visual preview below.");
    expect(result.isComplete).toBe(true);

    const failed = deriveReorganiseProgress({ phase: "selecting", generateError: "nope" });
    expect(failed.statusText).toBe("The tidy plan didn't finish.");
    expect(failed.nextActionText).toBe("Your selection is unchanged. Try again below.");
    expect(failed.isComplete).toBe(false);

    const none = deriveReorganiseProgress({ phase: "selecting", selectedItemCount: 0 });
    expect(none.statusText).toBe("Nothing is included in your tidy plan.");

    for (const p of [ready, generating, result, failed, none]) {
      expect(`${p.statusText} ${p.nextActionText}`).not.toMatch(/reorganisation plan|generate|\broom\b|writing your checklist/i);
    }
  });

  test("the analysing status names no pipeline stages in any workflow", () => {
    expect(deriveReorganiseProgress({ phase: "analysing" }).statusText).toBe("Analysing your space…");
    const both = deriveBothProgress({ status: "uploading" });
    expect(both.statusText).toBe("Analysing your space…");
    for (const text of [deriveReorganiseProgress({ phase: "analysing" }).statusText, both.statusText]) {
      expect(text).not.toMatch(/scene|object|reasoning|classification|detection/i);
    }
  });

  test("step ids, labels, unlocking and locking are untouched by the copy change", () => {
    const generating = deriveReorganiseProgress({ phase: "generating" });
    expect(generating.steps.map((s) => s.id)).toEqual(["upload", "analyse", "review", "generate"]);
    expect(generating.steps.map((s) => s.label)).toEqual(["Upload photo", "Analyse space", "Select items", "Tidy plan"]);
    expect(generating.navigationLocked).toBe(true);
    expect(generating.currentStepId).toBe("generate");
    const result = deriveReorganiseProgress({ phase: "result" });
    expect(result.completedStepIds).toEqual(["upload", "analyse", "review", "generate"]);
  });
});
