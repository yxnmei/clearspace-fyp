import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import DeclutterPage from "./DeclutterPage";
import * as client from "../api/client";

// Only the network boundary is mocked, the real useDeclutterFlow, the
// real contract adapters and every view component run for real, so these
// prove the actual wizard wiring.
vi.mock("../api/client", () => ({
  uploadImage: vi.fn(),
  confirmDecisions: vi.fn(),
  overrideItem: vi.fn(),
  generateListings: vi.fn(),
  regenerateListing: vi.fn(),
}));

function makeFile(name) {
  return new File(["fake bytes"], name, { type: "image/jpeg" });
}

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

function makeUploadResponse(runId, { unresolved = false } = {}) {
  const items = [makeItem()];
  const expected = ["item_001"];
  const validity = { item_001: "raw_valid" };
  if (unresolved) {
    items.push(
      makeItem({
        item_id: "item_009",
        source_detection_index: 1,
        raw_phrase: "cable",
        clean_label: "cable",
        effective_label: "cable",
        box: { x1: 0.5, y1: 0.5, x2: 0.6, y2: 0.6 },
        confidence: 0.4,
        position: "center",
      })
    );
    expected.push("item_009");
    validity.item_009 = "still_invalid";
  }
  return {
    run_id: runId,
    path: "declutter",
    analysis: {
      run_id: runId,
      scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
      items,
      warnings: [],
      stage_timings: [],
    },
    declutter: {
      run_id: runId,
      expected_item_ids: expected,
      ai_decisions: [{ item_id: "item_001", decision: "keep", reason: "still useful" }],
      unresolved_item_ids: unresolved ? ["item_009"] : [],
      item_validity: validity,
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
  };
}

function makeConfirmResponse(runId) {
  return {
    run_id: runId,
    confirmed_decisions: [
      { item_id: "item_001", ai_decision: "keep", confirmed_decision: "keep", ai_reason: "still useful", user_reason: null, excluded: false, decision_changed: false },
    ],
    confirmed_keep_ids: ["item_001"],
    decision_changed_count: 0,
    excluded_count: 0,
  };
}

let nextUrlSuffix = 0;
beforeEach(() => {
  vi.clearAllMocks();
  nextUrlSuffix = 0;
  global.URL.createObjectURL = vi.fn(() => `blob:mock-${nextUrlSuffix++}`);
  global.URL.revokeObjectURL = vi.fn();
});

// ---- helpers ----------------------------------------------------------
const nav = () => screen.getByRole("navigation", { name: /declutter workflow progress/i });
const trackerSteps = () =>
  within(nav())
    .getAllByRole("listitem")
    .map((li) => ({
      label: li.textContent.replace(/\d+/g, "").trim(),
      current: li.getAttribute("aria-current") === "step",
      button: within(li).queryByRole("button"),
    }));
const viewedLabel = () => trackerSteps().find((s) => s.current)?.label;

async function analyseFrom(user, response) {
  client.uploadImage.mockResolvedValueOnce(response);
  await user.upload(screen.getByLabelText(/space photo/i), makeFile("room.jpg"));
  await user.click(screen.getByRole("button", { name: /^analyse space$/i }));
  await waitFor(() => expect(screen.getByRole("heading", { name: /^what we found$/i })).toBeInTheDocument());
}

// ---------------------------------------------------------------------

describe("DeclutterPage wizard, one view at a time", () => {
  test("Upload is the initial view; Analyse/Review/Confirm content is not shown", () => {
    render(<DeclutterPage />);
    expect(viewedLabel()).toBe("Upload photo");
    expect(screen.getByRole("heading", { name: /^upload a photo of your space$/i })).toBeInTheDocument();
    expect(screen.getByText(/get a suggested action for every item/i)).toBeInTheDocument();

    expect(screen.queryByRole("heading", { name: /analysing your space/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /review your declutter decisions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm decisions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /detected item outlines/i })).not.toBeInTheDocument();
  });

  test("submitting Upload moves to Analyse and dispatches exactly one upload", async () => {
    const user = userEvent.setup();
    let resolveUpload;
    client.uploadImage.mockImplementationOnce(
      () => new Promise((r) => { resolveUpload = () => r(makeUploadResponse("run-a")); })
    );
    render(<DeclutterPage />);

    await user.upload(screen.getByLabelText(/space photo/i), makeFile("room.jpg"));
    await user.click(screen.getByRole("button", { name: /^analyse space$/i }));

    expect(client.uploadImage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(viewedLabel()).toBe("Analyse space"));
    expect(screen.getByRole("status")).toHaveTextContent("Finding items and preparing your next step. This may take up to two minutes.");
    // Upload form is no longer visible
    expect(screen.queryByRole("button", { name: /^analyse space$/i })).not.toBeInTheDocument();

    resolveUpload();
    await waitFor(() => expect(screen.getByRole("heading", { name: /^what we found$/i })).toBeInTheDocument());
  });

  test("Analyse success does not auto-skip its completed view", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));

    expect(viewedLabel()).toBe("Analyse space");
    expect(screen.getByRole("heading", { name: /^what we found$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to decide items/i })).toBeEnabled();
    // Review content still hidden until the user continues
    expect(screen.queryByRole("img", { name: /detected item outlines/i })).not.toBeInTheDocument();
  });

  test("Continue moves Analyse → Review; Continue there unlocks + opens Confirm", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));

    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    expect(viewedLabel()).toBe("Decide items");
    expect(screen.getByRole("heading", { name: /review your declutter decisions/i })).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(1); // one full-size analysed-room image

    // Confirm is still locked in the tracker until acknowledged
    expect(trackerSteps().find((s) => s.label === "Confirm choices").button).toBeNull();

    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(viewedLabel()).toBe("Confirm choices");
    expect(screen.getByRole("heading", { name: "Confirm your choices" })).toBeInTheDocument();
    // Confirm is now a navigable tracker step
    const trackerConfirm = within(nav()).queryAllByRole("button", { name: "Go to Confirm choices" });
    expect(trackerConfirm.length).toBe(0); // it is the current step, so not a button
    expect(within(nav()).getByRole("button", { name: "Go to Decide items" })).toBeInTheDocument();
  });
});

