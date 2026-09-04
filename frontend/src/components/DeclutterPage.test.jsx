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
  await user.upload(screen.getByLabelText(/room photo/i), makeFile("room.jpg"));
  await user.click(screen.getByRole("button", { name: /analyse room/i }));
  await waitFor(() => expect(screen.getByRole("heading", { name: /2\. analysis summary/i })).toBeInTheDocument());
}

// ---------------------------------------------------------------------

describe("DeclutterPage wizard, one view at a time", () => {
  test("Upload is the initial view; Analyse/Review/Confirm content is not shown", () => {
    render(<DeclutterPage />);
    expect(viewedLabel()).toBe("Upload");
    expect(screen.getByRole("heading", { name: /1\. upload a room photo/i })).toBeInTheDocument();
    expect(screen.getByText(/get ai-suggested keep \/ sell \/ donate \/ discard decisions/i)).toBeInTheDocument();

    expect(screen.queryByRole("heading", { name: /analysing your room/i })).not.toBeInTheDocument();
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

    await user.upload(screen.getByLabelText(/room photo/i), makeFile("room.jpg"));
    await user.click(screen.getByRole("button", { name: /analyse room/i }));

    expect(client.uploadImage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(viewedLabel()).toBe("Analyse"));
    expect(screen.getByRole("status")).toHaveTextContent(/object detection and item reasoning are running/i);
    // Upload form is no longer visible
    expect(screen.queryByRole("button", { name: /analyse room/i })).not.toBeInTheDocument();

    resolveUpload();
    await waitFor(() => expect(screen.getByRole("heading", { name: /2\. analysis summary/i })).toBeInTheDocument());
  });

  test("Analyse success does not auto-skip its completed view", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));

    expect(viewedLabel()).toBe("Analyse");
    expect(screen.getByRole("heading", { name: /2\. analysis summary/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to review/i })).toBeEnabled();
    // Review content still hidden until the user continues
    expect(screen.queryByRole("img", { name: /detected item outlines/i })).not.toBeInTheDocument();
  });

  test("Continue moves Analyse → Review; Continue there unlocks + opens Confirm", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));

    await user.click(screen.getByRole("button", { name: /continue to review/i }));
    expect(viewedLabel()).toBe("Review");
    expect(screen.getByRole("heading", { name: /review your declutter decisions/i })).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(1); // one full-size analysed-room image

    // Confirm is still locked in the tracker until acknowledged
    expect(trackerSteps().find((s) => s.label === "Confirm").button).toBeNull();

    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(viewedLabel()).toBe("Confirm");
    expect(screen.getByRole("heading", { name: /4\. confirm decisions/i })).toBeInTheDocument();
    // Confirm is now a navigable tracker step
    const trackerConfirm = within(nav()).queryAllByRole("button", { name: "Go to Confirm" });
    expect(trackerConfirm.length).toBe(0); // it is the current step, so not a button
    expect(within(nav()).getByRole("button", { name: "Go to Review" })).toBeInTheDocument();
  });
});

describe("DeclutterPage wizard, Review → Confirm gating", () => {
  test("Continue to Confirm is blocked while an expected item is unresolved", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a", { unresolved: true }));
    await user.click(screen.getByRole("button", { name: /continue to review/i }));

    expect(screen.getByRole("button", { name: /continue to confirm/i })).toBeDisabled();
    expect(screen.getByText(/no valid ai decision was produced for this item/i)).toBeInTheDocument();
    // tracker never unlocked Confirm
    expect(trackerSteps().find((s) => s.label === "Confirm").button).toBeNull();
  });

  test("Continue to Confirm is blocked while a label correction is in flight", async () => {
    const user = userEvent.setup();
    let resolveOverride;
    client.overrideItem.mockImplementationOnce(() => new Promise((r) => { resolveOverride = r; }));
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to review/i }));

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
    await user.click(screen.getByRole("button", { name: /continue to review/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));

    expect(client.confirmDecisions).not.toHaveBeenCalled();
  });

  test("only the Confirm decisions button triggers /confirm, then the summary appears", async () => {
    const user = userEvent.setup();
    client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponse("run-a"));
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to review/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));

    expect(client.confirmDecisions).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    expect(client.confirmDecisions).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("heading", { name: /decisions confirmed/i })).toBeInTheDocument());
  });
});

