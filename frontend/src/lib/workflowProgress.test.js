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
    expect(labels(WORKFLOW_STEPS.declutter)).toEqual(["Upload", "Analyse", "Review", "Confirm", "Listings"]);
  });

  test("Direct Reorganise: Upload → Analyse → Review → Generate", () => {
    expect(ids(WORKFLOW_STEPS.reorganise)).toEqual(["upload", "analyse", "review", "generate"]);
    expect(labels(WORKFLOW_STEPS.reorganise)).toEqual(["Upload", "Analyse", "Review", "Generate"]);
  });

  test("Both: Upload → Analyse → Review → Confirm → Reorganise", () => {
    expect(ids(WORKFLOW_STEPS.both)).toEqual(["upload", "analyse", "review", "confirm", "reorganise"]);
    expect(labels(WORKFLOW_STEPS.both)).toEqual(["Upload", "Analyse", "Review", "Confirm", "Reorganise"]);
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
});
