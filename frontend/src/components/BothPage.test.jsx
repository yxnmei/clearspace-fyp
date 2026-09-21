import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import BothPage from "./BothPage";
import * as client from "../api/client";

vi.mock("../api/client", () => ({
  uploadImage: vi.fn(),
  confirmDecisions: vi.fn(),
  overrideItem: vi.fn(),
  generateConfirmedReorganisation: vi.fn(),
  getImageGenHealth: vi.fn(),
  generateListings: vi.fn(),
  regenerateListing: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  global.URL.createObjectURL = vi.fn(() => "blob:mock-preview");
  global.URL.revokeObjectURL = vi.fn();
  client.getImageGenHealth.mockResolvedValue({ available: true });
});

function makeFile() {
  return new File(["fake"], "room.png", { type: "image/png" });
}

const HASH = "a".repeat(64);

function makeItem(overrides = {}) {
  return {
    item_id: "item_001",
    source_detection_index: 0,
    raw_phrase: "lamp",
    clean_label: "lamp",
    box: { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 },
    confidence: 0.8,
    position: "upper-left",
    relative_size: "small",
    item_role: "actionable",
    item_role_source: "default",
    corrected_label: null,
    label_source: "detector",
    effective_label: "lamp",
    ...overrides,
  };
}

function makeBothUploadResponse({ decisions = [{ itemId: "item_001", decision: "keep" }] } = {}) {
  const items = decisions.map((decision, index) =>
    makeItem({ item_id: decision.itemId, source_detection_index: index })
  );
  return {
    run_id: "run1",
    path: "both",
    analysis: {
      run_id: "run1",
      scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
      items,
      warnings: [],
      stage_timings: [],
    },
    declutter: {
      run_id: "run1",
      expected_item_ids: decisions.map((decision) => decision.itemId),
      ai_decisions: decisions.map((decision) => ({
        item_id: decision.itemId,
        decision: decision.decision,
        reason: `reason for ${decision.itemId}`,
      })),
      unresolved_item_ids: [],
      item_validity: Object.fromEntries(decisions.map((decision) => [decision.itemId, "raw_valid"])),
      mapping_warnings: [],
      semantic_errors: [],
      recovery_failures: [],
      provenance_warnings: [],
      is_complete: true,
      is_strictly_valid: true,
      model_name: "phi4-mini",
      prompt_version: "v2",
      stage_timings: [],
    },
    input_image_sha256: HASH,
  };
}

function makeConfirmResponse(confirmed) {
  const confirmed_decisions = confirmed.map((decision) => ({
    item_id: decision.itemId,
    ai_decision: decision.aiDecision,
    confirmed_decision: decision.confirmedDecision,
    ai_reason: `reason for ${decision.itemId}`,
    user_reason: null,
    excluded: false,
    decision_changed: decision.aiDecision !== decision.confirmedDecision,
  }));
  return {
    run_id: "run1",
    confirmed_decisions,
    confirmed_keep_ids: confirmed_decisions
      .filter((decision) => decision.confirmed_decision === "keep")
      .map((decision) => decision.item_id),
    decision_changed_count: confirmed_decisions.filter((decision) => decision.decision_changed).length,
    excluded_count: 0,
  };
}

function makeGeneratedResponse(confirmed, { imageStatus = "generated" } = {}) {
  const confirmation = makeConfirmResponse(confirmed);
  return {
    run_id: "run1",
    confirmation,
    action_plan: {
      run_id: "run1",
      actions: [{ priority: 1, title: "Clear the desk", instruction: "Straighten the lamp and clear the space around it." }],
      provenance: "llm_generated",
      attempts: 1,
      model_name: "phi4-mini",
      prompt_version: "reorganise-actions-v1",
      was_repaired: false,
      duration_ms: 5,
      issues: [],
    },
    focus_areas: [{ area_id: "left", label: "Left side", item_ids: confirmation.confirmed_keep_ids }],
    storage_suggestions: [],
    image_prompt: "a tidy bedroom",
    image_status: imageStatus,
    image:
      imageStatus === "generated"
        ? {
            image: "aGVsbG8=",
            image_media_type: "image/png",
            api_version: "v1",
            depth_map_used: true,
            denoise_strength: 0.35,
            controlnet_conditioning_scale: 1,
            seed: 42,
            base_model: "stable-diffusion-v1-5",
            controlnet_model: "sd-controlnet-depth",
            service_version: "colab-dev-0.1",
            generation_ms: 100,
            prompt_sha256: "b".repeat(64),
            input_image_sha256: HASH,
          }
        : null,
    image_unavailable_reason: imageStatus === "generated" ? null : "service_unreachable",
  };
}

function makeDraft(itemId, overrides = {}) {
  return {
    item_id: itemId,
    effective_label: "lamp",
    status: "generated",
    title: "Great lamp for sale",
    description: "A useful lamp ready for a new home.",
    unavailable_reason: null,
    was_repaired: false,
    attempts: 1,
    ...overrides,
  };
}

function makeListingsResponse(confirmation, drafts) {
  return {
    run_id: "run1",
    confirmation,
    drafts,
    model_name: drafts.length ? "phi4-mini" : null,
    prompt_version: drafts.length ? "v1" : null,
    max_attempts: drafts.length ? 3 : null,
  };
}

const KEEP = [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }];
const KEEP_AND_SELL = {
  decisions: [
    { itemId: "item_001", decision: "keep" },
    { itemId: "item_002", decision: "sell" },
  ],
  confirmed: [
    ...KEEP,
    { itemId: "item_002", aiDecision: "sell", confirmedDecision: "sell" },
  ],
};

