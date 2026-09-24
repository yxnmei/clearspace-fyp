import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import ReorganiseResult from "./ReorganiseResult";

function makeResult(overrides = {}) {
  return {
    runId: "run1",
    actionPlan: { run_id: "run1", provenance: "deterministic_direct", actions: [{ priority: 1, title: "Legacy action", instruction: "Not shown to the user." }] },
    tidyPlan: { phases: [
      { phase_id: "empty_clean", title: "Empty and clean", steps: [{ step_id: "empty_clean-1", text: "Clear the desk surface.", item_ids: [] }] },
      { phase_id: "sort", title: "Sort", steps: [{ step_id: "sort-1", text: "Set aside the lamp for cleaning.", item_ids: ["item_001"] }] },
    ] },
    focusAreas: [{ area_id: "left", label: "Left side", item_ids: ["item_001"] }],
    storageSuggestions: [],
    imagePrompt: "An internal image prompt",
    imageStatus: "generated",
    image: { image: "aGVsbG8=", image_media_type: "image/png" },
    imageUnavailableReason: null,
    ...overrides,
  };
}

function renderResult(result = makeResult(), extra = {}) {
  return render(<ReorganiseResult generateResult={result} originalImageUrl="blob:before" onStartOver={vi.fn()} {...extra} />);
}

describe("ReorganiseResult phased plan composition", () => {
  test("shows phased steps, visual preview and no legacy action text", () => {
    renderResult();
    expect(screen.getByRole("heading", { level: 2, name: "Your tidy plan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Tidy plan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Empty and clean" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Sort" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Clear the desk surface." })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Set aside the lamp for cleaning." })).toBeInTheDocument();
    expect(screen.queryByText("Legacy action")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Visual preview" })).toBeInTheDocument();
  });

  test("top row is a responsive plan and preview pair", () => {
    renderResult();
    const plan = screen.getByRole("region", { name: "Tidy plan" });
    const row = plan.parentElement;
    expect(row.className).toMatch(/lg:grid-cols-2/);
    expect(row.children[1]).toBe(screen.getByRole("region", { name: "Visual preview" }));
  });

  test("uses one local progress state and resets when the result run changes", async () => {
    const user = userEvent.setup();
    const { rerender } = renderResult();
    await user.click(screen.getByRole("checkbox", { name: "Clear the desk surface." }));
    expect(screen.getByText("1 of 2 completed")).toBeInTheDocument();
    rerender(<ReorganiseResult generateResult={makeResult()} originalImageUrl="blob:before" />);
    expect(screen.getByText("1 of 2 completed")).toBeInTheDocument();
    rerender(<ReorganiseResult generateResult={makeResult({ runId: "run2" })} originalImageUrl="blob:before" />);
    expect(screen.getByText("0 of 2 completed")).toBeInTheDocument();
  });

  test("storage suggestions appear after the top row and do not show item IDs", () => {
    renderResult(makeResult({ storageSuggestions: [{ name: "Compartment tray", reason: "Keeps small objects together.", related_item_ids: ["item_001"] }] }));
    const storage = screen.getByRole("region", { name: "Storage and organisation ideas" });
    expect(within(storage).getByText("Compartment tray")).toBeInTheDocument();
    expect(storage.textContent).not.toMatch(/item_001/);
    expect(storage.previousElementSibling.className).toMatch(/grid/);
  });

  test("empty storage suggestions omit the section", () => {
    renderResult();
    expect(screen.queryByRole("region", { name: "Storage and organisation ideas" })).not.toBeInTheDocument();
  });

  test("generated preview is expressly illustrative", () => {
    renderResult();
    const preview = screen.getByRole("region", { name: "Visual preview" });
    expect(preview).toHaveTextContent(/AI-generated impression/i);
    expect(within(preview).getByAltText("The original space photo you uploaded")).toHaveAttribute("src", "blob:before");
    expect(within(preview).getByAltText(/AI-generated impression/)).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
    expect(preview.textContent).not.toMatch(/An internal image prompt|item_001|deterministic_direct/);
  });

  test("an unavailable image leaves the phased plan usable", async () => {
    const user = userEvent.setup();
    renderResult(makeResult({ imageStatus: "unavailable", image: null, imageUnavailableReason: "timeout" }));
    expect(screen.getByRole("heading", { name: "Visual preview unavailable" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Clear the desk surface." }));
    expect(screen.getByText("1 of 2 completed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  test("Before and AI preview images carry useful alt text and their own sources", () => {
    renderResult(makeResult(), { originalImageUrl: "blob:mock-original" });
    const preview = screen.getByRole("region", { name: "Visual preview" });
    expect(within(preview).getByText("Before")).toBeInTheDocument();
    expect(within(preview).getByText("AI preview")).toBeInTheDocument();
    const before = screen.getByRole("img", { name: /original space photo you uploaded/i });
    const after = screen.getByRole("img", { name: /impression of a tidier version/i });
    expect(before).toHaveAttribute("src", "blob:mock-original");
    expect(after).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
    for (const img of [before, after]) {
      expect(img.getAttribute("alt")).not.toBe("");
      expect(img.className).toMatch(/object-contain/);
    }
  });

  test("an unknown unavailable reason still gets a safe generic message", () => {
    renderResult(makeResult({ imageStatus: "unavailable", image: null, imageUnavailableReason: "something_else" }));
    expect(screen.getByRole("heading", { name: "Visual preview unavailable" })).toBeInTheDocument();
    expect(screen.getByText(/could not be generated/i)).toBeInTheDocument();
    expect(screen.queryByText(/something_else/)).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  test("the unavailable state says the plan remains usable and offers no retry control", () => {
    renderResult(makeResult({ imageStatus: "unavailable", image: null, imageUnavailableReason: "service_unreachable" }));
    expect(screen.getByText(/your tidy plan is ready to use without it/i)).toBeInTheDocument();
    expect(screen.queryByText(/your checklist is complete/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry|try again|regenerate|check again/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start over" })).toBeInTheDocument();
  });

  test("Start over calls the supplied handler; Both can omit it and override the heading", async () => {
    const user = userEvent.setup();
    const onStartOver = vi.fn();
    const { rerender } = renderResult(makeResult(), { onStartOver });
    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(onStartOver).toHaveBeenCalledTimes(1);
    rerender(<ReorganiseResult generateResult={makeResult()} originalImageUrl={null} heading="Tidy up" />);
    expect(screen.getByRole("heading", { level: 2, name: "Tidy up" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start over" })).not.toBeInTheDocument();
  });
});