describe("DeclutterPage wizard, Review → Confirm gating", () => {
  test("Continue to Confirm is blocked while an expected item is unresolved", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a", { unresolved: true }));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    expect(screen.getByRole("button", { name: /continue to confirm/i })).toBeDisabled();
    expect(screen.getByText(/could not suggest an action for this item/i)).toBeInTheDocument();
    // tracker never unlocked Confirm
    expect(trackerSteps().find((s) => s.label === "Confirm choices").button).toBeNull();
  });

  test("Continue to Confirm is blocked while a label correction is in flight", async () => {
    const user = userEvent.setup();
    let resolveOverride;
    client.overrideItem.mockImplementationOnce(() => new Promise((r) => { resolveOverride = r; }));
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    const wrongLabelButtons = screen.getAllByRole("button", { name: /wrong label/i });
    await user.click(wrongLabelButtons[0]);
    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /continue to confirm/i })).toBeDisabled());

    resolveOverride({ run_id: "run-a", analysis: makeUploadResponse("run-a").analysis, declutter: makeUploadResponse("run-a").declutter });
    await waitFor(() => expect(screen.getByRole("button", { name: /continue to confirm/i })).toBeEnabled());
  });
});

describe("DeclutterPage wizard, Confirm is an explicit action", () => {
  test("entering Confirm does not call the confirmation API", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));

    expect(client.confirmDecisions).not.toHaveBeenCalled();
  });

  test("only the Confirm decisions button triggers /confirm, then the summary appears", async () => {
    const user = userEvent.setup();
    client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponse("run-a"));
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));

    expect(client.confirmDecisions).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    expect(client.confirmDecisions).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());
  });
});

describe("DeclutterPage wizard, tracker navigation", () => {
  test("completed tracker steps navigate backward without any API call", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    expect(viewedLabel()).toBe("Decide items");

    client.uploadImage.mockClear();
    await user.click(within(nav()).getByRole("button", { name: "Go to Analyse space" }));
    expect(viewedLabel()).toBe("Analyse space");
    await user.click(within(nav()).getByRole("button", { name: "Go to Upload photo" }));
    expect(viewedLabel()).toBe("Upload photo");

    expect(client.uploadImage).not.toHaveBeenCalled();
    expect(client.confirmDecisions).not.toHaveBeenCalled();
  });

  test("locked future steps are not activatable", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    // Before any upload: only Upload is unlocked.
    expect(within(nav()).queryByRole("button", { name: "Go to Analyse space" })).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Go to Decide items" })).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Go to Confirm choices" })).toBeNull();

    await analyseFrom(user, makeUploadResponse("run-a"));
    // Review is unlocked (analysis succeeded); Confirm is still locked.
    expect(within(nav()).getByRole("button", { name: "Go to Upload photo" })).toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: "Go to Decide items" })).toBeInTheDocument();
    expect(within(nav()).queryByRole("button", { name: "Go to Confirm choices" })).toBeNull();
  });

  test("navigation is not offered while the analysis request is in flight", async () => {
    const user = userEvent.setup();
    let resolveUpload;
    client.uploadImage.mockImplementationOnce(
      () => new Promise((r) => { resolveUpload = () => r(makeUploadResponse("run-a")); })
    );
    render(<DeclutterPage />);
    await user.upload(screen.getByLabelText(/space photo/i), makeFile("room.jpg"));
    await user.click(screen.getByRole("button", { name: /^analyse space$/i }));
    await waitFor(() => expect(viewedLabel()).toBe("Analyse space"));

    // No tracker buttons at all while uploading; Back is disabled.
    expect(within(nav()).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /back to upload/i })).toBeDisabled();

    resolveUpload();
    await waitFor(() => expect(within(nav()).getByRole("button", { name: "Go to Upload photo" })).toBeInTheDocument());
  });

  test("Back/Continue controls track availability with the tracker", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));

    // On Analyse: Back to Upload enabled, Continue to Review enabled.
    expect(screen.getByRole("button", { name: /back to upload/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /continue to decide items/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    expect(screen.getByRole("button", { name: /back to analyse/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /continue to confirm/i })).toBeEnabled();
  });
});