function stepper() {
  return screen.getByRole("navigation", { name: /both workflow progress/i });
}

function currentStep() {
  return within(stepper())
    .getAllByRole("listitem")
    .find((item) => item.getAttribute("aria-current") === "step")
    ?.textContent.replace(/\d+/g, "")
    .trim();
}

async function reachReview(user, decisions = [{ itemId: "item_001", decision: "keep" }]) {
  client.uploadImage.mockResolvedValueOnce(makeBothUploadResponse({ decisions }));
  await user.upload(screen.getByLabelText(/room photo/i), makeFile());
  await user.click(screen.getByRole("button", { name: /^analyse room$/i }));
  await waitFor(() => expect(screen.getByRole("heading", { name: /analysis complete/i })).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
  expect(screen.getByRole("heading", { name: /review your declutter decisions/i })).toBeInTheDocument();
}

async function reachActions(user, scenario = { decisions: [{ itemId: "item_001", decision: "keep" }], confirmed: KEEP }) {
  await reachReview(user, scenario.decisions);
  await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
  client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponse(scenario.confirmed));
  await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
  await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());
  expect(client.generateListings).not.toHaveBeenCalled();
  expect(client.generateConfirmedReorganisation).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: /continue to results/i }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Marketplace listings" })).toBeInTheDocument());
}

describe("BothPage screen-by-screen flow", () => {
  test("owns one health request and starts on Upload", async () => {
    render(<BothPage />);
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalledTimes(1));
    expect(currentStep()).toBe("Upload photo");
    expect(screen.queryByRole("heading", { name: /review your declutter decisions/i })).not.toBeInTheDocument();
  });

  test("uses separate Analyse, Review and Confirm screens with Back navigation", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await reachReview(user);

    expect(currentStep()).toBe("Decide items");
    expect(screen.queryByRole("heading", { name: /analysis complete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm decisions/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(currentStep()).toBe("Confirm choices");
    expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back to decide items/i }));
    expect(currentStep()).toBe("Decide items");
  });

  test("lists all five steps and keeps future screens locked", () => {
    render(<BothPage />);
    expect(within(stepper()).getAllByRole("listitem").map((item) => item.textContent.replace(/\d+/g, "").trim())).toEqual([
      "Upload photo",
      "Analyse room",
      "Decide items",
      "Confirm choices",
      "Results",
    ]);
    expect(within(stepper()).queryByRole("button", { name: /go to decide items/i })).not.toBeInTheDocument();
  });

  test("full flow explicitly generates a reorganisation plan on the final screen", async () => {
    const user = userEvent.setup();
    client.generateConfirmedReorganisation.mockResolvedValue(makeGeneratedResponse(KEEP));
    render(<BothPage />);
    await reachActions(user);

    expect(currentStep()).toBe("Results");
    expect(screen.getByRole("button", { name: /generate reorganisation plan/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));

    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());
    expect(screen.getByLabelText(/room photo/i)).not.toBeVisible();
  });

  test("zero Keep still reaches the final screen for confirmed Sell listings", async () => {
    const user = userEvent.setup();
    const scenario = {
      decisions: [{ itemId: "item_001", decision: "sell" }],
      confirmed: [{ itemId: "item_001", aiDecision: "sell", confirmedDecision: "sell" }],
    };
    render(<BothPage />);
    await reachActions(user, scenario);

    expect(screen.getByText(/nothing to reorganise/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate reorganisation plan/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate listing drafts/i })).toBeEnabled();
  });

  test("a generation failure preserves confirmation and offers a retry", async () => {
    const user = userEvent.setup();
    client.generateConfirmedReorganisation.mockRejectedValueOnce(new Error("service unreachable"));
    render(<BothPage />);
    await reachActions(user);

    await user.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/service unreachable/i));
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Marketplace listings" })).toBeInTheDocument();
  });

  test("Start over resets the whole flow", async () => {
    const user = userEvent.setup();
    client.generateConfirmedReorganisation.mockResolvedValue(makeGeneratedResponse(KEEP));
    render(<BothPage />);
    await reachActions(user);
    await user.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));
    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /start over/i }));
    expect(currentStep()).toBe("Upload photo");
    expect(screen.getByLabelText(/room photo/i)).toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});

