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
  test("has one result heading with task-oriented copy, then checklist and visual preview only", () => {
    renderResult(makeGeneratedResult());
    expect(screen.getByRole("heading", { level: 2, name: "Your tidy plan" })).toBeInTheDocument();
    expect(screen.getByText(/work through the checklist at your own pace/i)).toBeInTheDocument();
    expect(screen.getByText(/not a precise placement plan/i)).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Checklist", "Visual preview"]);
  });

  test("the storage suggestions section appears only when there are suggestions, beneath the top row", () => {
    renderResult(
      makeGeneratedResult({
        storageSuggestions: [{ name: "Compartment tray", reason: "Keeps small things together.", related_item_ids: ["item_001"] }],
      })
    );
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Checklist",
      "Visual preview",
      "Storage and organisation ideas",
    ]);
    const topRow = checklist().closest("section").parentElement;
    const storage = screen.getByRole("region", { name: /storage and organisation ideas/i });
    expect(storage.parentElement).toBe(topRow.parentElement); // a direct child of the result, not a nested column
    expect(topRow.nextElementSibling).toBe(storage);
  });

  test("focus areas stay on the supplied result but are never rendered", () => {
    const result = makeGeneratedResult({
      focusAreas: [
        { area_id: "left", label: "Left side", item_ids: ["item_001"] },
        { area_id: "right", label: "Right side", item_ids: ["item_002"] },
      ],
    });
    const { container } = renderResult(result);
    expect(result.focusAreas).toHaveLength(2);
    expect(result.focusAreas[0]).toEqual({ area_id: "left", label: "Left side", item_ids: ["item_001"] });
    expect(screen.queryByRole("region", { name: /areas to focus on|focus areas/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /focus areas/i })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/focus area|areas to focus|left side|right side|selected item/i);
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
  test("renders every action in priority order with its number, title, concise instruction and one checkbox", () => {
    renderResult(makeGeneratedResult());
    const rows = within(checklist()).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => within(row).getByTestId("checklist-step-number").textContent)).toEqual(["1", "2"]);
    expect(within(rows[0]).getByText("Clear the desk")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Group the lamp and the desk items together.")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Straighten the lamp")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Set the lamp upright and clear around it.")).toBeInTheDocument();
    for (const row of rows) expect(within(row).getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("Work through these steps in order. Check off each one as you finish.")).toBeInTheDocument();
  });

  test("titles render in priority order, one per row", () => {
    renderResult(
      makeGeneratedResult({
        actionPlan: makeActionPlan({
          actions: [
            { priority: 1, title: "Group the picture frame items", instruction: "Bring the picture frame items together in one place." },
            { priority: 2, title: "Group the toy items", instruction: "Bring the toy items together in one place." },
            { priority: 3, title: "Group the cup items", instruction: "Bring the cup items together in one place." },
            { priority: 4, title: "Tidy loose items on the left side", instruction: "Straighten loose items and clear the surrounding space." },
            { priority: 5, title: "Do a final room check", instruction: "Look over the bedroom and make sure every selected item has a clear place before you finish." },
          ],
        }),
      })
    );
    const rows = within(checklist()).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByTestId("checklist-step-number").textContent)).toEqual(["1", "2", "3", "4", "5"]);
    expect(rows.map((row) => within(row).getByRole("checkbox").getAttribute("id"))).toEqual(
      [1, 2, 3, 4, 5].map((n) => `checklist-action-run1-${n}`)
    );
    const titles = [
      "Group the picture frame items",
      "Group the toy items",
      "Group the cup items",
      "Tidy loose items on the left side",
      "Do a final room check",
    ];
    rows.forEach((row, index) => {
      expect(within(row).getByText(titles[index])).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: titles[index] })).toBe(within(row).getByRole("checkbox"));
    });
    const instructions = [
      "Bring the picture frame items together in one place.",
      "Bring the toy items together in one place.",
      "Bring the cup items together in one place.",
      "Straighten loose items and clear the surrounding space.",
      "Look over the bedroom and make sure every selected item has a clear place before you finish.",
    ];
    rows.forEach((row, index) => expect(within(row).getByText(instructions[index])).toBeInTheDocument());
  });

  test("the instruction renders beneath the title as secondary muted text and describes the checkbox", () => {
    const result = makeGeneratedResult();
    const { container } = renderResult(result);
    const row = checkbox("Clear the desk").closest("label");
    const title = within(row).getByText("Clear the desk");
    const instruction = within(row).getByText("Group the lamp and the desk items together.");
    // beneath: same text column, title first
    expect(title.parentElement).toBe(instruction.parentElement);
    expect(title.nextElementSibling).toBe(instruction);
    // secondary: smaller, muted, not bold; the title is the emphasised line
    expect(instruction.className).toMatch(/\btext-xs\b/);
    expect(instruction.className).toMatch(/\btext-muted-foreground\b/);
    expect(instruction.className).not.toMatch(/font-semibold|font-bold/);
    expect(title.className).toMatch(/\bfont-semibold\b/);
    expect(title.className).toMatch(/\btext-sm\b/);
    // wraps naturally, never clipped
    expect(instruction.className).toMatch(/\bbreak-words\b/);
    expect(instruction.className).not.toMatch(/truncate|line-clamp|overflow-hidden|whitespace-nowrap/);
    // it is the checkbox's accessible description, not part of its name
    expect(checkbox("Clear the desk")).toHaveAccessibleDescription("Group the lamp and the desk items together.");
    expect(checkbox("Clear the desk")).toHaveAccessibleName("Clear the desk");
    // no disclosure, tooltip or details view, and the data is untouched
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("[title]")).toBeNull();
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
    expect(result.actionPlan.actions[0].instruction).toBe("Group the lamp and the desk items together.");
  });

  test("the instruction is not an identical restatement of the title", () => {
    renderResult(makeGeneratedResult());
    for (const row of within(checklist()).getAllByRole("listitem")) {
      const [title, instruction] = Array.from(row.querySelectorAll("span[id]")).map((el) => el.textContent.trim());
      expect(instruction).not.toBe(title);
      expect(instruction.replace(/\.$/, "").toLowerCase()).not.toBe(title.toLowerCase());
    }
  });

  test("each checkbox's accessible name is exactly its full action title; the step number is decorative", () => {
    renderResult(makeGeneratedResult());
    expect(screen.getByRole("checkbox", { name: "Clear the desk" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Straighten the lamp" })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    // the ordered list already conveys position, so the badge is hidden from the name
    for (const badge of screen.getAllByTestId("checklist-step-number")) expect(badge).toHaveAttribute("aria-hidden", "true");
    const box = screen.getByRole("checkbox", { name: "Clear the desk" });
    expect(box.closest("label")).toHaveAttribute("for", box.id);
    expect(box).toHaveAttribute("aria-labelledby", `${box.id}-title`);
    expect(document.getElementById(`${box.id}-title`)).toHaveTextContent("Clear the desk");
  });

  test("rows are compact with a 44px minimum touch target, and the one-sentence instruction wraps rather than overflows", () => {
    renderResult(makeGeneratedResult());
    const row = checkbox("Clear the desk").closest("label");
    expect(row.className).toMatch(/\bmin-h-11\b/);
    expect(row.className).not.toMatch(/\bmin-h-14\b/);
    expect(row.className).toMatch(/\bitems-start\b/);
    expect(row.className).toMatch(/\bpy-2\b/);
    const column = within(row).getByText("Clear the desk").parentElement;
    expect(column.className).toMatch(/\bmin-w-0\b/);
    expect(column.className).toMatch(/\bflex-1\b/);
    expect(within(row).getByText("Clear the desk").className).toMatch(/\bbreak-words\b/);
    // exactly title + instruction in the text column (Completed only once done)
    expect(column.querySelectorAll("span").length).toBe(2);
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
    // the title and its instruction both stay readable once done; only the title is struck through
    expect(within(doneRow).getByText("Clear the desk")).toBeInTheDocument();
    const doneInstruction = within(doneRow).getByText("Group the lamp and the desk items together.");
    expect(doneInstruction.className).not.toMatch(/line-through/);
    expect(doneInstruction.className).toMatch(/text-muted-foreground/);

    await user.click(checkbox("Straighten the lamp"));
    expect(screen.getByText("2 of 2 completed")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();

    await user.click(checkbox("Clear the desk"));
    expect(checkbox("Clear the desk")).not.toBeChecked();
    expect(screen.getByText("1 of 2 completed")).toBeInTheDocument();
    expect(progressbar()).toHaveAttribute("aria-valuenow", "1");
  });

  test("clicking the title text toggles its checkbox, and the row is a comfortable target", async () => {
    const user = userEvent.setup();
    renderResult(makeGeneratedResult());
    await user.click(screen.getByText("Straighten the lamp"));
    expect(checkbox("Straighten the lamp")).toBeChecked();
    await user.click(within(checkbox("Straighten the lamp").closest("label")).getByTestId("checklist-step-number"));
    expect(checkbox("Straighten the lamp")).not.toBeChecked();
    expect(checkbox("Straighten the lamp").closest("label").className).toMatch(/\bmin-h-11\b/);
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
// Storage suggestions
// ---------------------------------------------------------------------------

describe("ReorganiseResult, storage and organisation ideas", () => {
  const one = [
    {
      name: "Compartment tray",
      reason: "Give the lamp and desk a fixed compartment each so they stop going missing.",
      related_item_ids: ["item_001", "item_002"],
    },
  ];
  const three = [
    {
      name: "Dedicated display area",
      reason: "Use one deliberate display area for the painting and 6 picture frame items instead of scattering them.",
      related_item_ids: ["item_001"],
    },
    {
      name: "Desktop accessory organiser",
      reason: "Keep the keyboard and mouse together between uses so they are always at hand.",
      related_item_ids: ["item_002"],
    },
    { name: "Toy container", reason: "Give both toy items one easy place to return to after use.", related_item_ids: ["item_001", "item_002"] },
  ];
  const section = () => screen.getByRole("region", { name: /storage and organisation ideas/i });
  const cards = () => within(screen.getByRole("list", { name: /storage and organisation ideas/i })).getAllByRole("listitem");

  test("uses the new heading and introduction, and never the old defensive copy", () => {
    renderResult(makeGeneratedResult({ storageSuggestions: one }));
    expect(screen.getByRole("heading", { level: 3, name: "Storage and organisation ideas" })).toBeInTheDocument();
    expect(within(section()).getByText("Optional ways to give related items a consistent home.")).toBeInTheDocument();
    expect(section().textContent).not.toMatch(/generic ideas|not products|availability checks/i);
    expect(screen.queryByRole("heading", { name: /^storage suggestions$/i })).not.toBeInTheDocument();
  });

  test("each card holds exactly its title and one reason: no For line, no labels list, no ids", () => {
    renderResult(makeGeneratedResult({ storageSuggestions: one }));
    const [card] = cards();
    const paragraphs = Array.from(card.querySelectorAll("p")).map((p) => p.textContent);
    expect(paragraphs).toEqual(["Compartment tray", "Give the lamp and desk a fixed compartment each so they stop going missing."]);
    expect(card.children).toHaveLength(2);
    expect(within(card).queryByText(/^For:/)).not.toBeInTheDocument();
    expect(section().textContent).not.toMatch(/For:|#\d|item_00\d|item_id|related_item/i);
    expect(within(card).getByText("Compartment tray").className).toMatch(/font-semibold/);
    expect(within(card).getByText(/fixed compartment/).className).toMatch(/text-muted-foreground/);
  });

  test("related_item_ids stay on the supplied result but are not displayed, even when an id cannot be resolved", () => {
    const result = makeGeneratedResult({ storageSuggestions: one });
    const { container } = renderResult(result, { items: [makeItem("item_001", "lamp")] });
    expect(result.storageSuggestions[0].related_item_ids).toEqual(["item_001", "item_002"]);
    expect(container.textContent).not.toMatch(/item_002|Selected item|For:/);
  });

  test("cards sit in a responsive grid: one column, two from sm, three from lg", () => {
    renderResult(makeGeneratedResult({ storageSuggestions: three }));
    const list = screen.getByRole("list", { name: /storage and organisation ideas/i });
    expect(list.className).toMatch(/\bgrid\b/);
    expect(list.className).toMatch(/\bgrid-cols-1\b/);
    expect(list.className).toMatch(/\bsm:grid-cols-2\b/);
    expect(list.className).toMatch(/\blg:grid-cols-3\b/);
    expect(list.className).not.toMatch(/space-y/);
    expect(cards()).toHaveLength(3);
    for (const card of cards()) expect(card.className).toMatch(/\bmin-w-0\b/);
  });

  test.each([
    ["one", one],
    ["two", three.slice(0, 2)],
    ["three", three],
  ])("renders %s suggestion(s) as that many cards in the same grid, never a full-width single card", (_, list) => {
    renderResult(makeGeneratedResult({ storageSuggestions: list }));
    expect(cards()).toHaveLength(list.length);
    expect(cards().map((card) => card.querySelectorAll("p").length)).toEqual(list.map(() => 2));
    const grid = screen.getByRole("list", { name: /storage and organisation ideas/i });
    expect(grid.className).toMatch(/\bsm:grid-cols-2\b/); // a lone card takes one column, not the row
    for (const card of cards()) expect(card.className).not.toMatch(/col-span|w-full/);
    expect(cards().map((card) => card.querySelector("p").textContent)).toEqual(list.map((s) => s.name));
  });

  test("never claims prices, availability or product links, and offers no controls", () => {
    renderResult(makeGeneratedResult({ storageSuggestions: three }));
    expect(within(section()).queryByRole("link")).not.toBeInTheDocument();
    expect(within(section()).queryByRole("button")).not.toBeInTheDocument();
    expect(section().querySelector("details, [title], [aria-expanded]")).toBeNull();
    expect(section().textContent).not.toMatch(/\$|buy now|in stock|recommend|brand|price/i);
  });

  test("an empty list renders no storage section and leaves no lower placeholder: the top row is followed directly by Start over", () => {
    renderResult(makeGeneratedResult());
    expect(screen.queryByRole("region", { name: /storage and organisation ideas/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/storage and organisation|storage suggestion|consistent home/i)).not.toBeInTheDocument();
    const topRow = checklist().closest("section").parentElement;
    const startOver = screen.getByRole("button", { name: /start over/i });
    expect(topRow.nextElementSibling).toContainElement(startOver);
    expect(topRow.parentElement.children).toHaveLength(3); // header, top row, start over
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