describe("DeclutterPage wizard, state preservation", () => {
  test("review decisions and exclusions survive Review → Confirm → Review", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    // change the item to Sell and mark it excluded
    await user.click(screen.getByRole("radio", { name: "Sell" }));
    await user.click(screen.getByRole("checkbox", { name: /exclude this item/i }));
    expect(screen.getByRole("radio", { name: "Sell" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(viewedLabel()).toBe("Confirm choices");
    await user.click(within(nav()).getByRole("button", { name: "Go to Decide items" }));
    expect(viewedLabel()).toBe("Decide items");

    // Still Sell, still excluded.
    expect(screen.getByRole("radio", { name: "Sell" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /exclude this item/i })).toBeChecked();
  });

  test("a confirmed result survives navigation until the user edits a decision", async () => {
    const user = userEvent.setup();
    client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponse("run-a"));
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());

    // Navigate away and back, the confirmed summary is still there.
    await user.click(within(nav()).getByRole("button", { name: "Go to Decide items" }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument();

    // Now edit a decision on Review, the hook invalidates the confirmation.
    await user.click(within(nav()).getByRole("button", { name: "Go to Decide items" }));
    await user.click(screen.getAllByRole("radio", { name: "Donate" })[0]);
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(screen.queryByRole("heading", { name: /choices confirmed/i })).not.toBeInTheDocument();
  });

  test("a new upload relocks stale downstream steps and starts a fresh Analyse view", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    // Confirm is now unlocked (viewing it); step back so it shows as a button.
    await user.click(within(nav()).getByRole("button", { name: "Go to Decide items" }));
    expect(within(nav()).getByRole("button", { name: "Go to Confirm choices" })).toBeInTheDocument();

    // Back to Upload, submit a new photo, hold the request in flight.
    await user.click(within(nav()).getByRole("button", { name: "Go to Upload photo" }));
    let resolveUpload;
    client.uploadImage.mockImplementationOnce(
      () => new Promise((r) => { resolveUpload = () => r(makeUploadResponse("run-b")); })
    );
    await user.upload(screen.getByLabelText(/space photo/i), makeFile("room-b.jpg"));
    await user.click(screen.getByRole("button", { name: /^analyse space$/i }));

    // Straight to a fresh Analyse view; every downstream step relocked.
    await waitFor(() => expect(viewedLabel()).toBe("Analyse space"));
    expect(within(nav()).queryAllByRole("button")).toHaveLength(0); // locked while uploading
    expect(screen.queryByRole("heading", { name: /^what we found$/i })).not.toBeInTheDocument();

    resolveUpload();
    // The new analysis re-unlocks Review, but Confirm stays locked until
    // the user acknowledges the new review.
    await waitFor(() => expect(within(nav()).getByRole("button", { name: "Go to Decide items" })).toBeInTheDocument());
    expect(within(nav()).queryByRole("button", { name: "Go to Confirm choices" })).toBeNull();
    expect(client.uploadImage).toHaveBeenCalledTimes(2);
  });

  test("returning to Upload via the tracker does not reset the current run", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    await user.click(within(nav()).getByRole("button", { name: "Go to Upload photo" }));
    // still analysed, Review is still reachable, nothing was re-uploaded
    expect(within(nav()).getByRole("button", { name: "Go to Decide items" })).toBeInTheDocument();
    await user.click(within(nav()).getByRole("button", { name: "Go to Decide items" }));
    expect(screen.getByRole("heading", { name: /review your declutter decisions/i })).toBeInTheDocument();
    expect(client.uploadImage).toHaveBeenCalledTimes(1);
  });
});

describe("DeclutterPage wizard, Review decision filters", () => {
  function makeThreeItemResponse(runId) {
    const mk = (id, idx, label, box) =>
      makeItem({ item_id: id, source_detection_index: idx, raw_phrase: label, clean_label: label, effective_label: label, box });
    return {
      run_id: runId,
      path: "declutter",
      analysis: {
        run_id: runId,
        scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
        items: [
          mk("item_001", 0, "lamp", { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 }),
          mk("item_002", 1, "old chair", { x1: 0.4, y1: 0.1, x2: 0.6, y2: 0.4 }),
          mk("item_003", 2, "broken mug", { x1: 0.7, y1: 0.6, x2: 0.8, y2: 0.75 }),
        ],
        warnings: [],
        stage_timings: [],
      },
      declutter: {
        run_id: runId,
        expected_item_ids: ["item_001", "item_002", "item_003"],
        ai_decisions: [
          { item_id: "item_001", decision: "keep", reason: "still useful" },
          { item_id: "item_002", decision: "sell", reason: "worth money" },
          { item_id: "item_003", decision: "discard", reason: "broken" },
        ],
        unresolved_item_ids: [],
        item_validity: { item_001: "raw_valid", item_002: "raw_valid", item_003: "raw_valid" },
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
    };
  }

  const chip = (name) =>
    within(screen.getByRole("group", { name: /filter items by decision/i })).getByRole("button", {
      name: new RegExp(`^${name}`, "i"),
    });

  test("changing a decision moves the item between filters immediately, and counts follow", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeThreeItemResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    await user.click(chip("Sell"));
    expect(screen.getByText("old chair")).toBeInTheDocument();
    expect(screen.queryByText("lamp")).not.toBeInTheDocument();
    expect(chip("Sell")).toHaveTextContent("1");
    expect(chip("Keep")).toHaveTextContent("1");

    // Re-decide the visible Sell item as Keep, it must leave the Sell view at once.
    await user.click(within(screen.getByText("old chair").closest("li")).getByRole("radio", { name: "Keep" }));
    expect(screen.queryByText("old chair")).not.toBeInTheDocument();
    expect(chip("Sell")).toHaveTextContent("0");
    expect(chip("Keep")).toHaveTextContent("2");
    expect(screen.getByText("No items currently marked as Sell.")).toBeInTheDocument();
  });

  test("the selected filter survives Review → Confirm → Review", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeThreeItemResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    await user.click(chip("Discard"));
    expect(chip("Discard")).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(viewedLabel()).toBe("Confirm choices");
    await user.click(within(nav()).getByRole("button", { name: "Go to Decide items" }));
    expect(viewedLabel()).toBe("Decide items");

    expect(chip("Discard")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("broken mug")).toBeInTheDocument();
    expect(screen.queryByText("lamp")).not.toBeInTheDocument();
  });

  test("duplicate-label rows filter independently by item_id", async () => {
    const user = userEvent.setup();
    const response = makeThreeItemResponse("run-a");
    response.analysis.items[1].clean_label = "lamp";
    response.analysis.items[1].raw_phrase = "lamp";
    response.analysis.items[1].effective_label = "lamp";
    render(<DeclutterPage />);
    await analyseFrom(user, response);
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    // Two "lamp" rows, one Keep (item_001) and one Sell (item_002).
    await user.click(chip("Keep"));
    expect(screen.getAllByText("lamp")).toHaveLength(1);
    await user.click(chip("Sell"));
    expect(screen.getAllByText("lamp")).toHaveLength(1);
  });
});

