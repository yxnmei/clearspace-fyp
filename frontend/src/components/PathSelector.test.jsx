import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import PathSelector from "./PathSelector";

describe("PathSelector", () => {
  test("clicking Declutter calls onChoose with \"declutter\"", async () => {
    const onChoose = vi.fn();
    render(<PathSelector onChoose={onChoose} />);
    await userEvent.click(screen.getByRole("button", { name: /^declutter/i }));
    expect(onChoose).toHaveBeenCalledWith("declutter");
  });

  test("clicking Reorganise calls onChoose with \"reorganise\"", async () => {
    const onChoose = vi.fn();
    render(<PathSelector onChoose={onChoose} />);
    // Anchored to the start — the Both card's own description text also
    // contains the word "reorganise" ("...then reorganise using only the
    // items...") and would otherwise match ambiguously.
    await userEvent.click(screen.getByRole("button", { name: /^reorganise/i }));
    expect(onChoose).toHaveBeenCalledWith("reorganise");
  });

  test("Both is rendered as a genuinely disabled button, clearly labelled", () => {
    render(<PathSelector onChoose={vi.fn()} />);
    const bothButton = screen.getByRole("button", { name: /both/i });
    expect(bothButton).toBeDisabled();
    expect(screen.getByText(/coming later/i)).toBeInTheDocument();
  });

  test("Both cannot trigger onChoose even if clicked", async () => {
    const onChoose = vi.fn();
    render(<PathSelector onChoose={onChoose} />);
    const bothButton = screen.getByRole("button", { name: /both/i });
    await userEvent.click(bothButton).catch(() => {}); // userEvent refuses to click a disabled button
    expect(onChoose).not.toHaveBeenCalled();
  });

  test("exactly three choices are rendered", () => {
    render(<PathSelector onChoose={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });
});
