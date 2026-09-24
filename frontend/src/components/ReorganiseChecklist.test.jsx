import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import ReorganiseChecklist from "./ReorganiseChecklist";

const plan = {
  phases: [
    { phase_id: "empty_clean", title: "Empty and clean", steps: [
      { step_id: "empty_clean-1", text: "Clear the desk surface.", item_ids: [] },
      { step_id: "empty_clean-2", text: "Wipe the desk surface.", item_ids: [] },
    ] },
    { phase_id: "sort", title: "Sort", steps: [{ step_id: "sort-1", text: "File the books together.", item_ids: ["item_001"] }] },
  ],
};

describe("ReorganiseChecklist", () => {
  test("renders phase headings in order and exact accessible step names", () => {
    render(<ReorganiseChecklist tidyPlan={plan} />);
    expect(screen.getAllByRole("heading", { level: 4 }).map((node) => node.textContent)).toEqual(["Empty and clean", "Sort"]);
    expect(within(screen.getByRole("list", { name: "Empty and clean steps" })).getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"))).toEqual([
      "Clear the desk surface.", "Wipe the desk surface.", "File the books together.",
    ]);
    expect(screen.queryByTestId("checklist-step-number")).not.toBeInTheDocument();
  });

  test("ticking and unticking a step updates total progress", async () => {
    const user = userEvent.setup();
    render(<ReorganiseChecklist tidyPlan={plan} />);
    const first = screen.getByRole("checkbox", { name: "Clear the desk surface." });
    expect(screen.getByRole("progressbar", { name: "Checklist progress" })).toHaveAttribute("aria-valuenow", "0");
    await user.click(first);
    expect(first).toBeChecked();
    expect(screen.getByText("1 of 3 completed")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Checklist progress" })).toHaveAttribute("aria-valuenow", "1");
    await user.click(first);
    expect(first).not.toBeChecked();
    expect(screen.getByText("0 of 3 completed")).toBeInTheDocument();
  });

  test("a new keyed run remounts and resets local completion", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ReorganiseChecklist key="run1" tidyPlan={plan} />);
    await user.click(screen.getByRole("checkbox", { name: "Clear the desk surface." }));
    rerender(<ReorganiseChecklist key="run2" tidyPlan={plan} />);
    expect(screen.getByText("0 of 3 completed")).toBeInTheDocument();
  });

  test("keyboard: Tab reaches the first checkbox and Space toggles it", async () => {
    const user = userEvent.setup();
    render(<ReorganiseChecklist tidyPlan={plan} />);
    const first = screen.getByRole("checkbox", { name: "Clear the desk surface." });
    await user.tab();
    expect(first).toHaveFocus();
    await user.keyboard(" ");
    expect(first).toBeChecked();
    expect(screen.getByText("1 of 3 completed")).toBeInTheDocument();
    await user.keyboard(" ");
    expect(first).not.toBeChecked();
    expect(first.className).toMatch(/focus-visible:ring-2/);
  });

  test("ticking never mutates the supplied plan", async () => {
    const user = userEvent.setup();
    const supplied = JSON.parse(JSON.stringify(plan));
    const snapshot = JSON.stringify(supplied);
    render(<ReorganiseChecklist tidyPlan={supplied} />);
    await user.click(screen.getByRole("checkbox", { name: "Clear the desk surface." }));
    await user.click(screen.getByRole("checkbox", { name: "File the books together." }));
    expect(JSON.stringify(supplied)).toBe(snapshot);
    expect(supplied.phases[0].steps[0]).not.toHaveProperty("completed");
    expect(supplied.phases[0]).not.toHaveProperty("completed");
  });

  test("rendered copy contains no em dash", () => {
    const { container } = render(<ReorganiseChecklist tidyPlan={plan} />);
    expect(container.textContent).not.toContain("\u2014");
  });
});
