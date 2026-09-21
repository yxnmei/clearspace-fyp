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

const checklist = () => screen.getByRole("list", { name: /checklist actions/i });
const checkbox = (title) => screen.getByRole("checkbox", { name: new RegExp(title, "i") });
const progressbar = () => screen.getByRole("progressbar", { name: /checklist progress/i });

// A regex of everything that must never reach a normal user's screen.
const TECHNICAL =
  /provenance|llm_generated|deterministic|model call|phi4|prompt|duration|issue|seed|base model|controlnet|stable-diffusion|service version|api version|denoise|depth|hash|sha256|aaaaaaaa|bbbbbbbb|generation_ms|item_00\d|item_id|service_unreachable|reason code|technical|checklist details|generation details/i;

// ---------------------------------------------------------------------------
// Composition and hierarchy
// ---------------------------------------------------------------------------

describe("ReorganiseResult, composition", () => {
  test("has one result heading with task-oriented copy, then checklist, visual preview and focus areas", () => {
    renderResult(makeGeneratedResult());
    expect(screen.getByRole("heading", { level: 2, name: "Your tidy plan" })).toBeInTheDocument();
    expect(screen.getByText(/work through the checklist at your own pace/i)).toBeInTheDocument();
    expect(screen.getByText(/not a precise placement plan/i)).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Checklist",
      "Visual preview",
      "Areas to focus on",
    ]);
  });

  test("the storage suggestions section appears only when there are suggestions, after focus areas", () => {
    renderResult(
      makeGeneratedResult({
        storageSuggestions: [{ name: "Compartment tray", reason: "Keeps small things together.", related_item_ids: ["item_001"] }],
      })
    );
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Checklist",
      "Visual preview",
      "Areas to focus on",
      "Storage suggestions",
    ]);
  });

  test("never renders a room plan or zone section", () => {
    renderResult(makeGeneratedResult());
    expect(screen.queryByText(/room plan/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/zone/i)).not.toBeInTheDocument();
  });

  test("layout: checklist and preview share a two-column grid from lg, everything stacks below, no overflow classes", () => {
    const { container } = renderResult(makeGeneratedResult());
    const checklistSection = checklist().closest("section");
    const row = checklistSection.parentElement;
    expect(row.className).toMatch(/\bgrid\b/);
    expect(row.className).toMatch(/\blg:grid-cols-2\b/);
    expect(row.className.split(/\s+/)).not.toContain("grid-cols-2"); // stacked at base
    expect(row.children[0]).toBe(checklistSection);
    expect(row.children[1]).toBe(screen.getByRole("region", { name: /^visual preview$/i }));
    expect(container.innerHTML).not.toMatch(/overflow-x-auto|w-screen/);
    // the layout containers never force a single line (the Button primitive alone is nowrap by design)
    for (const el of container.querySelectorAll("section, div.grid, ol, ul, figure")) {
      expect(el.className).not.toMatch(/whitespace-nowrap/);
    }
  });

  test("technical fields stay in the supplied result object but are not rendered", () => {
    const result = makeGeneratedResult();
    const { container } = renderResult(result);
    expect(container.textContent).not.toMatch(TECHNICAL);
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("code")).toBeNull();
    // the data itself is untouched
    expect(result.actionPlan.provenance).toBe("llm_generated");
    expect(result.image.prompt_sha256).toBe("a".repeat(64));
    expect(result.imagePrompt).toBe("A tidy, well-organised bedroom.");
  });
});

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

