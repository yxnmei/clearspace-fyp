import { describe, expect, test } from "vitest";
import {
  MAX_CORRECTED_LABEL_LENGTH,
  applyLabelCorrections,
  serialiseLabelCorrections,
  validateCorrectedLabel,
} from "./reorganiseLabelCorrections";

function makeItem(itemId, label) {
  return {
    item_id: itemId,
    clean_label: label,
    corrected_label: null,
    effective_label: label,
    label_source: "detector",
  };
}

describe("validateCorrectedLabel", () => {
  test("trims a valid label", () => {
    expect(validateCorrectedLabel("  charger ")).toEqual({ ok: true, value: "charger" });
  });

  test.each([["", "blank"], ["   ", "whitespace"], [null, "null"], [undefined, "undefined"], [42, "number"]])(
    "rejects %j (%s)",
    (value) => {
      expect(validateCorrectedLabel(value)).toEqual({ ok: false, error: "Enter a label." });
    }
  );

  test("accepts exactly the maximum length and rejects one more", () => {
    expect(validateCorrectedLabel("x".repeat(MAX_CORRECTED_LABEL_LENGTH)).ok).toBe(true);
    expect(validateCorrectedLabel("x".repeat(MAX_CORRECTED_LABEL_LENGTH + 1))).toEqual({
      ok: false,
      error: `Use ${MAX_CORRECTED_LABEL_LENGTH} characters or fewer.`,
    });
  });

  test.each(["phone\ncharger", "phone\tcharger", "phone\u0000charger"])("rejects control characters in %j", (value) => {
    expect(validateCorrectedLabel(value)).toEqual({ ok: false, error: "Use a single line of text." });
  });
});

describe("applyLabelCorrections", () => {
  test("returns new objects for corrected items only, keeping the detector label", () => {
    const items = [makeItem("item_001", "rope"), makeItem("item_002", "cable")];
    const before = structuredClone(items);

    const result = applyLabelCorrections(items, { item_001: "charger" });

    expect(result[0]).toEqual({
      item_id: "item_001",
      clean_label: "rope",
      corrected_label: "charger",
      effective_label: "charger",
      label_source: "user",
    });
    expect(result[1]).toBe(items[1]);
    expect(items).toEqual(before);
  });

  test("duplicate labels are corrected independently by item_id", () => {
    const items = [makeItem("item_001", "lamp"), makeItem("item_002", "lamp"), makeItem("item_003", "lamp")];
    const result = applyLabelCorrections(items, { item_002: "desk fan" });
    expect(result.map((item) => item.effective_label)).toEqual(["lamp", "desk fan", "lamp"]);
  });
});

describe("serialiseLabelCorrections", () => {
  test("produces the request field in analysis order", () => {
    const items = [makeItem("item_001", "rope"), makeItem("item_002", "cable"), makeItem("item_003", "lamp")];
    expect(serialiseLabelCorrections(items, { item_003: "desk fan", item_001: "charger" })).toEqual([
      { item_id: "item_001", corrected_label: "charger" },
      { item_id: "item_003", corrected_label: "desk fan" },
    ]);
  });

  test("is empty without corrections", () => {
    expect(serialiseLabelCorrections([makeItem("item_001", "rope")], {})).toEqual([]);
  });
});
