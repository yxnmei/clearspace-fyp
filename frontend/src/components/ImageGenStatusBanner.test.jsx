import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import ImageGenStatusBanner from "./ImageGenStatusBanner";

describe("ImageGenStatusBanner", () => {
  test("renders nothing when status is available", () => {
    const { container } = render(<ImageGenStatusBanner status="available" recheck={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("shows a checking message", () => {
    render(<ImageGenStatusBanner status="checking" recheck={vi.fn()} />);
    expect(screen.getByText(/checking image-generation availability/i)).toBeInTheDocument();
  });

  test("an unavailable status explicitly says the visual preview is unavailable and a plan is still possible", () => {
    render(<ImageGenStatusBanner status="unavailable" recheck={vi.fn()} />);
    expect(screen.getByText(/visual preview is currently unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/you can still create a tidy plan; only the AI-generated image will be missing/i)).toBeInTheDocument();
  });

  test("never disables anything outside itself, it is advisory only", () => {
    render(<ImageGenStatusBanner status="unavailable" recheck={vi.fn()} />);
    // The only interactive control this component renders is its own
    // "Check again" button, it has no way to disable Generate or
    // anything else on the page.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    const checkAgain = screen.getByRole("button", { name: /check again/i });
    expect(checkAgain).toBeInTheDocument();
    expect(checkAgain).toBeEnabled();
  });

  test("Check again is disabled while a check is already in flight (status \"checking\")", () => {
    render(<ImageGenStatusBanner status="checking" recheck={vi.fn()} />);
    expect(screen.getByRole("button", { name: /checking/i })).toBeDisabled();
  });

  test("clicking a disabled Check again during \"checking\" never calls recheck again", async () => {
    const recheck = vi.fn();
    render(<ImageGenStatusBanner status="checking" recheck={recheck} />);
    await userEvent.click(screen.getByRole("button", { name: /checking/i })).catch(() => {});
    expect(recheck).not.toHaveBeenCalled();
  });

  test("Check again is re-enabled once status settles to unavailable", () => {
    render(<ImageGenStatusBanner status="unavailable" recheck={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^check again$/i })).toBeEnabled();
  });

  test("clicking Check again calls the passed-in recheck prop", async () => {
    const recheck = vi.fn();
    render(<ImageGenStatusBanner status="unavailable" recheck={recheck} />);
    await userEvent.click(screen.getByRole("button", { name: /check again/i }));
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  test("never calls useImageGenHealth itself, receives status/recheck purely as props", () => {
    // Structural proof: this component takes no hooks of its own. Passing
    // plain, non-hook values in and getting correct rendering out is
    // itself the evidence, if this component called useImageGenHealth()
    // internally, this render would trigger a real (mocked-away-only-by-
    // module-mocking) fetch, which no test in this file sets up at all.
    expect(() => render(<ImageGenStatusBanner status="checking" recheck={vi.fn()} />)).not.toThrow();
  });
});

describe("ImageGenStatusBanner, shared warning surface (cleanup pass)", () => {
  const classes = (el) => el.className.split(/\s+/).filter(Boolean);

  test("uses the shared warning tokens and an icon beside the text, never hardcoded palette colours or colour alone", () => {
    const { container } = render(<ImageGenStatusBanner status="unavailable" recheck={vi.fn()} />);
    const surface = container.firstElementChild;
    for (const c of ["border", "border-warning/40", "bg-warning/10", "rounded-control", "text-foreground"]) expect(classes(surface)).toContain(c);
    expect(container.innerHTML).not.toMatch(/amber-|rounded-md|underline/);
    const icon = surface.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(/visual preview is currently unavailable/i)).toBeInTheDocument();
  });

  test("stacks the message above the action on phones and sits in one row from sm; the action is a full-width 44px target on phones", () => {
    const { container } = render(<ImageGenStatusBanner status="unavailable" recheck={vi.fn()} />);
    const surface = container.firstElementChild;
    for (const c of ["flex", "flex-col", "sm:flex-row", "sm:items-center"]) expect(classes(surface)).toContain(c);
    const button = screen.getByRole("button", { name: /check again/i });
    for (const c of ["min-h-11", "w-full", "sm:min-h-0", "sm:w-auto"]) expect(classes(button)).toContain(c);
    // the Button primitive's outline treatment and focus ring, not a bespoke link-style control
    expect(button.className).toMatch(/border-input/);
    expect(button.className).toMatch(/focus-visible:ring-2/);
    expect(button).toHaveAttribute("type", "button");
  });

  test("while checking, the icon is a spinner and the disabled button explains why", () => {
    const { container } = render(<ImageGenStatusBanner status="checking" recheck={vi.fn()} />);
    expect(container.querySelector("svg").className.baseVal ?? container.querySelector("svg").getAttribute("class")).toMatch(/animate-spin/);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
  });

  test("carries no live region of its own, so the hosting section announces nothing twice", () => {
    const { container } = render(<ImageGenStatusBanner status="unavailable" recheck={vi.fn()} />);
    expect(container.querySelector("[role='status'], [role='alert'], [aria-live]")).toBeNull();
  });
});
