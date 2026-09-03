// Vitest setup file (see vite.config.js's test.setupFiles), adds
// jest-dom's DOM-specific matchers (toBeInTheDocument, toHaveTextContent,
// etc.) to Vitest's `expect`. Nothing else global is enabled here,
// existing pure-function tests already import `describe`/`test`/`expect`
// explicitly from "vitest" and don't need this file at all.
import "@testing-library/jest-dom/vitest";

// React Testing Library's automatic post-test cleanup (unmounting
// whatever was rendered) normally hooks itself into a *global* afterEach
// that only exists when Vitest's `test.globals: true` is set, which
// this project deliberately does not enable (existing tests already
// import test/expect/etc. explicitly). So cleanup is wired up explicitly
// here instead, once, for every test file that renders a component.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
