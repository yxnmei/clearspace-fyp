import { describe, expect, it } from "vitest";
import * as format from "./format";
import { decisionBorderColor, itemNumberLabel } from "./format";

describe("removed display helpers", () => {
  it("no longer exports formatConfidence or decisionColor: no screen shows a confidence percentage or a colour-only decision cue", () => {
    expect(format).not.toHaveProperty("formatConfidence");
    expect(format).not.toHaveProperty("decisionColor");
  });
});

describe("decisionBorderColor", () => {
  it("maps known decisions to distinct border classes", () => {
    expect(decisionBorderColor("keep")).toContain("green");
    expect(decisionBorderColor("sell")).toContain("blue");
    expect(decisionBorderColor("donate")).toContain("amber");
    expect(decisionBorderColor("discard")).toContain("red");
  });

  it("falls back gracefully for an unknown or missing decision", () => {
    expect(decisionBorderColor("unknown-thing")).toContain("stone");
    expect(decisionBorderColor(null)).toContain("stone");
  });
});

describe("itemNumberLabel", () => {
  it("strips the item_ prefix and leading zeros", () => {
    expect(itemNumberLabel("item_001")).toBe("1");
    expect(itemNumberLabel("item_028")).toBe("28");
    expect(itemNumberLabel("item_100")).toBe("100");
  });

  it("stays stable across re-sorts, derived from the id only", () => {
    expect(itemNumberLabel("item_004")).toBe("4");
    expect(itemNumberLabel("item_004")).toBe("4");
  });

  it("falls back to the raw value for a malformed or missing id", () => {
    expect(itemNumberLabel("not-an-id")).toBe("not-an-id");
    expect(itemNumberLabel(null)).toBe("?");
    expect(itemNumberLabel(undefined)).toBe("?");
  });
});