describe("DeclutterPage wizard, tracker navigation", () => {
  test("completed tracker steps navigate backward without any API call", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to review/i }));
    expect(viewedLabel()).toBe("Review");

    client.uploadImage.mockClear();
    await user.click(within(nav()).getByRole("button", { name: "Go to Analyse" }));
    expect(viewedLabel()).toBe("Analyse");
    await user.click(within(nav()).getByRole("button", { name: "Go to Upload" }));
    expect(viewedLabel()).toBe("Upload");

    expect(client.uploadImage).not.toHaveBeenCalled();
    expect(client.confirmDecisions).not.toHaveBeenCalled();
  });

  test("locked future steps are not activatable", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    // Before any upload: only Upload is unlocked.
    expect(within(nav()).queryByRole("button", { name: "Go to Analyse" })).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Go to Review" })).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Go to Confirm" })).toBeNull();

    await analyseFrom(user, makeUploadResponse("run-a"));
    // Review is unlocked (analysis succeeded); Confirm is still locked.
    expect(within(nav()).getByRole("button", { name: "Go to Upload" })).toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: "Go to Review" })).toBeInTheDocument();
    expect(within(nav()).queryByRole("button", { name: "Go to Confirm" })).toBeNull();
  });

  test("navigation is not offered while the analysis request is in flight", async () => {
    const user = userEvent.setup();
    let resolveUpload;
    client.uploadImage.mockImplementationOnce(
      () => new Promise((r) => { resolveUpload = () => r(makeUploadResponse("run-a")); })
    );
    render(<DeclutterPage />);
    await user.upload(screen.getByLabelText(/room photo/i), makeFile("room.jpg"));
    await user.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(viewedLabel()).toBe("Analyse"));

    // No tracker buttons at all while uploading; Back is disabled.
    expect(within(nav()).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /back to upload/i })).toBeDisabled();

    resolveUpload();
    await waitFor(() => expect(within(nav()).getByRole("button", { name: "Go to Upload" })).toBeInTheDocument());
  });

  test("Back/Continue controls track availability with the tracker", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));

    // On Analyse: Back to Upload enabled, Continue to Review enabled.
    expect(screen.getByRole("button", { name: /back to upload/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /continue to review/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /continue to review/i }));
    expect(screen.getByRole("button", { name: /back to analyse/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /continue to confirm/i })).toBeEnabled();
  });
});

