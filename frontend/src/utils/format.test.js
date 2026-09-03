import { describe, expect, it } from "vitest";
import { decisionBorderColor, decisionColor, formatConfidence, itemNumberLabel } from "./format";

describe("formatConfidence", () => {
  it("formats a 0-1 confidence as a rounded percentage", () => {
    expect(formatConfidence(0.976)).toBe("98%");
  });

  it("handles missing confidence gracefully", () => {
    expect(formatConfidence(null)).toBe("n/a");
    expect(formatConfidence(undefined)).toBe("n/a");
  });
});

describe("decisionColor", () => {
  it("maps known decisions to distinct classes", () => {
    expect(decisionColor("keep")).toContain("green");
    expect(decisionColor("sell")).toContain("blue");
    expect(decisionColor("donate")).toContain("amber");
    expect(decisionColor("discard")).toContain("red");
  });

  it("falls back gracefully for an unknown decision", () => {
    expect(decisionColor("unknown-thing")).toContain("gray");
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
