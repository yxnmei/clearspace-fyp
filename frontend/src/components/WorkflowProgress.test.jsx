import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import WorkflowProgress from "./WorkflowProgress";

const DECLUTTER_STEPS = [
  { id: "upload", label: "Upload" },
  { id: "analyse", label: "Analyse" },
  { id: "review", label: "Review" },
  { id: "confirm", label: "Confirm" },
];

function renderProgress(overrides = {}) {
  return render(
    <WorkflowProgress
      workflowName="Declutter"
      steps={DECLUTTER_STEPS}
      currentStepId="review"
      isComplete={false}
      processing={false}
      statusText="Doing the thing."
      nextActionText="Do the next thing."
      {...overrides}
    />
  );
}

describe("WorkflowProgress, structure and semantics", () => {
  test("is a labelled nav containing an ordered list of every step, in order", () => {
    renderProgress();
    const nav = screen.getByRole("navigation", { name: /declutter workflow progress/i });
    const items = within(nav).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items.map((li) => li.textContent.replace(/\d+/g, "").trim())).toEqual([
      "Upload",
      "Analyse",
      "Review",
      "Confirm",
    ]);
  });

  test("exactly one step is aria-current='step' during an active workflow", () => {
    renderProgress({ currentStepId: "review" });
    const current = screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Review");
  });

  test("completed, current and upcoming steps are visually distinguishable", () => {
    renderProgress({ currentStepId: "review" });
    const [upload, analyse, review, confirm] = screen.getAllByRole("listitem");
    const circle = (li) => li.querySelector(".rounded-full");

    // completed steps carry a solid success circle + a check icon (no number)
    expect(circle(upload).className).toMatch(/border-success/);
    expect(circle(upload).className).toMatch(/bg-success/);
    expect(circle(upload).querySelector("svg")).toBeTruthy();
    expect(circle(upload).textContent).not.toMatch(/\d/);
    expect(circle(analyse).className).toMatch(/border-success/);

    // current step carries the strong primary treatment
    expect(circle(review).className).toMatch(/border-primary/);
    expect(circle(review).className).toMatch(/bg-primary/);
    expect(review).toHaveAttribute("aria-current", "step");

    // upcoming step is muted and shows its number
    expect(circle(confirm).className).toMatch(/border-border/);
    expect(circle(confirm)).toHaveTextContent("4");
    expect(confirm).not.toHaveAttribute("aria-current");
  });

  test("no step label uses underline or line-through styling (never strikethrough-like)", () => {
    renderProgress({ currentStepId: "review" });
    const nav = screen.getByRole("navigation", { name: /workflow progress/i });
    for (const label of ["Upload", "Analyse", "Review", "Confirm"]) {
      const el = within(nav).getByText(label);
      expect(el.className).not.toMatch(/underline|line-through/);
    }
  });

  test("connectors are decorative, sit behind the circles, and never render as a button", () => {
    const { container } = renderProgress({ currentStepId: "review" });
    const connectors = container.querySelectorAll('li > span[aria-hidden="true"]');
    expect(connectors.length).toBe(3); // one before each step after the first
    connectors.forEach((c) => {
      expect(c.className).toMatch(/border-t-2/);
      expect(c.className).toMatch(/z-0/);
      expect(c.tagName).toBe("SPAN");
    });
    // completed connectors are solid; the connector into a future step is dashed
    const [c1, , c3] = connectors;
    expect(c1.className).toMatch(/border-solid/);
    expect(c3.className).toMatch(/border-dashed/);
  });

  test("when complete, no step is current and all steps read as completed", () => {
    renderProgress({ currentStepId: "confirm", isComplete: true });
    const items = screen.getAllByRole("listitem");
    expect(items.filter((li) => li.getAttribute("aria-current") === "step")).toHaveLength(0);
    items.forEach((li) => expect(li.querySelector(".rounded-full").className).toMatch(/border-success/));
  });

  test("processing shows an animated indicator and an aria-live status line", () => {
    const { container } = renderProgress({ processing: true, statusText: "Analysing your room…" });
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent("Analysing your room…");
    // spinner present somewhere in the nav
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  test("renders the current status and next-action guidance text", () => {
    renderProgress({ statusText: "ClearSpace suggested an action for each item.", nextActionText: "Review each item, then confirm." });
    expect(screen.getByText("ClearSpace suggested an action for each item.")).toBeInTheDocument();
    expect(screen.getByText("Review each item, then confirm.")).toBeInTheDocument();
  });

  test("guidance updates when the derived props change", () => {
    const { rerender } = renderProgress({ statusText: "First status.", nextActionText: "First action." });
    expect(screen.getByText("First status.")).toBeInTheDocument();

    rerender(
      <WorkflowProgress
        workflowName="Declutter"
        steps={DECLUTTER_STEPS}
        currentStepId="confirm"
        isComplete={false}
        processing
        statusText="Second status."
        nextActionText="Second action."
      />
    );
    expect(screen.getByText("Second status.")).toBeInTheDocument();
    expect(screen.getByText("Second action.")).toBeInTheDocument();
    expect(screen.queryByText("First status.")).not.toBeInTheDocument();
  });

  test("non-navigable mode (no onStepSelect) exposes no step buttons, no links, no percentages", () => {
    renderProgress({ processing: true });
    const nav = screen.getByRole("navigation", { name: /workflow progress/i });
    expect(within(nav).queryAllByRole("button")).toHaveLength(0);
    expect(within(nav).queryAllByRole("link")).toHaveLength(0);
    expect(nav.textContent).not.toMatch(/%|\bpercent\b/i);
  });

  test("a factual stage ordinal is shown, never a completion percentage", () => {
    renderProgress({ currentStepId: "review", statusText: "x", nextActionText: "y" });
    expect(screen.getByText("Step 3 of 4 · Review")).toBeInTheDocument();
  });

  test("mobile treatment: every step label stays in the DOM (no responsive hiding)", () => {
    // Labels are always rendered; the row scrolls rather than dropping steps.
    renderProgress();
    for (const label of ["Upload", "Analyse", "Review", "Confirm"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    const list = screen.getByRole("list");
    expect(list.className).toMatch(/overflow-x-auto/);
  });

  test("wider bordered surface, roughly max-w-4xl, with a horizontally scrollable step row", () => {
    renderProgress();
    const nav = screen.getByRole("navigation", { name: /workflow progress/i });
    expect(nav.className).toMatch(/max-w-4xl/);
    expect(nav.className).toMatch(/border/);
    expect(screen.getByRole("list").className).toMatch(/overflow-x-auto/);
  });
});

describe("WorkflowProgress, navigable wizard mode", () => {
  function renderWizard(overrides = {}) {
    const onStepSelect = vi.fn();
    render(
      <WorkflowProgress
        workflowName="Declutter"
        steps={DECLUTTER_STEPS}
        currentStepId="review"
        viewedStepId="review"
        completedStepIds={["upload", "analyse"]}
        unlockedStepIds={["upload", "analyse", "review"]}
        onStepSelect={onStepSelect}
        navigationLocked={false}
        processing={false}
        statusText="s"
        nextActionText="n"
        {...overrides}
      />
    );
    return { onStepSelect };
  }

  test("completed unlocked steps that are not the viewed step are buttons; clicking one selects it", async () => {
    const user = userEvent.setup();
    const { onStepSelect } = renderWizard();
    const nav = screen.getByRole("navigation", { name: /workflow progress/i });

    // backward-navigation controls carry a directional accessible name
    const upload = within(nav).getByRole("button", { name: "Go to Upload" });
    const analyse = within(nav).getByRole("button", { name: "Go to Analyse" });
    expect(upload).toBeInTheDocument();
    expect(analyse).toBeInTheDocument();

    await user.click(analyse);
    expect(onStepSelect).toHaveBeenCalledWith("analyse");
  });

  test("locked future steps are aria-disabled and not keyboard-focusable", () => {
    renderWizard(); // Confirm is locked (not in unlockedStepIds)
    const nav = screen.getByRole("navigation", { name: /workflow progress/i });
    const confirmItem = within(nav).getAllByRole("listitem")[3];

    expect(confirmItem).toHaveAttribute("aria-disabled", "true");
    expect(within(confirmItem).queryByRole("button")).toBeNull();
    // nothing focusable inside a locked step
    expect(confirmItem.querySelector("button, a, [tabindex]")).toBeNull();
  });

  test("completed steps stay reachable, unlocked but not viewed = still a real button", () => {
    renderWizard({ viewedStepId: "review", completedStepIds: ["upload", "analyse"], unlockedStepIds: ["upload", "analyse", "review"] });
    const nav = screen.getByRole("navigation", { name: /workflow progress/i });
    expect(within(nav).getByRole("button", { name: "Go to Upload" })).toBeEnabled();
    expect(within(nav).getByRole("button", { name: "Go to Analyse" })).toBeEnabled();
  });

  test("the viewed step is not a button, and it keeps aria-current='step' even when also completed", () => {
    renderWizard({ viewedStepId: "analyse", completedStepIds: ["upload", "analyse"] });
    const nav = screen.getByRole("navigation", { name: /workflow progress/i });
    const analyseItem = within(nav).getAllByRole("listitem")[1];

    expect(analyseItem).toHaveAttribute("aria-current", "step");
    expect(within(analyseItem).queryByRole("button")).toBeNull();
    // revisited-completed: shows the check AND the current-step treatment
    expect(analyseItem.querySelector("svg")).toBeTruthy();
    expect(analyseItem.querySelector(".rounded-full").className).toMatch(/border-primary/);
  });

  test("locked future steps render but are not buttons", () => {
    renderWizard(); // Confirm is not in unlockedStepIds
    const nav = screen.getByRole("navigation", { name: /workflow progress/i });
    expect(within(nav).getByText("Confirm")).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /confirm/i })).toBeNull();
  });

  test("navigationLocked removes every step button (no navigation during a safety-critical request)", () => {
    renderWizard({ navigationLocked: true });
    const nav = screen.getByRole("navigation", { name: /workflow progress/i });
    expect(within(nav).queryAllByRole("button")).toHaveLength(0);
  });

  test("still no clickable connector and no percentage", () => {
    renderWizard();
    const nav = screen.getByRole("navigation", { name: /workflow progress/i });
    // the only buttons are whole-step backward-navigation buttons
    for (const btn of within(nav).getAllByRole("button")) {
      expect(btn).toHaveAccessibleName(/^Go to (Upload|Analyse|Review|Confirm)$/);
    }
    expect(nav.textContent).not.toMatch(/%|\bpercent\b/i);
  });
});

describe("WorkflowProgress, five-step sequence", () => {
  test("works for the five-step Both sequence too", () => {
    render(
      <WorkflowProgress
        workflowName="Both"
        steps={[
          { id: "upload", label: "Upload" },
          { id: "analyse", label: "Analyse" },
          { id: "review", label: "Review" },
          { id: "confirm", label: "Confirm" },
          { id: "reorganise", label: "Reorganise" },
        ]}
        currentStepId="confirm"
        isComplete={false}
        processing={false}
        statusText="s"
        nextActionText="n"
      />
    );
    expect(screen.getByRole("navigation", { name: /both workflow progress/i })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByText("Reorganise")).toBeInTheDocument();
  });
});
