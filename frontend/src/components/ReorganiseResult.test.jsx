import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import ReorganiseResult from "./ReorganiseResult";

function makeItem(id, label = "lamp") {
  return { item_id: id, clean_label: label, effective_label: label, item_role: "actionable" };
}

function makeActionPlan(overrides = {}) {
  return {
    run_id: "run1",
    actions: [
      { priority: 1, title: "Clear the desk", instruction: "Group the lamp and the desk items together." },
      { priority: 2, title: "Straighten the lamp", instruction: "Set the lamp upright and clear around it." },
    ],
    provenance: "llm_generated",
    attempts: 1,
    model_name: "phi4-mini",
    prompt_version: "reorganise-actions-v1",
    was_repaired: false,
    duration_ms: 5,
    issues: [],
    ...overrides,
  };
}

function makeGeneratedResult(overrides = {}) {
  return {
    runId: "run1",
    actionPlan: makeActionPlan(),
    focusAreas: [
      { area_id: "left", label: "Left side", item_ids: ["item_001"] },
      { area_id: "right", label: "Right side", item_ids: ["item_002"] },
    ],
    storageSuggestions: [],
    imagePrompt: "A tidy, well-organised bedroom.",
    imageStatus: "generated",
    image: {
      image: "aGVsbG8=",
      image_media_type: "image/png",
      api_version: "v1",
      depth_map_used: true,
      denoise_strength: 0.35,
      controlnet_conditioning_scale: 1.0,
      seed: 42,
      base_model: "runwayml/stable-diffusion-v1-5",
      controlnet_model: "lllyasviel/sd-controlnet-depth",
      service_version: "colab-dev-0.1",
      generation_ms: 4500,
      prompt_sha256: "a".repeat(64),
      input_image_sha256: "b".repeat(64),
    },
    imageUnavailableReason: null,
    ...overrides,
  };
}

function makeUnavailableResult(reason = "service_unreachable", overrides = {}) {
  return {
    ...makeGeneratedResult(),
    imageStatus: "unavailable",
    image: null,
    imageUnavailableReason: reason,
    ...overrides,
  };
}

const items = [makeItem("item_001", "lamp"), makeItem("item_002", "desk")];

function renderResult(generateResult, extra = {}) {
  return render(
    <ReorganiseResult generateResult={generateResult} items={items} originalImageUrl={null} onStartOver={vi.fn()} {...extra} />
  );
}

function headings() {
  return screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
}

// ---------------------------------------------------------------------------
// Order and composition
// ---------------------------------------------------------------------------