describe("DeclutterPage wizard, Analyse view state wording", () => {
  test("heading reads Analysing / complete / unsuccessful as the request state changes", async () => {
    const user = userEvent.setup();
    let resolveUpload;
    let rejectUpload;
    client.uploadImage.mockImplementationOnce(
      () => new Promise((res, rej) => { resolveUpload = res; rejectUpload = rej; })
    );
    render(<DeclutterPage />);
    await user.upload(screen.getByLabelText(/space photo/i), makeFile("room.jpg"));
    await user.click(screen.getByRole("button", { name: /^analyse space$/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Analysing your space" })).toBeInTheDocument());

    resolveUpload(makeUploadResponse("run-a"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "What we found" })).toBeInTheDocument());
    // success has no page heading of its own: the tracker says "Analysis complete." and the summary is the h2
    expect(screen.queryByRole("heading", { name: /analysis complete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Analysing your space" })).not.toBeInTheDocument();
    expect(within(nav()).getByText("Analysis complete.")).toBeInTheDocument();
    expect(screen.queryByText(/keeps going even if you leave/i)).not.toBeInTheDocument();

    // second run fails
    client.uploadImage.mockImplementationOnce(() => Promise.reject(new Error("network down")));
    await user.click(within(nav()).getByRole("button", { name: "Go to Upload photo" }));
    await user.click(screen.getByRole("button", { name: /^analyse space$/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Analysis unsuccessful" })).toBeInTheDocument());
    rejectUpload?.(new Error("ignored"));
  });
});

describe("DeclutterPage wizard, analysed image lifecycle", () => {
  test("the Review image is the analysed photo; a re-analysis replaces it and revokes the old object URL", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    const firstSrc = screen.getByRole("img", { name: /detected item outlines/i }).getAttribute("src");
    expect(firstSrc).toBeTruthy();

    await user.click(within(nav()).getByRole("button", { name: "Go to Upload photo" }));
    await analyseFrom(user, makeUploadResponse("run-b"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    const secondSrc = screen.getByRole("img", { name: /detected item outlines/i }).getAttribute("src");
    expect(secondSrc).not.toBe(firstSrc);
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith(firstSrc));
  });
});

describe("DeclutterPage wizard, overlay linking on compact rows", () => {
  test("hovering a compact row highlights its box in the one analysed-room panel", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    const row = screen.getByText("lamp").closest("li");
    await user.hover(row);
    expect(screen.getByRole("button", { name: /detection 1: lamp/i })).toHaveAttribute("aria-current", "true");
  });
});

describe("DeclutterPage wizard, carried-over checks", () => {
  test("the Declutter introduction describes the user's broader space", () => {
    render(<DeclutterPage />);
    const intro = screen.getByText(/get a suggested action for every item/i);
    expect(intro).toHaveTextContent("Get a suggested action for every item, then review and confirm each one.");
  });

  test("the stepper still starts on Upload with nothing complete", () => {
    render(<DeclutterPage />);
    const steps = trackerSteps();
    expect(steps.map((s) => s.label)).toEqual(["Upload photo", "Analyse space", "Decide items", "Confirm choices", "Results"]);
    expect(steps.find((s) => s.current).label).toBe("Upload photo");
    expect(steps.filter((s) => s.current)).toHaveLength(1);
  });
});

describe("DeclutterPage wizard, Listings step (Stage 4B)", () => {
  function makeConfirmResponseSell(runId) {
    return {
      run_id: runId,
      confirmed_decisions: [
        {
          item_id: "item_001",
          ai_decision: "keep",
          confirmed_decision: "sell",
          ai_reason: "still useful",
          user_reason: null,
          excluded: false,
          decision_changed: true,
        },
      ],
      confirmed_keep_ids: [],
      decision_changed_count: 1,
      excluded_count: 0,
    };
  }

  function makeDraft(overrides = {}) {
    return {
      item_id: "item_001",
      effective_label: "lamp",
      status: "generated",
      title: "Great lamp for sale",
      description: "A gently used lamp in great condition, perfect for any room.",
      unavailable_reason: null,
      was_repaired: false,
      attempts: 1,
      ...overrides,
    };
  }

  function makeListingsResponse(runId, confirmationResponse, drafts, provenance = {}) {
    const { modelName = "phi4-mini", promptVersion = "v1", maxAttempts = 3 } = provenance;
    return {
      run_id: runId,
      confirmation: confirmationResponse,
      drafts,
      model_name: drafts.length ? modelName : null,
      prompt_version: drafts.length ? promptVersion : null,
      max_attempts: drafts.length ? maxAttempts : null,
    };
  }

  function makeSingleListingResponse(runId, confirmationResponse, draft, provenance = {}) {
    const { modelName = "phi4-mini", promptVersion = "v1", maxAttempts = 3 } = provenance;
    return {
      run_id: runId,
      confirmation: confirmationResponse,
      draft,
      model_name: modelName,
      prompt_version: promptVersion,
      max_attempts: maxAttempts,
    };
  }

  async function toConfirmed(user, { decision = "keep", runId = "run-a" } = {}) {
    client.uploadImage.mockResolvedValueOnce(makeUploadResponse(runId));
    await user.upload(screen.getByLabelText(/space photo/i), makeFile("room.jpg"));
    await user.click(screen.getByRole("button", { name: /^analyse space$/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /^what we found$/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    if (decision !== "keep") {
      const label = decision.charAt(0).toUpperCase() + decision.slice(1);
      await user.click(screen.getByRole("radio", { name: label }));
    }
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    client.confirmDecisions.mockResolvedValueOnce(
      decision === "sell" ? makeConfirmResponseSell(runId) : makeConfirmResponse(runId)
    );
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());
  }

  test("Continue to Listings appears only after a successful confirmation", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));

    expect(screen.queryByRole("button", { name: /continue to results/i })).not.toBeInTheDocument();

    client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /continue to results/i })).toBeInTheDocument();
  });

  test("navigating to Listings alone makes no listing request", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await toConfirmed(user, { decision: "sell" });

    await user.click(screen.getByRole("button", { name: /continue to results/i }));

    expect(viewedLabel()).toBe("Results");
    expect(client.generateListings).not.toHaveBeenCalled();
  });

  test("zero confirmed Sell items shows the truthful empty state and never calls generateListings", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await toConfirmed(user, { decision: "keep" });
    await user.click(screen.getByRole("button", { name: /continue to results/i }));

    expect(screen.getByText(/did not confirm any items as sell/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate listing drafts/i })).not.toBeInTheDocument();
    expect(client.generateListings).not.toHaveBeenCalled();
  });

  test("the explicit Generate action makes exactly one batch request, then shows loading then ready", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await toConfirmed(user, { decision: "sell" });
    await user.click(screen.getByRole("button", { name: /continue to results/i }));

    let resolveListings;
    client.generateListings.mockImplementationOnce(
      () => new Promise((r) => { resolveListings = () => r(makeListingsResponse("run-a", makeConfirmResponseSell("run-a"), [makeDraft()])); })
    );
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));

    expect(client.generateListings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(/generating/i);

    resolveListings();
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());
    expect(client.generateListings).toHaveBeenCalledTimes(1); // no duplicate dispatch
  });

  test("a batch failure shows a concise error and an explicit retry that succeeds", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await toConfirmed(user, { decision: "sell" });
    await user.click(screen.getByRole("button", { name: /continue to results/i }));

    client.generateListings.mockRejectedValueOnce(new Error("Listing service unreachable"));
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/listing service unreachable/i));
    expect(screen.getByRole("alert")).toHaveTextContent(/confirmed declutter decisions are unchanged/i);

    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse("run-a", makeConfirmResponseSell("run-a"), [makeDraft()])
    );
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());
  });

  test("a generated draft is joined to the analysed image and its own item metadata by item_id", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    client.uploadImage.mockResolvedValueOnce(makeUploadResponse("run-a"));
    await user.upload(screen.getByLabelText(/space photo/i), makeFile("room.jpg"));
    await user.click(screen.getByRole("button", { name: /^analyse space$/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /^what we found$/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    // Captured while Review is the viewed step, the analysed-room <img>
    // is out of the accessibility tree (and unqueryable by role) once
    // this view is hidden behind a later step.
    const analysedSrc = screen.getByRole("img", { name: /detected item outlines/i }).getAttribute("src");
    await user.click(screen.getByRole("radio", { name: "Sell" }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponseSell("run-a"));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /continue to results/i }));

    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse("run-a", makeConfirmResponseSell("run-a"), [makeDraft()])
    );
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());

    // The card is keyed by item_001 (data-item-id, never visible text) and
    // shows a thumbnail cropped from the same analysed-room object URL
    // used on Review. Scoped to the listing card (an <article>), the
    // hidden Review view renders a thumbnail of its own that would
    // otherwise collide with this query.
    const article = screen.getByRole("article");
    expect(article).toHaveAttribute("data-item-id", "item_001");
    const card = within(article);
    expect(card.queryByText("item_001")).not.toBeInTheDocument();
    expect(card.getByRole("heading", { name: "lamp" })).toBeInTheDocument();
    expect(card.getByTestId("item-crop-thumbnail")).toHaveAttribute(
      "style",
      expect.stringContaining(analysedSrc)
    );
  });

  test("editing, regeneration and discard/restore are all connected to the real hook", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await toConfirmed(user, { decision: "sell" });
    await user.click(screen.getByRole("button", { name: /continue to results/i }));
    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse("run-a", makeConfirmResponseSell("run-a"), [makeDraft()])
    );
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());

    // Editing is verbatim and local.
    const titleInput = screen.getByLabelText(/listing title for/i);
    await user.clear(titleInput);
    await user.type(titleInput, "Edited title");
    expect(titleInput).toHaveValue("Edited title");
    expect(screen.getByText("Edited")).toBeInTheDocument();

    // Discard/restore are local, no request.
    await user.click(screen.getByRole("button", { name: /^discard$/i }));
    expect(screen.getByText("Discarded")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /restore draft/i }));
    expect(screen.getByLabelText(/listing title for/i)).toHaveValue("Edited title");

    // The restored draft is still edited, so regenerating shows the
    // inline warning first, then calls the single-item endpoint only.
    client.regenerateListing.mockResolvedValueOnce(
      makeSingleListingResponse(
        "run-a",
        makeConfirmResponseSell("run-a"),
        makeDraft({ title: "Regenerated title" })
      )
    );
    await user.click(screen.getByRole("button", { name: /^ai regenerate$/i }));
    expect(screen.getByText(/will replace your local edits/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /replace my edits and regenerate/i }));

    await waitFor(() => expect(screen.getByDisplayValue("Regenerated title")).toBeInTheDocument());
    expect(client.regenerateListing).toHaveBeenCalledTimes(1);
    expect(client.generateListings).toHaveBeenCalledTimes(1); // never a batch call
  });

  test("Back to Confirm preserves listing state; returning to Listings does not re-request", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await toConfirmed(user, { decision: "sell" });
    await user.click(screen.getByRole("button", { name: /continue to results/i }));
    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse("run-a", makeConfirmResponseSell("run-a"), [makeDraft()])
    );
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /back to confirm/i }));
    expect(viewedLabel()).toBe("Confirm choices");
    expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /continue to results/i }));
    expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument();
    expect(client.generateListings).toHaveBeenCalledTimes(1);
  });

  test("invalidating the confirmation on Review relocks Listings", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await toConfirmed(user, { decision: "sell" });
    await user.click(screen.getByRole("button", { name: /continue to results/i }));
    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse("run-a", makeConfirmResponseSell("run-a"), [makeDraft()])
    );
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /back to confirm/i }));
    await user.click(screen.getByRole("button", { name: /back to decide items/i }));
    expect(within(nav()).getByRole("button", { name: "Go to Results" })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Donate" }));

    expect(within(nav()).queryByRole("button", { name: "Go to Results" })).toBeNull();
  });

  test("no Reorganise wording or action ever appears in standalone Declutter", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await toConfirmed(user, { decision: "sell" });
    await user.click(screen.getByRole("button", { name: /continue to results/i }));
    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse("run-a", makeConfirmResponseSell("run-a"), [makeDraft()])
    );
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());

    expect(screen.queryByText(/reorganis/i)).not.toBeInTheDocument();
  });
});