describe("BothPage independent final actions", () => {
  test("neither action starts automatically and both can run concurrently", async () => {
    const user = userEvent.setup();
    let resolveListings;
    let resolveReorganise;
    client.generateListings.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveListings = () => resolve(makeListingsResponse(makeConfirmResponse(KEEP_AND_SELL.confirmed), [makeDraft("item_002")]));
      })
    );
    client.generateConfirmedReorganisation.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveReorganise = () => resolve(makeGeneratedResponse(KEEP_AND_SELL.confirmed));
      })
    );
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);

    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    expect(screen.getByRole("button", { name: /generate reorganisation plan/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));
    expect(client.generateListings).toHaveBeenCalledTimes(1);
    expect(client.generateConfirmedReorganisation).toHaveBeenCalledTimes(1);

    resolveListings();
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());
    resolveReorganise();
    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument();
  });

  test("a listing failure does not disable Reorganise", async () => {
    const user = userEvent.setup();
    client.generateListings.mockRejectedValueOnce(new Error("listing service unreachable"));
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);

    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/listing service unreachable/i));
    expect(screen.getByRole("button", { name: /generate reorganisation plan/i })).toBeEnabled();
  });

  test("a completed reorganisation plan keeps edited listing drafts visible", async () => {
    const user = userEvent.setup();
    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse(makeConfirmResponse(KEEP_AND_SELL.confirmed), [makeDraft("item_002")])
    );
    client.generateConfirmedReorganisation.mockResolvedValueOnce(makeGeneratedResponse(KEEP_AND_SELL.confirmed));
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);

    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    const title = await screen.findByDisplayValue("Great lamp for sale");
    await user.clear(title);
    await user.type(title, "My edited title");
    await user.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));

    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());
    expect(screen.getByDisplayValue("My edited title")).toBeInTheDocument();
  });

  test("single-item listing regeneration remains independent of Reorganise", async () => {
    const user = userEvent.setup();
    const confirmation = makeConfirmResponse(KEEP_AND_SELL.confirmed);
    client.generateListings.mockResolvedValueOnce(makeListingsResponse(confirmation, [makeDraft("item_002")]));
    client.regenerateListing.mockResolvedValueOnce({
      run_id: "run1",
      confirmation,
      draft: makeDraft("item_002", { title: "Regenerated title" }),
      model_name: "phi4-mini",
      prompt_version: "v1",
      max_attempts: 3,
    });
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    await screen.findByDisplayValue("Great lamp for sale");
    await user.click(screen.getByRole("button", { name: /^regenerate draft$/i }));

    await waitFor(() => expect(screen.getByDisplayValue("Regenerated title")).toBeInTheDocument());
    expect(client.generateConfirmedReorganisation).not.toHaveBeenCalled();
  });
});