describe("DeclutterPage wizard, state preservation", () => {
  test("review decisions and exclusions survive Review → Confirm → Review", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to review/i }));

    // change the item to Sell and mark it excluded
    await user.click(screen.getByRole("radio", { name: "Sell" }));
    await user.click(screen.getByRole("checkbox", { name: /exclude this item/i }));
    expect(screen.getByRole("radio", { name: "Sell" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(viewedLabel()).toBe("Confirm");
    await user.click(within(nav()).getByRole("button", { name: "Go to Review" }));
    expect(viewedLabel()).toBe("Review");

    // Still Sell, still excluded.
    expect(screen.getByRole("radio", { name: "Sell" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /exclude this item/i })).toBeChecked();
  });

  test("a confirmed result survives navigation until the user edits a decision", async () => {
    const user = userEvent.setup();
    client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponse("run-a"));
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to review/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /decisions confirmed/i })).toBeInTheDocument());

    // Navigate away and back, the confirmed summary is still there.
    await user.click(within(nav()).getByRole("button", { name: "Go to Review" }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(screen.getByRole("heading", { name: /decisions confirmed/i })).toBeInTheDocument();

    // Now edit a decision on Review, the hook invalidates the confirmation.
    await user.click(within(nav()).getByRole("button", { name: "Go to Review" }));
    await user.click(screen.getAllByRole("radio", { name: "Donate" })[0]);
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(screen.queryByRole("heading", { name: /decisions confirmed/i })).not.toBeInTheDocument();
  });

  test("a new upload relocks stale downstream steps and starts a fresh Analyse view", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to review/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    // Confirm is now unlocked (viewing it); step back so it shows as a button.
    await user.click(within(nav()).getByRole("button", { name: "Go to Review" }));
    expect(within(nav()).getByRole("button", { name: "Go to Confirm" })).toBeInTheDocument();

    // Back to Upload, submit a new photo, hold the request in flight.
    await user.click(within(nav()).getByRole("button", { name: "Go to Upload" }));
    let resolveUpload;
    client.uploadImage.mockImplementationOnce(
      () => new Promise((r) => { resolveUpload = () => r(makeUploadResponse("run-b")); })
    );
    await user.upload(screen.getByLabelText(/room photo/i), makeFile("room-b.jpg"));
    await user.click(screen.getByRole("button", { name: /analyse room/i }));

    // Straight to a fresh Analyse view; every downstream step relocked.
    await waitFor(() => expect(viewedLabel()).toBe("Analyse"));
    expect(within(nav()).queryAllByRole("button")).toHaveLength(0); // locked while uploading
    expect(screen.queryByRole("heading", { name: /2\. analysis summary/i })).not.toBeInTheDocument();

    resolveUpload();
    // The new analysis re-unlocks Review, but Confirm stays locked until
    // the user acknowledges the new review.
    await waitFor(() => expect(within(nav()).getByRole("button", { name: "Go to Review" })).toBeInTheDocument());
    expect(within(nav()).queryByRole("button", { name: "Go to Confirm" })).toBeNull();
    expect(client.uploadImage).toHaveBeenCalledTimes(2);
  });

  test("returning to Upload via the tracker does not reset the current run", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to review/i }));

    await user.click(within(nav()).getByRole("button", { name: "Go to Upload" }));
    // still analysed, Review is still reachable, nothing was re-uploaded
    expect(within(nav()).getByRole("button", { name: "Go to Review" })).toBeInTheDocument();
    await user.click(within(nav()).getByRole("button", { name: "Go to Review" }));
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
    await user.click(screen.getByRole("button", { name: /continue to review/i }));

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
    await user.click(screen.getByRole("button", { name: /continue to review/i }));

    await user.click(chip("Discard"));
    expect(chip("Discard")).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(viewedLabel()).toBe("Confirm");
    await user.click(within(nav()).getByRole("button", { name: "Go to Review" }));
    expect(viewedLabel()).toBe("Review");

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
    await user.click(screen.getByRole("button", { name: /continue to review/i }));

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
    await user.upload(screen.getByLabelText(/room photo/i), makeFile("room.jpg"));
    await user.click(screen.getByRole("button", { name: /analyse room/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Analysing your room" })).toBeInTheDocument());

    resolveUpload(makeUploadResponse("run-a"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Analysis complete" })).toBeInTheDocument());
    expect(screen.queryByText(/keeps going even if you leave/i)).not.toBeInTheDocument();

    // second run fails
    client.uploadImage.mockImplementationOnce(() => Promise.reject(new Error("network down")));
    await user.click(within(nav()).getByRole("button", { name: "Go to Upload" }));
    await user.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Analysis unsuccessful" })).toBeInTheDocument());
    rejectUpload?.(new Error("ignored"));
  });
});

describe("DeclutterPage wizard, analysed image lifecycle", () => {
  test("the Review image is the analysed photo; a re-analysis replaces it and revokes the old object URL", async () => {
    const user = userEvent.setup();
    render(<DeclutterPage />);
    await analyseFrom(user, makeUploadResponse("run-a"));
    await user.click(screen.getByRole("button", { name: /continue to review/i }));
    const firstSrc = screen.getByRole("img", { name: /detected item outlines/i }).getAttribute("src");
    expect(firstSrc).toBeTruthy();

    await user.click(within(nav()).getByRole("button", { name: "Go to Upload" }));
    await analyseFrom(user, makeUploadResponse("run-b"));
    await user.click(screen.getByRole("button", { name: /continue to review/i }));

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
    await user.click(screen.getByRole("button", { name: /continue to review/i }));

    const row = screen.getByText("lamp").closest("li");
    await user.hover(row);
    expect(screen.getByRole("button", { name: /detection 1: lamp/i })).toHaveAttribute("aria-current", "true");
  });
});

describe("DeclutterPage wizard, carried-over checks", () => {
  test("the moved Declutter introduction still renders, wording unchanged", () => {
    render(<DeclutterPage />);
    const intro = screen.getByText(/get ai-suggested keep \/ sell \/ donate \/ discard decisions/i);
    expect(intro).toHaveTextContent(
      "Get AI-suggested Keep / Sell / Donate / Discard decisions for what's in a room, then review and confirm each one yourself before anything is finalised."
    );
  });

  test("the stepper still starts on Upload with nothing complete", () => {
    render(<DeclutterPage />);
    const steps = trackerSteps();
    expect(steps.map((s) => s.label)).toEqual(["Upload", "Analyse", "Review", "Confirm"]);
    expect(steps.find((s) => s.current).label).toBe("Upload");
    expect(steps.filter((s) => s.current)).toHaveLength(1);
  });
});