describe("DeclutterPage wizard, Decide items action bar", () => {
  // Text of everything currently on screen: the non-viewed wizard views
  // are `hidden`, so they are dropped before reading.
  function visibleText() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("[hidden]").forEach((el) => el.remove());
    return clone.textContent;
  }
  const bar = () => screen.getByRole("region", { name: /decision summary and navigation/i });

  test("Decide items has exactly one Back and one Continue control, both inside the sticky bar", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    const backs = screen.getAllByRole("button", { name: /back to analyse space/i });
    const continues = screen.getAllByRole("button", { name: /continue to confirm choices/i });
    expect(backs).toHaveLength(1);
    expect(continues).toHaveLength(1);
    expect(bar()).toContainElement(backs[0]);
    expect(bar()).toContainElement(continues[0]);
    expect(bar().className).toMatch(/sticky/);
  });

  test("the bar's counts follow the current decisions live, and Back returns to Analyse space", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    expect(within(bar()).getByText("1 item")).toBeInTheDocument();
    expect(within(bar()).getByText("Keep").nextElementSibling).toHaveTextContent("1");
    expect(within(bar()).queryByText("Sell")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Sell" }));
    expect(within(bar()).getByText("Sell").nextElementSibling).toHaveTextContent("1");
    expect(within(bar()).queryByText("Keep")).not.toBeInTheDocument();
    expect(client.confirmDecisions).not.toHaveBeenCalled();

    await user.click(within(bar()).getByRole("button", { name: /back to analyse space/i }));
    expect(viewedLabel()).toBe("Analyse space");
  });

  test("an unresolved item is counted, flagged Please double check, and the disabled Continue says why", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a", { unresolved: true }));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    expect(within(bar()).getByText("2 items")).toBeInTheDocument();
    expect(screen.getByText("cable").closest("li")).toHaveTextContent("Please double check");
    expect(screen.getAllByText("Please double check")).toHaveLength(1);

    const cont = within(bar()).getByRole("button", { name: /continue to confirm choices/i });
    expect(cont).toBeDisabled();
    const reason = within(bar()).getByRole("status");
    expect(reason).toHaveTextContent("1 item still needs a decision.");
    expect(cont).toHaveAttribute("aria-describedby", reason.id);
    // Back stays available while only Continue is blocked
    expect(within(bar()).getByRole("button", { name: /back to analyse space/i })).toBeEnabled();
  });

  test("a label correction in flight is explained by the bar, then the reason clears", async () => {
    const user = userEvent.setup();
    let resolveOverride;
    client.overrideItem.mockImplementationOnce(() => new Promise((r) => { resolveOverride = r; }));
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    await user.click(screen.getAllByRole("button", { name: /wrong label/i })[0]);
    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await waitFor(() => expect(within(bar()).getByRole("status")).toHaveTextContent(/label correction is in progress/i));
    expect(within(bar()).getByRole("button", { name: /continue to confirm choices/i })).toBeDisabled();

    resolveOverride({ run_id: "run-a", analysis: makeUploadResponse("run-a").analysis, declutter: makeUploadResponse("run-a").declutter });
    await waitFor(() => expect(within(bar()).getByRole("button", { name: /continue to confirm choices/i })).toBeEnabled());
    expect(within(bar()).queryByRole("status")).not.toBeInTheDocument();
  });

  test("Decide items shows no raw item ids, confidence percentages or validity values", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a", { unresolved: true }));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));

    const text = visibleText();
    expect(text).not.toMatch(/item_001|item_009|item_id/);
    expect(text).not.toMatch(/\d+\s*%/);
    expect(text).not.toMatch(/raw_valid|still_invalid|validity/i);
  });
});

