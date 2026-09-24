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
    tidy_plan: { phases: [{ phase_id: "empty_clean", title: "Empty and clean", steps: [{ step_id: "empty_clean-1", text: "Clear the desk", item_ids: confirmation.confirmed_keep_ids.slice(0, 1) }] }] },
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
  await user.upload(screen.getByLabelText(/space photo/i), makeFile());
  await user.click(screen.getByRole("button", { name: /^analyse space$/i }));
  await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "What we found" })).toBeInTheDocument());
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
      "Analyse space",
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
    expect(screen.getByRole("button", { name: /create tidy plan/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /create tidy plan/i }));

    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());
    expect(screen.getByLabelText(/space photo/i)).not.toBeVisible();
  });

  test("zero Keep still reaches the final screen for confirmed Sell listings", async () => {
    const user = userEvent.setup();
    const scenario = {
      decisions: [{ itemId: "item_001", decision: "sell" }],
      confirmed: [{ itemId: "item_001", aiDecision: "sell", confirmedDecision: "sell" }],
    };
    render(<BothPage />);
    await reachActions(user, scenario);

    expect(screen.getByText(/nothing to include in a tidy plan/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create tidy plan/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate listing drafts/i })).toBeEnabled();
  });

  test("a generation failure preserves confirmation and offers a retry", async () => {
    const user = userEvent.setup();
    client.generateConfirmedReorganisation.mockRejectedValueOnce(new Error("service unreachable"));
    render(<BothPage />);
    await reachActions(user);

    await user.click(screen.getByRole("button", { name: /create tidy plan/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/service unreachable/i));
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Marketplace listings" })).toBeInTheDocument();
  });

  test("Start over resets the whole flow", async () => {
    const user = userEvent.setup();
    client.generateConfirmedReorganisation.mockResolvedValue(makeGeneratedResponse(KEEP));
    render(<BothPage />);
    await reachActions(user);
    await user.click(screen.getByRole("button", { name: /create tidy plan/i }));
    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /start over/i }));
    expect(currentStep()).toBe("Upload photo");
    expect(screen.getByLabelText(/space photo/i)).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: /create tidy plan/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /create tidy plan/i }));
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
    expect(screen.getByRole("button", { name: /create tidy plan/i })).toBeEnabled();
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
    await user.click(screen.getByRole("button", { name: /create tidy plan/i }));

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