describe("ReorganiseResult, interactive checklist", () => {
  test("renders every action in priority order with its number, title, instruction and one checkbox", () => {
    renderResult(makeGeneratedResult());
    const rows = within(checklist()).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => within(row).getByTestId("checklist-step-number").textContent)).toEqual(["1", "2"]);
    expect(within(rows[0]).getByText("Clear the desk")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Group the lamp and the desk items together.")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Straighten the lamp")).toBeInTheDocument();
    for (const row of rows) expect(within(row).getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("Work through these steps in order. Check off each one as you finish.")).toBeInTheDocument();
  });

  test("starts at 0 of N completed with a correctly described progressbar", () => {
    renderResult(makeGeneratedResult());
    expect(screen.getByText("0 of 2 completed")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
    const bar = progressbar();
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "2");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar).toHaveAttribute("aria-valuetext", "0 of 2 completed");
    for (const title of ["Clear the desk", "Straighten the lamp"]) expect(checkbox(title)).not.toBeChecked();
  });

  test("checking actions updates the count, percentage, progressbar and completed styling; unchecking reverts", async () => {
    const user = userEvent.setup();
    renderResult(makeGeneratedResult());

    await user.click(checkbox("Clear the desk"));
    expect(checkbox("Clear the desk")).toBeChecked();
    expect(screen.getByText("1 of 2 completed")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(progressbar()).toHaveAttribute("aria-valuenow", "1");
    expect(progressbar()).toHaveAttribute("aria-valuetext", "1 of 2 completed");
    const doneRow = checkbox("Clear the desk").closest("label");
    expect(doneRow.className).toMatch(/border-primary/);
    expect(within(doneRow).getByText("Clear the desk").className).toMatch(/line-through/);
    expect(within(doneRow).getByText("Completed")).toBeInTheDocument(); // not colour alone
    // the instruction stays readable
    expect(within(doneRow).getByText("Group the lamp and the desk items together.")).toBeInTheDocument();

    await user.click(checkbox("Straighten the lamp"));
    expect(screen.getByText("2 of 2 completed")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();

    await user.click(checkbox("Clear the desk"));
    expect(checkbox("Clear the desk")).not.toBeChecked();
    expect(screen.getByText("1 of 2 completed")).toBeInTheDocument();
    expect(progressbar()).toHaveAttribute("aria-valuenow", "1");
  });

  test("clicking the row text toggles its checkbox, and the row is a comfortable target", async () => {
    const user = userEvent.setup();
    renderResult(makeGeneratedResult());
    await user.click(screen.getByText("Set the lamp upright and clear around it."));
    expect(checkbox("Straighten the lamp")).toBeChecked();
    expect(checkbox("Straighten the lamp").closest("label").className).toMatch(/\bmin-h-14\b/);
    expect(checkbox("Straighten the lamp").className).toMatch(/\bh-5\b/);
  });

  test("keyboard: Tab reaches the first checkbox and Space toggles it", async () => {
    const user = userEvent.setup();
    renderResult(makeGeneratedResult());
    await user.tab();
    expect(checkbox("Clear the desk")).toHaveFocus();
    await user.keyboard(" ");
    expect(checkbox("Clear the desk")).toBeChecked();
    expect(screen.getByText("1 of 2 completed")).toBeInTheDocument();
    expect(checkbox("Clear the desk").className).toMatch(/focus-visible:ring-2/);
  });

  test("checking never mutates the supplied actionPlan and calls no callback", async () => {
    const user = userEvent.setup();
    const onStartOver = vi.fn();
    const result = makeGeneratedResult();
    const snapshot = JSON.stringify(result.actionPlan);
    renderResult(result, { onStartOver });

    await user.click(checkbox("Clear the desk"));
    await user.click(checkbox("Straighten the lamp"));

    expect(JSON.stringify(result.actionPlan)).toBe(snapshot);
    expect(result.actionPlan.actions[0]).not.toHaveProperty("completed");
    expect(onStartOver).not.toHaveBeenCalled();
  });

  test("a different run resets the completion; the same run keeps it", async () => {
    const user = userEvent.setup();
    const { rerender } = renderResult(makeGeneratedResult());
    await user.click(checkbox("Clear the desk"));
    expect(screen.getByText("1 of 2 completed")).toBeInTheDocument();

    // same run, re-rendered (e.g. a parent re-render): completion kept
    rerender(
      <ReorganiseResult generateResult={makeGeneratedResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />
    );
    expect(screen.getByText("1 of 2 completed")).toBeInTheDocument();

    // a different result: completion starts empty again
    rerender(
      <ReorganiseResult
        generateResult={makeGeneratedResult({ runId: "run2", actionPlan: makeActionPlan({ run_id: "run2" }) })}
        items={items}
        originalImageUrl={null}
        onStartOver={vi.fn()}
      />
    );
    expect(screen.getByText("0 of 2 completed")).toBeInTheDocument();
    expect(checkbox("Clear the desk")).not.toBeChecked();
    expect(progressbar()).toHaveAttribute("aria-valuenow", "0");
  });

  test.each([
    ["llm_generated", { provenance: "llm_generated" }],
    ["deterministic_fallback", { provenance: "deterministic_fallback", was_repaired: null, issues: [{ kind: "invalid_json", detail: "checklist model did not return syntactically valid JSON" }] }],
    ["deterministic_direct", { provenance: "deterministic_direct", attempts: 0, model_name: null, prompt_version: null, was_repaired: null }],
  ])("shows no provenance, model, prompt, duration or issue detail for a %s plan", (_, planOverrides) => {
    const { container } = renderResult(makeGeneratedResult({ actionPlan: makeActionPlan(planOverrides) }));
    expect(container.textContent).not.toMatch(/ai assistant|without the ai|usable checklist|syntactically|valid json/i);
    expect(container.textContent).not.toMatch(TECHNICAL);
    expect(screen.getByText("Clear the desk")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Focus areas
// ---------------------------------------------------------------------------

describe("ReorganiseResult, focus areas", () => {
  test("renders one entry per area with its label, count and item labels joined by item_id", () => {
    renderResult(makeGeneratedResult());
    const list = screen.getByRole("list", { name: /focus areas/i });
    const entries = within(list).getAllByRole("listitem");
    expect(entries).toHaveLength(2);
    expect(within(entries[0]).getByRole("heading", { level: 4, name: "Left side" })).toBeInTheDocument();
    expect(within(entries[0]).getByText("1 selected item")).toBeInTheDocument();
    expect(within(entries[0]).getByText("lamp")).toBeInTheDocument();
    expect(within(entries[1]).getByText("desk")).toBeInTheDocument();
  });

  test("describes the areas as where items are concentrated, not as clutter, importance, zones or a plan", () => {
    renderResult(makeGeneratedResult());
    const section = screen.getByRole("region", { name: /areas to focus on/i });
    expect(section).toHaveTextContent(/holding the most selected items/i);
    expect(section).toHaveTextContent(/not from how cluttered or important/i);
    expect(section.textContent).not.toMatch(/zone|ai-generated|floor plan|severity/i);
  });

  test("bounds the item labels to three with +N more, and never shows a raw item_id", () => {
    const manyItems = [
      makeItem("item_001", "lamp"),
      makeItem("item_002", "desk"),
      makeItem("item_003", "chair"),
      makeItem("item_004", "rug"),
      makeItem("item_005", "plant"),
    ];
    const { container } = renderResult(
      makeGeneratedResult({
        focusAreas: [{ area_id: "left", label: "Left side", item_ids: ["item_001", "item_002", "item_003", "item_004", "item_005"] }],
      }),
      { items: manyItems }
    );
    expect(screen.getByText("5 selected items")).toBeInTheDocument();
    expect(screen.getByText("lamp, desk, chair +2 more")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/item_00\d/);
  });

  test("an unresolvable item is named neutrally, never dropped and never shown as its id", () => {
    const { container } = renderResult(makeGeneratedResult(), { items: [makeItem("item_001", "lamp")] });
    const list = screen.getByRole("list", { name: /focus areas/i });
    expect(within(list).getByText("Selected item")).toBeInTheDocument();
    expect(within(list).getAllByText("1 selected item")).toHaveLength(2); // both areas still counted
    expect(container.textContent).not.toMatch(/item_002|item_id/);
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

  test("renders each suggestion with its name, reason and human item labels, without numbers or ids", () => {
    renderResult(makeGeneratedResult({ storageSuggestions: suggestions }));
    const section = screen.getByRole("region", { name: /storage suggestions/i });
    expect(within(section).getByText("Compartment tray")).toBeInTheDocument();
    expect(within(section).getByText(/gives 2 small personal items/i)).toBeInTheDocument();
    expect(within(section).getByText("For: lamp, desk")).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/#\d|item_00\d|item_id/);
  });

  test("names an unresolvable related item neutrally", () => {
    renderResult(makeGeneratedResult({ storageSuggestions: suggestions }), { items: [makeItem("item_001", "lamp")] });
    expect(screen.getByText("For: lamp, Selected item")).toBeInTheDocument();
  });

  test("never claims prices, availability or product links", () => {
    renderResult(makeGeneratedResult({ storageSuggestions: suggestions }));
    const section = screen.getByRole("region", { name: /storage suggestions/i });
    expect(section).toHaveTextContent(/not products, prices or availability checks/i);
    expect(within(section).queryByRole("link")).not.toBeInTheDocument();
    expect(section.textContent).not.toMatch(/\$|buy now|in stock|recommend/i);
  });

  test("an empty list renders no storage section at all, and focus areas take the full row", () => {
    renderResult(makeGeneratedResult());
    expect(screen.queryByRole("region", { name: /storage suggestions/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/storage suggestion/i)).not.toBeInTheDocument();
    const row = screen.getByRole("region", { name: /areas to focus on/i }).parentElement;
    expect(row.children).toHaveLength(1);
    expect(row.className).not.toMatch(/lg:grid-cols-2/);
  });
});

// ---------------------------------------------------------------------------
// Visual preview
// ---------------------------------------------------------------------------

describe("ReorganiseResult, generated image", () => {
  test("shows Before and AI preview together with useful alt text and the full images", () => {
    renderResult(makeGeneratedResult(), { originalImageUrl: "blob:mock-original" });
    const section = screen.getByRole("region", { name: /^visual preview$/i });
    expect(within(section).getByText("Before")).toBeInTheDocument();
    expect(within(section).getByText("AI preview")).toBeInTheDocument();
    const before = screen.getByRole("img", { name: /original room photo you uploaded/i });
    const after = screen.getByRole("img", { name: /impression of a tidier version/i });
    expect(before).toHaveAttribute("src", "blob:mock-original");
    expect(after).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
    for (const img of [before, after]) {
      expect(img.className).toMatch(/object-contain/);
      expect(img.className).not.toMatch(/object-cover/);
      expect(img.className).toMatch(/rounded-card/);
    }
    const grid = before.closest("figure").parentElement;
    expect(grid.className).toMatch(/\bgrid\b/);
    expect(grid.className).toMatch(/sm:grid-cols-2/);
  });

  test("describes the picture as an impression and never claims it follows the checklist or zones", () => {
    renderResult(makeGeneratedResult());
    const section = screen.getByRole("region", { name: /^visual preview$/i });
    expect(section).toHaveTextContent(/ai-generated impression/i);
    expect(section).toHaveTextContent(/may not preserve every object or its exact placement/i);
    expect(section.textContent).not.toMatch(/follows the checklist|step by step|zone|perfectly preserved/i);
  });

  test("shows no generation metadata, prompt or hashes and offers no disclosure", () => {
    const { container } = renderResult(makeGeneratedResult());
    const section = screen.getByRole("region", { name: /^visual preview$/i });
    expect(section.textContent).not.toMatch(TECHNICAL);
    expect(section.textContent).not.toMatch(/tidy, well-organised bedroom/i);
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("ReorganiseResult, unavailable image", () => {
  test("keeps the checklist and areas fully usable, with a compact warning and no broken image", async () => {
    const user = userEvent.setup();
    renderResult(makeUnavailableResult("timeout"));
    expect(screen.getByRole("heading", { level: 3, name: /visual preview unavailable/i })).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Left side" })).toBeInTheDocument();
    await user.click(checkbox("Clear the desk"));
    expect(screen.getByText("1 of 2 completed")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /visual preview unavailable/i }).className).toMatch(/border-warning/);
  });

  test.each([
    ["service_unreachable", /could not be reached/i],
    ["timeout", /took too long/i],
    ["request_failed", /connection.*failed/i],
    ["service_error", /reported a problem/i],
    ["invalid_response", /could not use/i],
  ])("shows a safe human message for %s without the code", (reason, expectedText) => {
    const { container } = renderResult(makeUnavailableResult(reason));
    expect(screen.getByText(expectedText)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(new RegExp(reason));
    expect(container.textContent).not.toMatch(TECHNICAL);
    expect(container.querySelector("details")).toBeNull();
  });

  test("an unknown reason still gets a safe generic message", () => {
    renderResult(makeUnavailableResult("something_else"));
    expect(screen.getByText(/could not be generated/i)).toBeInTheDocument();
    expect(screen.queryByText(/something_else/)).not.toBeInTheDocument();
  });

  test("explains that the checklist remains available and offers no Retry", () => {
    renderResult(makeUnavailableResult());
    expect(screen.getByText(/checklist is complete and ready to use without it/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry|try again|regenerate/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Start over
// ---------------------------------------------------------------------------

describe("ReorganiseResult, start over", () => {
  test("Start over is a low-emphasis Button that calls onStartOver exactly once", async () => {
    const onStartOver = vi.fn();
    renderResult(makeGeneratedResult(), { onStartOver });
    const button = screen.getByRole("button", { name: /start over/i });
    expect(button.className).toMatch(/border-input/);
    expect(button.className).not.toMatch(/bg-primary/);
    expect(button).toHaveAttribute("type", "button");
    await userEvent.click(button);
    expect(onStartOver).toHaveBeenCalledTimes(1);
  });

  test("Start over is available in the unavailable-image state too, and is the only button", async () => {
    const onStartOver = vi.fn();
    renderResult(makeUnavailableResult(), { onStartOver });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /start over/i }));
    expect(onStartOver).toHaveBeenCalledTimes(1);
  });
});