describe("DeclutterPage wizard, Confirm choices panel", () => {
  const confirmPanel = () => screen.getByRole("region", { name: /confirm your choices|choices confirmed/i });
  function visibleText() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("[hidden]").forEach((el) => el.remove());
    return clone.textContent;
  }

  test("before confirming there is one panel with live non-zero counts and the Confirm action; no summary panel", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    await user.click(screen.getAllByRole("radio", { name: "Sell" })[0]);
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));

    expect(screen.getAllByRole("region", { name: /confirm your choices|choices confirmed/i })).toHaveLength(1);
    expect(within(confirmPanel()).getByText("Sell").closest("div").querySelector("dd")).toHaveTextContent("1");
    expect(within(confirmPanel()).getByText("Changed").closest("div").querySelector("dd")).toHaveTextContent("1");
    expect(within(confirmPanel()).queryByText("Keep")).not.toBeInTheDocument();
    expect(within(confirmPanel()).queryByText("Donate")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /choices confirmed/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /continue to results/i })).not.toBeInTheDocument();
  });

  test("unresolved items on Confirm: the panel names the count and Review unresolved items returns to Decide items with no request", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i })); // Confirm now unlocked
    expect(viewedLabel()).toBe("Confirm choices");

    // Back on Decide items, a label correction comes back with a second, unresolved item.
    await user.click(within(nav()).getByRole("button", { name: "Go to Decide items" }));
    const unresolved = makeUploadResponse("run-a", { unresolved: true });
    client.overrideItem.mockResolvedValueOnce({ run_id: "run-a", analysis: unresolved.analysis, declutter: unresolved.declutter });
    await user.click(screen.getAllByRole("button", { name: /wrong label/i })[0]);
    await user.click(screen.getByRole("button", { name: /submit correction/i }));
    await waitFor(() => expect(screen.getByText("cable")).toBeInTheDocument());

    // Confirm stays reachable (already acknowledged) but blocked, and says why.
    await user.click(within(nav()).getByRole("button", { name: "Go to Confirm choices" }));
    expect(viewedLabel()).toBe("Confirm choices");
    expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeDisabled();
    expect(within(confirmPanel()).getByText("1 item still needs a decision before you can confirm.")).toBeInTheDocument();

    await user.click(within(confirmPanel()).getByRole("button", { name: "Review unresolved items" }));
    expect(viewedLabel()).toBe("Decide items");
    expect(screen.getByText("cable").closest("li")).toHaveTextContent("Please double check");
    expect(client.confirmDecisions).not.toHaveBeenCalled();
    expect(client.overrideItem).toHaveBeenCalledTimes(1);
  });

  test("after confirming, the same panel becomes Choices confirmed with confirmed counts, no ids, and Continue to Results only navigates", async () => {
    const user = userEvent.setup();
    client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponse("run-a"));
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());

    expect(screen.getAllByRole("region", { name: /confirm your choices|choices confirmed/i })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: /confirm your choices/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm decisions/i })).not.toBeInTheDocument();
    expect(within(confirmPanel()).getByRole("status")).toHaveTextContent(/1 decision confirmed/i);
    expect(within(within(confirmPanel()).getByLabelText("Confirmed choices summary")).getByRole("heading", { level: 3, name: "Keep" })).toBeInTheDocument();
    expect(within(confirmPanel()).queryByText(/locked in/i)).not.toBeInTheDocument();
    expect(within(confirmPanel()).getByText(/listing drafts for the items you confirmed as sell/i)).toBeInTheDocument();

    const text = visibleText();
    expect(text).not.toMatch(/run-a|item_001|item_id|confirmed keep items/i);

    await user.click(screen.getByRole("button", { name: /continue to results/i }));
    expect(viewedLabel()).toBe("Results");
    expect(client.generateListings).not.toHaveBeenCalled();
    expect(client.confirmDecisions).toHaveBeenCalledTimes(1);
  });

  test("the Listing drafts view opens with a Declutter complete overview of the confirmed choices, and Start over returns to Upload", async () => {
    const user = userEvent.setup();
    client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponse("run-a"));
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());

    // Not visible before the closing view is reached.
    expect(screen.queryByRole("heading", { name: /declutter complete/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /continue to results/i }));
    expect(viewedLabel()).toBe("Results");
    const complete = screen.getByRole("region", { name: /declutter complete/i });
    expect(within(complete).getByText(/your decisions are confirmed\. here's your final summary\./i)).toBeInTheDocument();
    // Four count cards, always present, from the confirmation.
    const counts = within(complete).getByLabelText("Confirmed decision counts");
    expect(within(counts).getAllByRole("term").map((dt) => dt.textContent)).toEqual(["Keep", "Sell", "Donate", "Discard"]);
    expect(within(counts).getAllByRole("definition").map((dd) => dd.textContent)).toEqual(["1", "0", "0", "0"]);
    // Items are collapsed behind one control; expanding shows the chips.
    expect(within(complete).getByText(/your confirmed items/i)).toHaveTextContent("(1)");
    const view = within(complete).getByRole("button", { name: "View items" });
    expect(view).toHaveAttribute("aria-expanded", "false");
    expect(within(complete).queryByLabelText("Confirmed items")).not.toBeInTheDocument();
    await user.click(view);
    expect(within(complete).getByRole("button", { name: "Hide items" })).toHaveAttribute("aria-expanded", "true");
    const summary = within(complete).getByLabelText("Confirmed items");
    expect(within(summary).getByRole("heading", { level: 3, name: "Keep" })).toBeInTheDocument();
    expect(within(summary).getAllByRole("listitem")).toHaveLength(1);
    expect(within(summary).queryByRole("button", { name: /^Edit .* decisions$/ })).not.toBeInTheDocument();
    expect(within(complete).getByRole("button", { name: "Copy summary" })).toBeInTheDocument();
    expect(visibleText()).not.toMatch(/run-a|item_001|item_id/i);
    // The marketplace section still follows the overview.
    expect(screen.getByRole("region", { name: /marketplace listing/i })).toBeInTheDocument();
    expect(client.generateListings).not.toHaveBeenCalled();

    // Edit decisions returns to Decide items showing every item.
    await user.click(within(complete).getByRole("button", { name: "Edit decisions" }));
    expect(viewedLabel()).toBe("Decide items");
    expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    await user.click(screen.getByRole("button", { name: /continue to results/i }));
    expect(viewedLabel()).toBe("Results");

    await user.click(screen.getByRole("button", { name: /start over/i }));
    expect(viewedLabel()).toBe("Upload photo");
    expect(screen.queryByRole("heading", { name: /declutter complete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /choices confirmed/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/space photo/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue to decide items/i })).not.toBeInTheDocument();
  });

  test("a category Edit link on Confirm choices returns to Decide items with that filter applied", async () => {
    const user = userEvent.setup();
    client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponse("run-a"));
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());

    await user.click(within(confirmPanel()).getByRole("button", { name: "Edit Keep decisions" }));
    expect(viewedLabel()).toBe("Decide items");
    expect(screen.getByRole("button", { name: /^Keep/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "false");
    // Navigating alone changes nothing: the confirmation is still current.
    expect(client.confirmDecisions).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument();
  });

  test("a confirmation failure stays inline in the same panel and keeps the decisions; retry succeeds", async () => {
    const user = userEvent.setup();
    client.confirmDecisions.mockRejectedValueOnce(new Error("Decision confirmation failed"));
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
    await user.click(screen.getAllByRole("radio", { name: "Donate" })[0]);
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));

    const alert = await screen.findByRole("alert");
    expect(confirmPanel()).toContainElement(alert);
    expect(alert).toHaveTextContent(/decisions and exclusions are unchanged/i);
    expect(screen.getByRole("heading", { name: /confirm your choices/i })).toBeInTheDocument();
    expect(within(confirmPanel()).getByText("Donate").closest("div").querySelector("dd")).toHaveTextContent("1");

    client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// Analyse space screen (shared redesign phase)
