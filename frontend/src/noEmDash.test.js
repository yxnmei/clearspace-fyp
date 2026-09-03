import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

// Regression guard for the "no application-authored em dashes" rule.
// Every frontend-authored .js/.jsx/.css file under src, plus index.html,
// must be free of the literal Unicode em dash (U+2014), in code, comments
// and test descriptions alike. Runtime model output and API response
// text are not source files and are out of scope.
const EM_DASH = String.fromCharCode(0x2014);
const projectRoot = process.cwd(); // vitest runs from frontend/
const srcRoot = join(projectRoot, "src");

function collectSourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, acc);
    else if (/\.(jsx?|css)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const files = [...collectSourceFiles(srcRoot), join(projectRoot, "index.html")];

describe("frontend-authored source has no literal em dash (U+2014)", () => {
  it("scans a non-trivial number of files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files.map((file) => [relative(projectRoot, file).replace(/\\/g, "/"), file]))(
    "%s",
    (_label, file) => {
      expect(readFileSync(file, "utf8").includes(EM_DASH)).toBe(false);
    }
  );
});
