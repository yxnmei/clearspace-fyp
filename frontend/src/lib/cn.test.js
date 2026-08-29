import { describe, expect, test } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  test("joins plain class strings", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  test("drops falsy values and respects conditional objects/arrays", () => {
    expect(cn("a", false && "b", null, undefined, ["c", 0, "d"])).toBe("a c d");
    expect(cn("base", { active: true, disabled: false })).toBe("base active");
  });

  test("later Tailwind utility wins on a conflict", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
    expect(cn("text-sm text-muted-foreground", "text-foreground")).toBe("text-sm text-foreground");
  });

  test("merges conflicting design-token colours to the last one", () => {
    expect(cn("bg-primary", "bg-accent")).toBe("bg-accent");
  });

  test("keeps non-conflicting utilities from both inputs", () => {
    expect(cn("rounded-card border", "shadow-card")).toBe("rounded-card border shadow-card");
  });
});