describe("BothPage checklist, focus areas and storage suggestions", () => {
  test("renders the same shared checklist, focus areas and storage suggestions as Direct Reorganise", async () => {
    const user = userEvent.setup();
    const response = makeGeneratedResponse(KEEP);
    response.storage_suggestions = [
      { name: "Compartment tray", reason: "Gives 2 small personal items a fixed compartment each.", related_item_ids: ["item_001"] },
    ];
    client.generateConfirmedReorganisation.mockResolvedValue(response);
    render(<BothPage />);
    await reachActions(user);

    await user.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));

    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Your tidy plan" })).toBeInTheDocument());
    const checklist = screen.getByRole("list", { name: /checklist actions/i });
    expect(within(checklist).getByText("Clear the desk")).toBeInTheDocument();
    const areas = screen.getByRole("region", { name: /areas to focus on/i });
    expect(within(areas).getByRole("heading", { level: 4, name: "Left side" })).toBeInTheDocument();
    const suggestions = screen.getByRole("region", { name: /storage suggestions/i });
    expect(within(suggestions).getByText("Compartment tray")).toBeInTheDocument();
    const subheadings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(subheadings.indexOf("Checklist")).toBeLessThan(subheadings.indexOf("Visual preview"));
    expect(subheadings.indexOf("Visual preview")).toBeLessThan(subheadings.indexOf("Areas to focus on"));
    expect(subheadings.indexOf("Areas to focus on")).toBeLessThan(subheadings.indexOf("Storage suggestions"));
    // listings stay available after the tidy plan, and navigation is unchanged
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf("Your tidy plan")).toBeLessThan(headings.indexOf("Marketplace listings"));
    expect(currentStep()).toBe("Results");
    expect(screen.getByRole("button", { name: /back to confirm/i })).toBeEnabled();
  });

  test("an unavailable visual preview still leaves the checklist, areas and suggestions visible", async () => {
    const user = userEvent.setup();
    const response = makeGeneratedResponse(KEEP, { imageStatus: "unavailable" });
    response.storage_suggestions = [
      { name: "Compartment tray", reason: "Gives 2 small personal items a fixed compartment each.", related_item_ids: ["item_001"] },
    ];
    client.generateConfirmedReorganisation.mockResolvedValue(response);
    render(<BothPage />);
    await reachActions(user);

    await user.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));

    await waitFor(() => expect(screen.getByText(/visual preview unavailable/i)).toBeInTheDocument());
    expect(screen.getByText("Clear the desk")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Left side" })).toBeInTheDocument();
    expect(screen.getByText("Compartment tray")).toBeInTheDocument();
    expect(screen.queryByText(/service_unreachable|reason code|technical detail/i)).not.toBeInTheDocument();
  });

  test("a response whose storage suggestion names a non-Keep item is rejected as a generation error", async () => {
    const user = userEvent.setup();
    const response = makeGeneratedResponse(KEEP);
    response.storage_suggestions = [{ name: "Compartment tray", reason: "x", related_item_ids: ["item_999"] }];
    client.generateConfirmedReorganisation.mockResolvedValue(response);
    render(<BothPage />);
    await reachActions(user);

    await user.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/unselected/i));
    expect(screen.queryByRole("heading", { name: "Your tidy plan" })).not.toBeInTheDocument();
    // listings remain independently available regardless
    expect(screen.getByRole("heading", { name: "Marketplace listings" })).toBeInTheDocument();
  });

  test("the production response renders as a plain checklist with no provenance shown, and checking steps leaves listings alone", async () => {
    const user = userEvent.setup();
    const response = makeGeneratedResponse(KEEP);
    response.action_plan = {
      ...response.action_plan,
      actions: [
        { priority: 1, title: "Start with the left side", instruction: "The left side of your photo holds 1 of your selected item (lamp). Straighten it and clear loose items from the space immediately around it." },
      ],
      provenance: "deterministic_direct",
      attempts: 0,
      model_name: null,
      prompt_version: null,
      was_repaired: null,
      issues: [],
    };
    client.generateConfirmedReorganisation.mockResolvedValue(response);
    render(<BothPage />);
    await reachActions(user);

    await user.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));

    await waitFor(() => expect(screen.getByText("Start with the left side")).toBeInTheDocument());
    expect(screen.queryByText(/ai assistant|deterministic|model call|phi4-mini|checklist details|generation details/i)).not.toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
    // listings and the visual are unaffected
    expect(screen.getByRole("heading", { name: /^visual preview$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Marketplace listings" })).toBeInTheDocument();

    // checking a checklist step is local presentation only: no listing or generation request follows
    await user.click(screen.getByRole("checkbox", { name: /start with the left side/i }));
    expect(screen.getByText("1 of 1 completed")).toBeInTheDocument();
    expect(client.generateListings).not.toHaveBeenCalled();
    expect(client.generateConfirmedReorganisation).toHaveBeenCalledTimes(1);
    // this scenario confirmed no Sell items, so the listings panel keeps its own empty state untouched
    expect(screen.getByRole("region", { name: "Marketplace listings" })).toHaveTextContent(/did not confirm any items as sell/i);
  });
});

