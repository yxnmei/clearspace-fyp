import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import tailwindConfig from "../tailwind.config.js";

// Manrope is the frontend's primary sans-serif, bundled locally via
// @fontsource/manrope. These guards keep the configuration in place and
// keep the font off any runtime network request.

const readLocal = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("Manrope primary font", () => {
  it("is first in the Tailwind sans font stack", () => {
    expect(tailwindConfig.theme.extend.fontFamily.sans[0]).toBe("Manrope");
  });

  it("keeps a system-font fallback after Manrope", () => {
    const stack = tailwindConfig.theme.extend.fontFamily.sans;
    expect(stack.length).toBeGreaterThan(2);
    expect(stack).toContain("system-ui");
    expect(stack[stack.length - 1]).toMatch(/sans-serif|emoji/i);
  });

  it("bundles only the weights the interface uses, locally", () => {
    const main = readLocal("./main.jsx");
    for (const weight of [400, 500, 600, 700]) {
      expect(main).toContain(`@fontsource/manrope/latin-${weight}.css`);
    }
    expect(main).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|cdn/i);
  });

  it("is declared as a bundled dependency, not a dev dependency", () => {
    const pkg = JSON.parse(readLocal("../package.json"));
    expect(pkg.dependencies["@fontsource/manrope"]).toBeTruthy();
    expect(pkg.devDependencies?.["@fontsource/manrope"]).toBeUndefined();
  });

  it("pins native form controls to the shared font stack", () => {
    const css = readLocal("./index.css");
    expect(css).toMatch(/button,\s*\n\s*input,[\s\S]*textarea\s*\{\s*\n\s*font-family: theme\("fontFamily\.sans"\);/);
  });
});