describe("ReorganiseResult, section order", () => {
  test("renders checklist, focus areas, storage suggestions, then the visual preview, in that order", () => {
    renderResult(makeGeneratedResult());
    expect(headings()).toEqual(["Your reorganisation checklist", "Areas to focus on", "Storage suggestions", "Visual preview"]);
  });

  test("keeps the same order when the visual preview is unavailable", () => {
    renderResult(makeUnavailableResult());
    expect(headings()).toEqual([
      "Your reorganisation checklist",
      "Areas to focus on",
      "Storage suggestions",
      "Visual preview unavailable",
    ]);
  });

  test("never renders a room plan or zone section", () => {
    renderResult(makeGeneratedResult());
    expect(screen.queryByText(/room plan/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/zone/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

describe("ReorganiseResult, checklist", () => {
  test("renders numbered cards with the title and instruction of each action, in priority order", () => {
    renderResult(makeGeneratedResult());
    const list = screen.getByRole("list", { name: /checklist actions/i });
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByRole("heading", { level: 3, name: "Clear the desk" })).toBeInTheDocument();
    expect(within(cards[0]).getByText("Group the lamp and the desk items together.")).toBeInTheDocument();
    expect(within(cards[1]).getByRole("heading", { level: 3, name: "Straighten the lamp" })).toBeInTheDocument();
    expect(cards.map((card) => within(card).getByTestId("checklist-step-number").textContent)).toEqual(["1", "2"]);
  });

  test("says the checklist came from the AI assistant when it did", () => {
    renderResult(makeGeneratedResult());
    expect(screen.getByText(/suggested by the ai assistant/i)).toBeInTheDocument();
  });

  test("a fallback checklist says so, without claiming the AI assistant wrote it", () => {
    renderResult(
      makeGeneratedResult({
        actionPlan: makeActionPlan({
          provenance: "deterministic_fallback",
          was_repaired: null,
          issues: [{ kind: "call_failed", detail: "checklist model call failed: RuntimeError" }],
        }),
      })
    );
    expect(screen.getByText(/did not return a usable checklist/i)).toBeInTheDocument();
    expect(screen.queryByText(/suggested by the ai assistant/i)).not.toBeInTheDocument();
  });

  test("the no-model checklist is described as built without the AI assistant", () => {
    renderResult(
      makeGeneratedResult({
        actionPlan: makeActionPlan({
          provenance: "deterministic_direct",
          attempts: 0,
          model_name: null,
          prompt_version: null,
          was_repaired: null,
        }),
      })
    );
    expect(screen.getByText(/without the ai assistant/i)).toBeInTheDocument();
    const details = screen.getByText("Checklist details").closest("details");
    expect(details).toHaveTextContent("deterministic_direct");
    expect(within(details).getByText("Model calls").closest("div")).toHaveTextContent("0");
    expect(within(details).getByText("Model").closest("div")).toHaveTextContent("n/a");
    expect(screen.queryByText("phi4-mini")).not.toBeInTheDocument();
  });

  test("checklist details are collapsed by default and carry provenance, attempts, model, prompt and duration", () => {
    renderResult(makeGeneratedResult());
    const details = screen.getByText("Checklist details").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("llm_generated");
    expect(within(details).getByText("Model calls").closest("div")).toHaveTextContent("1");
    expect(details).toHaveTextContent("phi4-mini");
    expect(details).toHaveTextContent("reorganise-actions-v1");
    expect(within(details).getByText("Checklist duration").closest("div")).toHaveTextContent("0.01s");
    expect(screen.queryByText(/why the ai checklist was not used/i)).not.toBeInTheDocument();
  });

  test("a fallback issue is explained in plain words, never as raw model text or an exception message", () => {
    renderResult(
      makeGeneratedResult({
        actionPlan: makeActionPlan({
          provenance: "deterministic_fallback",
          was_repaired: null,
          issues: [{ kind: "invalid_json", detail: "checklist model did not return syntactically valid JSON" }],
        }),
      })
    );
    const details = screen.getByText("Checklist details").closest("details");
    expect(details).toHaveTextContent(/reply was not valid json/i);
    expect(details).toHaveTextContent("(invalid_json)");
    expect(details).not.toHaveTextContent("syntactically");
  });
});

// ---------------------------------------------------------------------------
// Focus areas
// ---------------------------------------------------------------------------

describe("ReorganiseResult, focus areas", () => {
  test("renders one card per area with its label, count and item chips joined by item_id", () => {
    renderResult(makeGeneratedResult());
    const list = screen.getByRole("list", { name: /focus areas/i });
    const cards = within(list).getAllByRole("listitem").filter((li) => li.parentElement === list);
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByRole("heading", { level: 3, name: "Left side" })).toBeInTheDocument();
    expect(within(cards[0]).getByText("1 selected item")).toBeInTheDocument();
    const chips = within(cards[0]).getByRole("list", { name: /items in the left side/i });
    expect(within(chips).getByText("lamp")).toBeInTheDocument();
    expect(within(within(cards[1]).getByRole("list", { name: /items in the right side/i })).getByText("desk")).toBeInTheDocument();
  });

  test("describes the areas as where items are concentrated, not as clutter, zones or AI output", () => {
    renderResult(makeGeneratedResult());
    const section = screen.getByRole("region", { name: /areas to focus on/i });
    expect(section).toHaveTextContent(/holding the most selected items/i);
    expect(section).toHaveTextContent(/not from how cluttered/i);
    expect(section.textContent).not.toMatch(/zone|ai-generated|floor plan/i);
  });

  test("an unresolvable item id is shown as its id, never dropped", () => {
    renderResult(makeGeneratedResult(), { items: [makeItem("item_001", "lamp")] });
    expect(screen.getByText("item_002")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Storage suggestions
// ---------------------------------------------------------------------------

describe("ReorganiseResult, storage suggestions", () => {
  const suggestions = [
    {
      name: "Compartment tray",
      reason: "Gives 2 small personal items (lamp and desk) a fixed compartment each so they stop going missing.",
      related_item_ids: ["item_001", "item_002"],
    },
  ];

  test("renders each suggestion with its name, reason and the items it is based on", () => {
    renderResult(makeGeneratedResult({ storageSuggestions: suggestions }));
    const section = screen.getByRole("region", { name: /storage suggestions/i });
    expect(within(section).getByText("Compartment tray")).toBeInTheDocument();
    expect(within(section).getByText(/gives 2 small personal items/i)).toBeInTheDocument();
    expect(within(section).getByText(/based on: #1 lamp, #2 desk/i)).toBeInTheDocument();
  });

  test("never claims prices, availability or product links", () => {
    renderResult(makeGeneratedResult({ storageSuggestions: suggestions }));
    const section = screen.getByRole("region", { name: /storage suggestions/i });
    expect(section).toHaveTextContent(/not products, prices or availability checks/i);
    expect(within(section).queryByRole("link")).not.toBeInTheDocument();
    expect(section.textContent).not.toMatch(/\$|buy now|in stock|recommend/i);
  });

  test("an empty list shows an honest empty state instead of inventing a suggestion", () => {
    renderResult(makeGeneratedResult());
    const section = screen.getByRole("region", { name: /storage suggestions/i });
    expect(within(section).getByText(/no storage suggestion for this selection/i)).toBeInTheDocument();
    // states the real rule: two compatible small OR medium items
    expect(section).toHaveTextContent(/at least two compatible small or medium-sized items are selected/i);
    expect(within(section).queryByRole("list")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Visual preview
// ---------------------------------------------------------------------------

describe("ReorganiseResult, generated image", () => {
  test("shows both Before and Reorganised images with clear labels", () => {
    renderResult(makeGeneratedResult(), { originalImageUrl: "blob:mock-original" });
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("Reorganised")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /original room photo/i })).toHaveAttribute("src", "blob:mock-original");
    expect(screen.getByRole("img", { name: /impression of a tidier version/i })).toHaveAttribute(
      "src",
      "data:image/png;base64,aGVsbG8="
    );
  });

  test("describes the picture as an impression and never claims it follows the checklist", () => {
    renderResult(makeGeneratedResult());
    const section = screen.getByRole("region", { name: /^visual preview$/i });
    expect(section).toHaveTextContent(/ai-generated impression/i);
    expect(section).toHaveTextContent(/may not be preserved exactly/i);
    expect(section).toHaveTextContent(/does not follow the checklist step by step/i);
    expect(screen.queryByText(/perfectly preserved/i)).not.toBeInTheDocument();
  });

  test("generation metadata and the deterministic image prompt sit in a collapsed technical section", () => {
    renderResult(makeGeneratedResult());
    const details = screen.getByText("Generation details").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("runwayml/stable-diffusion-v1-5");
    expect(details).toHaveTextContent("API version");
    expect(details).toHaveTextContent(/depth-conditioned/i);
    expect(details).toHaveTextContent(`Prompt hash: ${"a".repeat(64)}`);
    expect(details).toHaveTextContent(`Input-image hash: ${"b".repeat(64)}`);
    expect(details).toHaveTextContent("A tidy, well-organised bedroom.");
  });
});

describe("ReorganiseResult, unavailable image", () => {
  test("keeps the checklist, areas and suggestions, with no broken image and an explanatory message", () => {
    renderResult(makeUnavailableResult("timeout"));
    expect(screen.getByText("Clear the desk")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Left side" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /storage suggestions/i })).toBeInTheDocument();
    expect(screen.getByText(/visual preview unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  test.each([
    ["service_unreachable", /could not be reached/i],
    ["timeout", /timed out/i],
    ["request_failed", /connection.*failed/i],
    ["service_error", /reported an error/i],
    ["invalid_response", /unexpected response/i],
  ])("shows a reason-specific message for %s", (reason, expectedText) => {
    renderResult(makeUnavailableResult(reason));
    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });

  test("explains that only the visual preview is affected", () => {
    renderResult(makeUnavailableResult());
    expect(screen.getByText(/checklist, focus areas and storage suggestions above are complete and unaffected/i)).toBeInTheDocument();
  });

  test("no Retry button is offered", () => {
    renderResult(makeUnavailableResult());
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });
});

describe("ReorganiseResult, start over", () => {
  test("Start over calls onStartOver", async () => {
    const onStartOver = vi.fn();
    renderResult(makeGeneratedResult(), { onStartOver });
    await userEvent.click(screen.getByRole("button", { name: /start over/i }));
    expect(onStartOver).toHaveBeenCalled();
  });

  test("Start over is available in the unavailable-image state too", async () => {
    const onStartOver = vi.fn();
    renderResult(makeUnavailableResult(), { onStartOver });
    await userEvent.click(screen.getByRole("button", { name: /start over/i }));
    expect(onStartOver).toHaveBeenCalled();
  });
});