// ---------------------------------------------------------------------

describe("DeclutterPage Analyse space screen", () => {
  const analyseHeading = (name) => screen.getByRole("heading", { level: 2, name });
  const whatWeFound = () => screen.getByRole("heading", { level: 2, name: "What we found" });
  const visibleH2s = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent.trim());
  const JARGON = /scene classification|object detection|item reasoning|candidate|confidence|\d+%|analysis time|this computer|\broom\b/i;

  async function submitPhoto(user) {
    await user.upload(screen.getByLabelText(/space photo/i), makeFile("room.jpg"));
    await user.type(screen.getByLabelText(/context for the ai/i), "keep it minimal");
    await user.click(screen.getByRole("button", { name: /^analyse space$/i }));
  }

  test("analysing: one heading, one calm status with a spinner and no pipeline jargon, everything locked", async () => {
    const user = userEvent.setup();
    let resolveUpload;
    client.uploadImage.mockImplementationOnce(() => new Promise((r) => { resolveUpload = () => r(makeUploadResponse("run-a")); }));
    render(<DeclutterPage />);
    await submitPhoto(user);

    await waitFor(() => expect(viewedLabel()).toBe("Analyse space"));
    expect(analyseHeading("Analysing your space")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).filter((h) => h.closest("[hidden]") === null)).toHaveLength(1);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Finding items and preparing your next step. This may take up to two minutes.");
    expect(status.querySelector("svg")).not.toBeNull();
    expect(status.textContent).not.toMatch(JARGON);
    expect(screen.queryByRole("heading", { name: /what we found/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back to upload photo/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /continue to decide items/i })).toBeDisabled();
    expect(within(nav()).queryAllByRole("button")).toHaveLength(0);
    expect(client.uploadImage).toHaveBeenCalledTimes(1);
    resolveUpload();
    await waitFor(() => expect(whatWeFound()).toBeInTheDocument());
  });

  test("error: Analysis unsuccessful with one alert that points back to the preserved photo and context; no auto retry", async () => {
    const user = userEvent.setup();
    client.uploadImage.mockRejectedValueOnce(new Error("The analysis service is unavailable."));
    render(<DeclutterPage />);
    await submitPhoto(user);

    await waitFor(() => expect(analyseHeading("Analysis unsuccessful")).toBeInTheDocument());
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(/the analysis service is unavailable/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/your selected photo and context are still on upload photo/i);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /what we found/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to decide items/i })).toBeDisabled();
    expect(client.uploadImage).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /back to upload photo/i }));
    expect(viewedLabel()).toBe("Upload photo");
    expect(screen.getByText("room.jpg")).toBeInTheDocument();
    expect(screen.getByLabelText(/context for the ai/i)).toHaveValue("keep it minimal");
    expect(screen.getByRole("button", { name: /^analyse space$/i })).toBeEnabled();
    expect(client.uploadImage).toHaveBeenCalledTimes(1);
  });

  test("success: What we found is the single visible h2, with no second heading or banner, and user-facing stats", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));

    // the success state carries no page heading or banner of its own: the tracker's
    // live status line says it once, and What we found is the only visible h2
    expect(screen.queryByRole("heading", { name: /analysis complete/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/your space has been analysed/i)).not.toBeInTheDocument();
    expect(visibleH2s()).toEqual(["What we found"]);
    expect(whatWeFound().closest("section").parentElement.querySelector('[role="status"]')).toBeNull();
    expect(whatWeFound().closest("section").parentElement.querySelector(".bg-success\\/10")).toBeNull();
    expect(within(nav()).getByText("Analysis complete.")).toBeInTheDocument();
    expect(within(nav()).getByText("Continue to Decide items to check each item.")).toBeInTheDocument();
    expect(within(nav()).getByText("Analysis complete.").closest("[aria-live]")).not.toBeNull();
    const summary = screen.getByRole("region", { name: "What we found" });
    expect(within(summary).getByRole("heading", { level: 2, name: "What we found" })).toBeInTheDocument();
    const dts = Array.from(summary.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(dts).toEqual(["Space type", "Items found", "Ready to review"]);
    const dds = Array.from(summary.querySelectorAll("dd")).map((dd) => dd.textContent);
    expect(dds).toEqual(["bedroom", "1", "1"]);
    expect(summary.textContent).not.toMatch(JARGON);
    expect(screen.queryByText(/extra review/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // the whole Analyse screen avoids "room" as a standalone user-facing word
    expect(whatWeFound().closest("section").parentElement.textContent).not.toMatch(/\broom\b/i);
    expect(screen.getByRole("button", { name: /back to upload photo/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /continue to decide items/i })).toBeEnabled();
    expect(viewedLabel()).toBe("Analyse space");
  });

  test("a warning in the analysis shows one calm sentence, never the code", async () => {
    const user = userEvent.setup();
    const response = makeUploadResponse("run-a");
    response.analysis.warnings = [{ code: "low_confidence_scene", message: "internal detail" }];
    render(<DeclutterPage />);
    await analyseFrom(user, response);
    expect(screen.getByText("Some results may need extra review.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What we found" }).textContent).not.toMatch(/low_confidence_scene|internal detail/);
  });

  test("Back to Upload photo and forward again keeps the results without a second request", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));

    await user.click(screen.getByRole("button", { name: /back to upload photo/i }));
    expect(viewedLabel()).toBe("Upload photo");
    expect(screen.getByText("room.jpg")).toBeInTheDocument();
    expect(screen.getByText(/replace photo/i)).toBeInTheDocument();

    await user.click(within(nav()).getByRole("button", { name: /go to analyse space/i }));
    expect(viewedLabel()).toBe("Analyse space");
    expect(whatWeFound()).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /analysis complete/i })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What we found" })).toBeInTheDocument();
    expect(client.uploadImage).toHaveBeenCalledTimes(1);
  });
});