describe("BothPage checklist and storage suggestions", () => {
  test("renders the same shared checklist and storage suggestions as Direct Reorganise, never a focus-areas section", async () => {
    const user = userEvent.setup();
    const response = makeGeneratedResponse(KEEP);
    response.storage_suggestions = [
      { name: "Compartment tray", reason: "Gives 2 small personal items a fixed compartment each.", related_item_ids: ["item_001"] },
    ];
    client.generateConfirmedReorganisation.mockResolvedValue(response);
    render(<BothPage />);
    await reachActions(user);

    await user.click(screen.getByRole("button", { name: /create tidy plan/i }));

    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Tidy up" })).toBeInTheDocument());
    const checklist = screen.getByRole("list", { name: /empty and clean steps/i });
    expect(within(checklist).getByText("Clear the desk")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /areas to focus on|focus areas/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/areas to focus on|focus area/i)).not.toBeInTheDocument();
    const suggestions = screen.getByRole("region", { name: /storage and organisation ideas/i });
    expect(within(suggestions).getByText("Compartment tray")).toBeInTheDocument();
    expect(within(suggestions).queryByText(/^For:/)).not.toBeInTheDocument();
    const subheadings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(subheadings.indexOf("Tidy plan")).toBeLessThan(subheadings.indexOf("Visual preview"));
    expect(subheadings.indexOf("Visual preview")).toBeLessThan(subheadings.indexOf("Storage and organisation ideas"));
    // listings stay available after the tidy plan, and navigation is unchanged
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf("Tidy up")).toBeLessThan(headings.indexOf("Marketplace listings"));
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

    await user.click(screen.getByRole("button", { name: /create tidy plan/i }));

    await waitFor(() => expect(screen.getByText(/visual preview unavailable/i)).toBeInTheDocument());
    expect(screen.getByText("Clear the desk")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /areas to focus on/i })).not.toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: /create tidy plan/i }));

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
        { priority: 1, title: "Straighten the lamp", instruction: "Set it neatly in place and clear the immediate space around it." },
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

    await user.click(screen.getByRole("button", { name: /create tidy plan/i }));

    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());
    expect(screen.queryByText("Straighten the lamp")).not.toBeInTheDocument();
    expect(screen.queryByText(/ai assistant|deterministic|model call|phi4-mini|checklist details|generation details/i)).not.toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Clear the desk" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /areas to focus on|focus areas/i })).not.toBeInTheDocument();
    // listings and the visual are unaffected
    expect(screen.getByRole("heading", { name: /^visual preview$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Marketplace listings" })).toBeInTheDocument();

    // checking a checklist step is local presentation only: no listing or generation request follows
    await user.click(screen.getByRole("checkbox", { name: "Clear the desk" }));
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

    expect(screen.getAllByRole("button", { name: /back to analyse space/i })).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// Results composition (brief §15): introduction, Tidy up, Marketplace
// listings, global actions; two independent sections, never one feed.
// ---------------------------------------------------------------------------

describe("BothPage Results composition", () => {
  const tidyUp = () => screen.getByRole("region", { name: "Tidy up" });
  const listings = () => screen.getByRole("region", { name: "Marketplace listings" });
  const actions = () => screen.getByRole("group", { name: /results actions/i });
  const createTidyPlan = () => screen.getByRole("button", { name: /create tidy plan/i });
  const generateListings = () => screen.getByRole("button", { name: /generate listing drafts/i });
  const order = (...nodes) => nodes.every((node, i) => i === 0 || Boolean(nodes[i - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));

  test("begins directly with Tidy up, then Marketplace listings, then the global actions, with no introduction", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);

    // no introductory heading or description above the two sections
    expect(screen.queryByRole("region", { name: "Your results" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Your results" })).not.toBeInTheDocument();
    expect(screen.queryByText(/you can start either one first/i)).not.toBeInTheDocument();
    const stack = tidyUp().parentElement;
    expect(stack.firstElementChild).toBe(tidyUp());
    expect(tidyUp().className).toMatch(/rounded-card/);
    expect(order(tidyUp(), listings(), actions())).toBe(true);
    // the two sections are the stack's first two children, in that order
    expect(Array.from(stack.children).slice(0, 2)).toEqual([tidyUp(), listings()]);
    // exactly one visible heading per result section, no tabs or nav cards
    expect(screen.getAllByRole("heading", { name: "Tidy up" })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "Marketplace listings" })).toHaveLength(1);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByText(/reorganise your confirmed keep items|generate reorganisation plan/i)).not.toBeInTheDocument();
  });

  test("Tidy up explains what it creates from the confirmed Keep count and offers Create tidy plan, full width on mobile", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await reachActions(user, {
      decisions: [
        { itemId: "item_001", decision: "keep" },
        { itemId: "item_002", decision: "keep" },
        { itemId: "item_003", decision: "sell" },
      ],
      confirmed: [
        { itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" },
        { itemId: "item_002", aiDecision: "keep", confirmedDecision: "keep" },
        { itemId: "item_003", aiDecision: "sell", confirmedDecision: "sell" },
      ],
    });

    expect(tidyUp()).toHaveTextContent(
      /prioritised checklist, relevant storage and organisation ideas and an optional visual preview from the 2 items you confirmed as Keep\./
    );
    const button = within(tidyUp()).getByRole("button", { name: "Create tidy plan" });
    expect(button).toBeEnabled();
    for (const cls of ["min-h-11", "w-full", "sm:w-auto", "sm:min-h-0"]) expect(button.className.split(/\s+/)).toContain(cls);
    // neither action has started
    expect(client.generateConfirmedReorganisation).not.toHaveBeenCalled();
    expect(client.generateListings).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("Tidy up loading and error states stay inside Tidy up and leave listings usable", async () => {
    const user = userEvent.setup();
    let rejectTidy;
    client.generateConfirmedReorganisation.mockImplementationOnce(
      () => new Promise((_, reject) => {
        rejectTidy = () => reject(new Error("tidy service unreachable"));
      })
    );
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);

    await user.click(createTidyPlan());
    const busy = within(tidyUp()).getByRole("button", { name: /creating tidy plan…/i });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(within(tidyUp()).getByRole("status")).toHaveTextContent(
      "Creating your checklist and visual preview. This may take several minutes."
    );
    expect(within(stepper()).getByText("Creating your tidy plan…")).toBeInTheDocument();
    expect(within(stepper()).getByText(/listings remain independently available/i)).toBeInTheDocument();
    // listings: untouched, enabled, no shared overlay or status
    expect(generateListings()).toBeEnabled();
    expect(within(listings()).queryByRole("status")).not.toBeInTheDocument();
    expect(listings()).not.toHaveAttribute("aria-busy");

    rejectTidy();
    await waitFor(() => expect(within(tidyUp()).getByRole("alert")).toHaveTextContent(/tidy service unreachable/i));
    expect(within(tidyUp()).getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(within(stepper()).getByText("The tidy plan didn't finish.")).toBeInTheDocument();
    expect(generateListings()).toBeEnabled();
    expect(within(listings()).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Marketplace listings" })).toHaveLength(1);
  });

  test("listing loading and error states stay inside Marketplace listings and leave Tidy up usable", async () => {
    const user = userEvent.setup();
    let rejectListings;
    client.generateListings.mockImplementationOnce(
      () => new Promise((_, reject) => {
        rejectListings = () => reject(new Error("listing service unreachable"));
      })
    );
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);

    await user.click(generateListings());
    expect(within(listings()).getByRole("status")).toBeInTheDocument();
    expect(within(stepper()).getByText("Generating your listing drafts…")).toBeInTheDocument();
    expect(within(stepper()).getByText(/tidy up remains independently available/i)).toBeInTheDocument();
    expect(createTidyPlan()).toBeEnabled();
    expect(within(tidyUp()).queryByRole("status")).not.toBeInTheDocument();

    rejectListings();
    await waitFor(() => expect(within(listings()).getByRole("alert")).toHaveTextContent(/listing service unreachable/i));
    expect(createTidyPlan()).toBeEnabled();
    expect(within(tidyUp()).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Tidy up" })).toHaveLength(1);
  });

  test("the tidy plan can be created first and the listings after, with both results then visible", async () => {
    const user = userEvent.setup();
    client.generateConfirmedReorganisation.mockResolvedValueOnce(makeGeneratedResponse(KEEP_AND_SELL.confirmed));
    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse(makeConfirmResponse(KEEP_AND_SELL.confirmed), [makeDraft("item_002")])
    );
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);

    await user.click(createTidyPlan());
    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());
    // the result IS the Tidy up section, headed "Tidy up" (never "Your tidy plan" here)
    expect(within(tidyUp()).getByRole("heading", { level: 2, name: "Tidy up" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Your tidy plan" })).not.toBeInTheDocument();
    expect(within(stepper()).getByText("Your tidy plan is ready.")).toBeInTheDocument();
    expect(generateListings()).toBeEnabled();

    await user.click(generateListings());
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());
    expect(screen.getByText("Clear the desk")).toBeInTheDocument();
    expect(order(tidyUp(), listings(), actions())).toBe(true);
    expect(client.generateConfirmedReorganisation).toHaveBeenCalledTimes(1);
    expect(client.generateListings).toHaveBeenCalledTimes(1);
  });

  test("checklist interaction never touches listing state, and listing interaction never touches checklist completion", async () => {
    const user = userEvent.setup();
    client.generateConfirmedReorganisation.mockResolvedValueOnce(makeGeneratedResponse(KEEP_AND_SELL.confirmed));
    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse(makeConfirmResponse(KEEP_AND_SELL.confirmed), [makeDraft("item_002")])
    );
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);
    await user.click(generateListings());
    await screen.findByDisplayValue("Great lamp for sale");
    await user.click(createTidyPlan());
    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Clear the desk" }));
    expect(screen.getByText("1 of 1 completed")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument();
    expect(client.generateListings).toHaveBeenCalledTimes(1);
    expect(client.regenerateListing).not.toHaveBeenCalled();

    const title = screen.getByDisplayValue("Great lamp for sale");
    await user.clear(title);
    await user.type(title, "Edited");
    await user.click(screen.getByRole("button", { name: /discard draft/i }));
    expect(screen.getByText("1 of 1 completed")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Clear the desk" })).toBeChecked();
    expect(client.generateConfirmedReorganisation).toHaveBeenCalledTimes(1);
  });

  test("zero Keep shows a calm empty state without a button and keeps listings independent; zero Sell keeps Tidy up working", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await reachActions(user, {
      decisions: [{ itemId: "item_001", decision: "sell" }],
      confirmed: [{ itemId: "item_001", aiDecision: "sell", confirmedDecision: "sell" }],
    });
    expect(within(tidyUp()).getByRole("heading", { name: "Tidy up" })).toBeInTheDocument();
    const empty = within(tidyUp()).getByText(/nothing to include in a tidy plan/i).parentElement;
    expect(empty.className).toMatch(/bg-surface-muted/);
    expect(empty.className).toMatch(/text-muted-foreground/);
    expect(empty).toHaveTextContent(/marketplace listings below remain available for the items you confirmed as sell/i);
    expect(within(tidyUp()).queryByRole("button")).not.toBeInTheDocument();
    expect(within(tidyUp()).queryByRole("status")).not.toBeInTheDocument();
    expect(within(tidyUp()).queryByText(/visual preview is currently unavailable/i)).not.toBeInTheDocument();
    expect(generateListings()).toBeEnabled();
    expect(actions()).toBeInTheDocument();
  });

  test("zero Sell keeps the Tidy up action beside the listings' own truthful empty state", async () => {
    const user = userEvent.setup();
    client.generateConfirmedReorganisation.mockResolvedValueOnce(makeGeneratedResponse(KEEP));
    render(<BothPage />);
    await reachActions(user);
    expect(listings()).toHaveTextContent(/did not confirm any items as sell/i);
    expect(within(listings()).queryByRole("button")).not.toBeInTheDocument();
    expect(createTidyPlan()).toBeEnabled();
    await user.click(createTidyPlan());
    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());
    expect(listings()).toHaveTextContent(/did not confirm any items as sell/i);
  });

  test("the image-service notice lives inside Tidy up only, never disables Create tidy plan, and is not repeated once a result has its own unavailable preview", async () => {
    const user = userEvent.setup();
    client.getImageGenHealth.mockResolvedValue({ available: false });
    client.generateConfirmedReorganisation.mockResolvedValueOnce(makeGeneratedResponse(KEEP_AND_SELL.confirmed, { imageStatus: "unavailable" }));
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);

    const notices = screen.getAllByText(/visual preview is currently unavailable/i);
    expect(notices).toHaveLength(1);
    expect(tidyUp()).toContainElement(notices[0]);
    expect(listings()).not.toContainElement(notices[0]);
    expect(screen.queryByText(/image service is offline/i)).not.toBeInTheDocument();
    expect(within(tidyUp()).getByRole("button", { name: /check again/i })).toBeEnabled();
    expect(createTidyPlan()).toBeEnabled();

    await user.click(createTidyPlan());
    await waitFor(() => expect(screen.getByRole("heading", { name: /visual preview unavailable/i })).toBeInTheDocument());
    expect(screen.queryByText(/visual preview is currently unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check again/i })).not.toBeInTheDocument();
    expect(screen.getByText("Clear the desk")).toBeInTheDocument();
    expect(generateListings()).toBeEnabled();
  });

  test("Check again inside Tidy up rechecks availability exactly as before", async () => {
    const user = userEvent.setup();
    client.getImageGenHealth.mockResolvedValue({ available: false });
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalledTimes(1));
    client.getImageGenHealth.mockResolvedValue({ available: true });
    await user.click(within(tidyUp()).getByRole("button", { name: /check again/i }));
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/visual preview is currently unavailable/i)).not.toBeInTheDocument());
    expect(createTidyPlan()).toBeEnabled();
  });

  test("exactly one global Start over after both sections, then Back to Confirm choices, and it still resets the whole flow", async () => {
    const user = userEvent.setup();
    client.generateConfirmedReorganisation.mockResolvedValueOnce(makeGeneratedResponse(KEEP_AND_SELL.confirmed));
    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse(makeConfirmResponse(KEEP_AND_SELL.confirmed), [makeDraft("item_002")])
    );
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);
    await user.click(createTidyPlan());
    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());
    await user.click(generateListings());
    await screen.findByDisplayValue("Great lamp for sale");

    const startOvers = screen.getAllByRole("button", { name: /start over/i });
    expect(startOvers).toHaveLength(1);
    const [startOver] = startOvers;
    expect(actions()).toContainElement(startOver);
    expect(tidyUp()).not.toContainElement(startOver);
    expect(listings()).not.toContainElement(startOver);
    expect(startOver.className).toMatch(/border-input/);
    expect(startOver.className).not.toMatch(/bg-primary/);
    expect(startOver.querySelector("svg")).not.toBeNull();
    for (const cls of ["min-h-11", "w-full", "sm:w-auto"]) expect(startOver.className.split(/\s+/)).toContain(cls);
    const back = screen.getByRole("button", { name: /back to confirm choices/i });
    expect(screen.getAllByRole("button", { name: /back to confirm/i })).toHaveLength(1);
    expect(actions()).toContainElement(back);
    expect(order(tidyUp(), listings(), startOver, back)).toBe(true);
    expect(back).toBeEnabled();

    await user.click(startOver);
    expect(currentStep()).toBe("Upload photo");
    expect(screen.getByLabelText(/space photo/i)).toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(screen.queryByText("Clear the desk")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Great lamp for sale")).not.toBeInTheDocument();
  });

  test("the two sections stack vertically and never sit in forced side-by-side columns or overflow", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await reachActions(user, KEEP_AND_SELL);
    const stack = tidyUp().parentElement;
    expect(stack).toBe(listings().parentElement);
    expect(stack.className).toMatch(/space-y-8/);
    expect(stack.className).not.toMatch(/grid-cols|flex-row|columns-/);
    expect(stack.innerHTML).not.toMatch(/overflow-x-auto|w-screen/);
    // the layout containers never force a single line (the Button primitive alone is nowrap by design)
    for (const el of stack.querySelectorAll("section, div, ol, ul, p")) expect(el.className).not.toMatch(/whitespace-nowrap/);
  });
});