describe("BothPage Decide items action bar", () => {
  const bar = () => screen.getByRole("region", { name: /decision summary and navigation/i });

  test("Decide items has exactly one Back and one Continue, in the shared sticky bar, with live counts", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await reachReview(user, [
      { itemId: "item_001", decision: "keep" },
      { itemId: "item_002", decision: "sell" },
      { itemId: "item_003", decision: "keep" },
    ]);

    expect(screen.getAllByRole("button", { name: /back to analyse room/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /continue to confirm choices/i })).toHaveLength(1);
    expect(bar().className).toMatch(/sticky/);
    expect(within(bar()).getByText("3 items")).toBeInTheDocument();
    expect(within(bar()).getByText("Keep").nextElementSibling).toHaveTextContent("2");
    expect(within(bar()).getByText("Sell").nextElementSibling).toHaveTextContent("1");
    expect(within(bar()).queryByText("Donate")).not.toBeInTheDocument();

    // change one decision: the counts follow, no request is made
    await user.click(screen.getAllByRole("radio", { name: "Donate" })[0]);
    expect(within(bar()).getByText("Keep").nextElementSibling).toHaveTextContent("1");
    expect(within(bar()).getByText("Donate").nextElementSibling).toHaveTextContent("1");
    expect(client.confirmDecisions).not.toHaveBeenCalled();
    expect(client.overrideItem).not.toHaveBeenCalled();
    expect(within(bar()).queryByRole("status")).not.toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: /continue to confirm choices/i })).toBeEnabled();
  });

  test("the bar explains a blocked Continue while a label correction is in flight", async () => {
    const user = userEvent.setup();
    let resolveOverride;
    client.overrideItem.mockImplementationOnce(() => new Promise((r) => { resolveOverride = r; }));
    render(<BothPage />);
    await reachReview(user);

    await user.click(screen.getAllByRole("button", { name: /wrong label/i })[0]);
    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await waitFor(() => expect(within(bar()).getByRole("status")).toHaveTextContent(/label correction is in progress/i));
    const cont = within(bar()).getByRole("button", { name: /continue to confirm choices/i });
    expect(cont).toBeDisabled();
    expect(cont).toHaveAttribute("aria-describedby", within(bar()).getByRole("status").id);

    const response = makeBothUploadResponse();
    resolveOverride({ run_id: "run1", analysis: response.analysis, declutter: response.declutter });
    await waitFor(() => expect(within(bar()).getByRole("button", { name: /continue to confirm choices/i })).toBeEnabled());
  });
});

describe("BothPage Confirm choices panel", () => {
  const confirmPanel = () => screen.getByRole("region", { name: /confirm your choices|choices confirmed/i });

  test("one panel transforms in place, states Both's independent next actions, and Continue to Results only navigates", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await reachReview(user, KEEP_AND_SELL.decisions);
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));

    expect(screen.getAllByRole("region", { name: /confirm your choices|choices confirmed/i })).toHaveLength(1);
    expect(within(confirmPanel()).getByText("Keep").closest("div").querySelector("dd")).toHaveTextContent("1");
    expect(within(confirmPanel()).getByText("Sell").closest("div").querySelector("dd")).toHaveTextContent("1");
    expect(within(confirmPanel()).queryByText("Donate")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue to results/i })).not.toBeInTheDocument();

    client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponse(KEEP_AND_SELL.confirmed));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());

    expect(screen.getAllByRole("region", { name: /confirm your choices|choices confirmed/i })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: /confirm your choices/i })).not.toBeInTheDocument();
    expect(within(confirmPanel()).getByRole("status")).toHaveTextContent(/2 decisions confirmed/i);
    expect(within(confirmPanel()).getByText(/tidy up and marketplace listings are separate actions/i)).toBeInTheDocument();
    expect(within(confirmPanel()).getByText(/neither starts automatically/i)).toBeInTheDocument();
    expect(confirmPanel().textContent).not.toMatch(/run1|item_00\d|item_id/i);

    await user.click(screen.getByRole("button", { name: /continue to results/i }));
    expect(currentStep()).toBe("Results");
    expect(client.generateListings).not.toHaveBeenCalled();
    expect(client.generateConfirmedReorganisation).not.toHaveBeenCalled();
  });
});
