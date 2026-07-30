import { describe, expect, it } from "vitest";
import { decisionColor, formatConfidence } from "./format";

describe("formatConfidence", () => {
  it("formats a 0-1 confidence as a rounded percentage", () => {
    expect(formatConfidence(0.976)).toBe("98%");
  });

  it("handles missing confidence gracefully", () => {
    expect(formatConfidence(null)).toBe("—");
    expect(formatConfidence(undefined)).toBe("—");
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