// ---------------------------------------------------------------------------
// Upload photo + Analyse space screens (shared redesign phase)
// ---------------------------------------------------------------------------

describe("BothPage Upload photo and Analyse space screens", () => {
  const analyseHeading = (name) => screen.getByRole("heading", { level: 2, name });
  const whatWeFound = () => screen.getByRole("heading", { level: 2, name: "What we found" });
  const visibleH2s = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent.trim());
  const JARGON = /scene classification|object detection|item reasoning|candidate|confidence|\d+%|analysis time|this computer|\broom\b/i;

  async function submitPhoto(user) {
    await user.upload(screen.getByLabelText(/space photo/i), makeFile());
    await user.type(screen.getByLabelText(/context for the ai/i), "be decisive");
    await user.click(screen.getByRole("button", { name: /^analyse space$/i }));
  }

  test("Upload photo uses the shared heading and copy plus Both's own outcome intro, and never says room", () => {
    render(<BothPage />);
    expect(screen.getByRole("form", { name: "Upload a photo of your space" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Upload one clear photo of your space, with most items in frame. You can also provide optional context to help the AI better understand your space."
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/then create a tidy plan and marketplace listing drafts from your confirmed choices, in either order/i)).toBeInTheDocument();
    expect(screen.queryByText(/reorganisation checklist/i)).not.toBeInTheDocument();
    const upload = screen.getByRole("form", { name: "Upload a photo of your space" }).parentElement;
    expect(upload.textContent).not.toMatch(/\broom\b|^\s*1\./i);
    expect(client.uploadImage).not.toHaveBeenCalled();
  });

  test("analysing: one heading, one calm jargon-free status with a spinner, locked controls, exactly one request", async () => {
    const user = userEvent.setup();
    let resolveUpload;
    client.uploadImage.mockImplementationOnce(() => new Promise((r) => { resolveUpload = () => r(makeBothUploadResponse()); }));
    render(<BothPage />);
    await submitPhoto(user);

    await waitFor(() => expect(currentStep()).toBe("Analyse space"));
    expect(analyseHeading("Analysing your space")).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Finding items and preparing your next step. This may take up to two minutes.");
    expect(status.querySelector("svg")).not.toBeNull();
    expect(status.textContent).not.toMatch(JARGON);
    expect(screen.queryByRole("heading", { name: /what we found/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back to upload photo/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /continue to decide items/i })).toBeDisabled();
    expect(client.uploadImage).toHaveBeenCalledTimes(1);
    resolveUpload();
    await waitFor(() => expect(whatWeFound()).toBeInTheDocument());
  });

  test("error: Analysis unsuccessful with one alert pointing back to the preserved photo and context, no auto retry", async () => {
    const user = userEvent.setup();
    client.uploadImage.mockRejectedValueOnce(new Error("The analysis service is unavailable."));
    render(<BothPage />);
    await submitPhoto(user);

    await waitFor(() => expect(analyseHeading("Analysis unsuccessful")).toBeInTheDocument());
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/the analysis service is unavailable/i);
    expect(alerts[0]).toHaveTextContent(/your selected photo and context are still on upload photo/i);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to decide items/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /back to upload photo/i }));
    expect(currentStep()).toBe("Upload photo");
    expect(screen.getByText("room.png")).toBeInTheDocument();
    expect(screen.getByText(/replace photo/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/context for the ai/i)).toHaveValue("be decisive");
    expect(screen.getByRole("button", { name: /^analyse space$/i })).toBeEnabled();
    expect(client.uploadImage).toHaveBeenCalledTimes(1);
  });

  test("success: What we found is the single visible h2, with no second heading or banner, and Decide items stats", async () => {
    const user = userEvent.setup();
    client.uploadImage.mockResolvedValueOnce(
      makeBothUploadResponse({
        decisions: [
          { itemId: "item_001", decision: "keep" },
          { itemId: "item_002", decision: "sell" },
        ],
      })
    );
    render(<BothPage />);
    await submitPhoto(user);

    await waitFor(() => expect(whatWeFound()).toBeInTheDocument());
    // the success state carries no page heading or banner of its own: the tracker's
    // live status line says it once, and What we found is the only visible h2
    expect(screen.queryByRole("heading", { name: /analysis complete/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/your space has been analysed/i)).not.toBeInTheDocument();
    expect(visibleH2s()).toEqual(["What we found"]);
    expect(whatWeFound().closest("section").parentElement.querySelector('[role="status"]')).toBeNull();
    expect(whatWeFound().closest("section").parentElement.querySelector(".bg-success\\/10")).toBeNull();
    expect(within(stepper()).getByText("Analysis complete.")).toBeInTheDocument();
    expect(within(stepper()).getByText("Continue to Decide items to check each item.")).toBeInTheDocument();
    expect(within(stepper()).getByText("Analysis complete.").closest("[aria-live]")).not.toBeNull();
    const summary = screen.getByRole("region", { name: "What we found" });
    expect(Array.from(summary.querySelectorAll("dt")).map((dt) => dt.textContent)).toEqual(["Space type", "Items found", "Ready to review"]);
    expect(Array.from(summary.querySelectorAll("dd")).map((dd) => dd.textContent)).toEqual(["bedroom", "2", "2"]);
    expect(summary.textContent).not.toMatch(JARGON);
    expect(screen.queryByText(/extra review/i)).not.toBeInTheDocument();
    expect(whatWeFound().closest("section").parentElement.textContent).not.toMatch(/\broom\b/i);
    expect(screen.getByRole("button", { name: /continue to decide items/i })).toBeEnabled();
    expect(currentStep()).toBe("Analyse space");
    expect(client.confirmDecisions).not.toHaveBeenCalled();
  });

  test("a warning in the analysis shows one calm sentence, never the code", async () => {
    const user = userEvent.setup();
    const response = makeBothUploadResponse();
    response.analysis.warnings = [{ code: "low_confidence_scene", message: "internal detail" }];
    client.uploadImage.mockResolvedValueOnce(response);
    render(<BothPage />);
    await submitPhoto(user);
    await waitFor(() => expect(whatWeFound()).toBeInTheDocument());
    expect(screen.getByText("Some results may need extra review.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What we found" }).textContent).not.toMatch(/low_confidence_scene|internal detail/);
  });

  test("Back to Upload photo keeps the selected photo and context, and forward again does not re-analyse", async () => {
    const user = userEvent.setup();
    client.uploadImage.mockResolvedValueOnce(makeBothUploadResponse());
    render(<BothPage />);
    await submitPhoto(user);
    await waitFor(() => expect(whatWeFound()).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /back to upload photo/i }));
    expect(currentStep()).toBe("Upload photo");
    expect(screen.getByText("room.png")).toBeInTheDocument();
    expect(screen.getByLabelText(/context for the ai/i)).toHaveValue("be decisive");

    await user.click(within(stepper()).getByRole("button", { name: /go to analyse space/i }));
    expect(currentStep()).toBe("Analyse space");
    expect(whatWeFound()).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /analysis complete/i })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What we found" })).toBeInTheDocument();
    expect(client.uploadImage).toHaveBeenCalledTimes(1);
  });
});
