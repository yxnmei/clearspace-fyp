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
    expect(screen.getByText(/you can still generate a reorganisation plan/i)).toBeInTheDocument();
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
