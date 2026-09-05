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
  const items = decisions.map((d, i) => makeItem({ item_id: d.itemId, source_detection_index: i }));
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
      expected_item_ids: decisions.map((d) => d.itemId),
      ai_decisions: decisions.map((d) => ({ item_id: d.itemId, decision: d.decision, reason: `reason for ${d.itemId}` })),
      unresolved_item_ids: [],
      item_validity: Object.fromEntries(decisions.map((d) => [d.itemId, "raw_valid"])),
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
  const confirmed_decisions = confirmed.map((d) => ({
    item_id: d.itemId,
    ai_decision: d.aiDecision,
    confirmed_decision: d.confirmedDecision,
    ai_reason: `reason for ${d.itemId}`,
    user_reason: null,
    excluded: false,
    decision_changed: d.aiDecision !== d.confirmedDecision,
  }));
  const confirmed_keep_ids = confirmed_decisions.filter((d) => d.confirmed_decision === "keep").map((d) => d.item_id);
  return {
    run_id: "run1",
    confirmed_decisions,
    confirmed_keep_ids,
    decision_changed_count: confirmed_decisions.filter((d) => d.decision_changed).length,
    excluded_count: 0,
  };
}

function makeConfirmedGenerateResponse(confirmed, { imageStatus = "generated", unavailableReason = null } = {}) {
  const confirmation = makeConfirmResponse(confirmed);
  return {
    run_id: "run1",
    confirmation,
    planning: {
      run_id: "run1",
      plan: {
        zones: [{ zone_name: "Keep in place", item_ids: confirmation.confirmed_keep_ids, instruction: "keep as is" }],
        image_prompt: "a tidy bedroom",
        negative_prompt: null,
      },
      provenance: "raw_valid",
      issues: [],
      attempts: 1,
      model_name: "phi4-mini",
      prompt_version: "v1",
      stage_timings: [{ stage: "reorganise_plan", duration_ms: 5 }],
    },
    image_status: imageStatus,
    image:
      imageStatus === "generated"
        ? {
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
            generation_ms: 100,
            prompt_sha256: "b".repeat(64),
            input_image_sha256: HASH,
          }
        : null,
    image_unavailable_reason: imageStatus === "generated" ? null : unavailableReason,
  };
}

describe("BothPage, health ownership", () => {
  test("mounting the page issues exactly one health request", async () => {
    render(<BothPage />);
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalledTimes(1));
  });

  test("an unavailable health status is shown via the banner but never blocks anything", async () => {
    client.getImageGenHealth.mockResolvedValue({ available: false });
    render(<BothPage />);
    await waitFor(() => expect(screen.getByText(/visual preview is currently unavailable/i)).toBeInTheDocument());
  });
});

describe("BothPage, end-to-end: upload -> review -> confirm -> continue -> result", () => {
  test("no second item-selection screen, DeclutterReview alone drives what's kept", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    render(<BothPage />);

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());
    // The Reorganise-only item-selector (ReorganiseItemSelector, a
    // SEPARATE selection screen) never renders here at all, Both
    // answers "what to keep" entirely through Declutter's own review.
    expect(screen.queryByText(/choose what to keep/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate room plan/i })).not.toBeInTheDocument();
  });

  test("Continue only appears after explicit confirmation, never auto-generates", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    render(<BothPage />);

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /continue to reorganisation/i })).not.toBeInTheDocument();
    expect(client.generateConfirmedReorganisation).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /confirm decisions/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /continue to reorganisation/i })).toBeInTheDocument());
    expect(client.generateConfirmedReorganisation).not.toHaveBeenCalled(); // confirming alone never triggers generation
  });

  test("full flow: upload -> confirm -> continue -> generated result", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    client.generateConfirmedReorganisation.mockResolvedValue(
      makeConfirmedGenerateResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    render(<BothPage />);

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /continue to reorganisation/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /continue to reorganisation/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: /your room plan/i })).toBeInTheDocument());
    expect(screen.getByText("Keep in place")).toBeInTheDocument();
    // Upload/review screen is gone, Result is the terminal screen.
    expect(screen.queryByLabelText(/room photo/i)).not.toBeInTheDocument();
  });

  test("an unavailable image result is shown as a successful plan result, not an error", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    client.generateConfirmedReorganisation.mockResolvedValue(
      makeConfirmedGenerateResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }], {
        imageStatus: "unavailable",
        unavailableReason: "service_unreachable",
      })
    );
    render(<BothPage />);

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /continue to reorganisation/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /continue to reorganisation/i }));

    await waitFor(() => expect(screen.getByText(/visual preview unavailable/i)).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: /your room plan/i })).toBeInTheDocument(); // plan still shown
  });

  test("empty confirmed Keep shows a message and never calls /generate/confirmed", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse({ decisions: [{ itemId: "item_001", decision: "sell" }] }));
    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse([{ itemId: "item_001", aiDecision: "sell", confirmedDecision: "sell" }])
    );
    render(<BothPage />);

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /confirm decisions/i }));

    await waitFor(() => expect(screen.getByText(/nothing to reorganise/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /continue to reorganisation/i })).not.toBeInTheDocument();
    expect(client.generateConfirmedReorganisation).not.toHaveBeenCalled();
  });

  test("a generation failure preserves the confirmed review and offers a retry", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    client.generateConfirmedReorganisation.mockRejectedValueOnce(new Error("service unreachable"));
    render(<BothPage />);

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /continue to reorganisation/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /continue to reorganisation/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/service unreachable/i));
    expect(screen.getByRole("button", { name: /retry reorganisation/i })).toBeInTheDocument();
    // Confirmation/review are still visible, nothing was thrown away.
    expect(screen.getByText(/decisions confirmed/i)).toBeInTheDocument();

    client.generateConfirmedReorganisation.mockResolvedValueOnce(
      makeConfirmedGenerateResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    await userEvent.click(screen.getByRole("button", { name: /retry reorganisation/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /your room plan/i })).toBeInTheDocument());
    expect(client.uploadImage).toHaveBeenCalledTimes(1); // no re-upload
    expect(client.confirmDecisions).toHaveBeenCalledTimes(1); // no re-confirmation
  });

  test("Start over resets the entire Both workflow", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    client.generateConfirmedReorganisation.mockResolvedValue(
      makeConfirmedGenerateResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    render(<BothPage />);

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /continue to reorganisation/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /continue to reorganisation/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /your room plan/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /start over/i }));

    expect(screen.getByLabelText(/room photo/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /your room plan/i })).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalled(); // the retained file's object URL is released
  });

  // The "Back to workflows" control moved to AppShell; App.test.jsx covers
  // that returning from Both unmounts the workflow.
});

describe("BothPage, workflow progress stepper", () => {
  function stepper() {
    return screen.getByRole("navigation", { name: /both workflow progress/i });
  }
  function currentStep() {
    return within(stepper())
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("aria-current") === "step")
      ?.textContent.replace(/\d+/g, "")
      .trim();
  }
  function circle(index) {
    return within(stepper()).getAllByRole("listitem")[index].querySelector(".rounded-full");
  }

  test("maps upload, analysis, review, confirmation and generation across the five steps", async () => {
    let resolveUpload;
    let resolveConfirm;
    let resolveGenerate;
    client.uploadImage.mockImplementationOnce(
      () => new Promise((r) => { resolveUpload = () => r(makeBothUploadResponse()); })
    );
    client.confirmDecisions.mockImplementationOnce(
      () => new Promise((r) => { resolveConfirm = () => r(makeConfirmResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])); })
    );
    client.generateConfirmedReorganisation.mockImplementationOnce(
      () => new Promise((r) => { resolveGenerate = () => r(makeConfirmedGenerateResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])); })
    );
    render(<BothPage />);

    expect(within(stepper()).getAllByRole("listitem").map((li) => li.textContent.replace(/\d+/g, "").trim())).toEqual([
      "Upload",
      "Analyse",
      "Review",
      "Confirm",
      "Reorganise",
    ]);
    expect(currentStep()).toBe("Upload");

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(currentStep()).toBe("Analyse"));

    resolveUpload();
    await waitFor(() => expect(currentStep()).toBe("Review"));

    await userEvent.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(currentStep()).toBe("Confirm"));

    resolveConfirm();
    await waitFor(() => expect(currentStep()).toBe("Reorganise"));

    await userEvent.click(screen.getByRole("button", { name: /continue to reorganisation/i }));
    await waitFor(() => expect(within(stepper()).getByText(/planning the room/i)).toBeInTheDocument());

    resolveGenerate();
    await waitFor(() =>
      expect(within(stepper()).getAllByRole("listitem").every((li) => li.getAttribute("aria-current") !== "step")).toBe(true)
    );
    expect(circle(4).className).toMatch(/border-success/); // Reorganise completed
  });

  test("confirmation with zero confirmed Keep items keeps the stepper on Confirm", async () => {
    client.uploadImage.mockResolvedValue(
      makeBothUploadResponse({ decisions: [{ itemId: "item_001", decision: "sell" }] })
    );
    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse([{ itemId: "item_001", aiDecision: "sell", confirmedDecision: "sell" }])
    );
    render(<BothPage />);

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /confirm decisions/i }));

    await waitFor(() => expect(within(stepper()).getByText(/nothing is set to keep/i)).toBeInTheDocument());
    expect(currentStep()).toBe("Confirm");
    // Reorganise is neither active nor complete
    expect(circle(4).className).toMatch(/border-border/);
    expect(circle(4).className).not.toMatch(/border-success|border-primary/);
    expect(within(stepper()).getByText(/at least one item to keep/i)).toBeInTheDocument();
  });

  test("a generation failure keeps the stepper on Reorganise with retry guidance", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    client.generateConfirmedReorganisation.mockRejectedValueOnce(new Error("service unreachable"));
    render(<BothPage />);

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /continue to reorganisation/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /continue to reorganisation/i }));

    await waitFor(() => expect(within(stepper()).getByText(/didn't finish/i)).toBeInTheDocument());
    expect(currentStep()).toBe("Reorganise");
    expect(circle(4).className).not.toMatch(/border-success/); // retryable, not complete
    expect(within(stepper()).getByText(/retry/i)).toBeInTheDocument();
  });

  test("a successful unavailable-preview result still completes the Reorganise step", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    client.generateConfirmedReorganisation.mockResolvedValue(
      makeConfirmedGenerateResponse([{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }], {
        imageStatus: "unavailable",
        unavailableReason: "service_unreachable",
      })
    );
    render(<BothPage />);

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /continue to reorganisation/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /continue to reorganisation/i }));

    await waitFor(() =>
      expect(within(stepper()).getByText(/your reorganisation is complete/i)).toBeInTheDocument()
    );
    expect(circle(4).className).toMatch(/border-success/);
    expect(within(stepper()).getAllByRole("listitem").every((li) => li.getAttribute("aria-current") !== "step")).toBe(true);
  });
});

describe("BothPage, Listings as an independent parallel action (Stage 4B)", () => {
  function makeDraft(itemId, overrides = {}) {
    return {
      item_id: itemId,
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

  function makeListingsResponse(confirmationResponse, drafts) {
    return {
      run_id: "run1",
      confirmation: confirmationResponse,
      drafts,
      model_name: drafts.length ? "phi4-mini" : null,
      prompt_version: drafts.length ? "v1" : null,
      max_attempts: drafts.length ? 3 : null,
    };
  }

  function makeSingleListingResponse(confirmationResponse, draft) {
    return { run_id: "run1", confirmation: confirmationResponse, draft, model_name: "phi4-mini", prompt_version: "v1", max_attempts: 3 };
  }

  // No radio clicks are needed anywhere below: confirmDecisions is fully
  // mocked, so the confirmed shape is whatever this helper's `confirmed`
  // argument says, independent of the review UI's own state.
  async function toConfirmed(user, { decisions, confirmed }) {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse({ decisions }));
    await user.upload(screen.getByLabelText(/room photo/i), makeFile());
    await user.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());
    client.confirmDecisions.mockResolvedValueOnce(makeConfirmResponse(confirmed));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    // getByText(/decisions confirmed/i) is ambiguous with 2+ confirmed
    // items: the summary's own status line reads "…2 decisions
    // confirmed." (plural), which also matches the loose text pattern
    // alongside the "Decisions confirmed" heading. The heading role is
    // unambiguous regardless of item count.
    await waitFor(() => expect(screen.getByRole("heading", { name: /decisions confirmed/i })).toBeInTheDocument());
  }

  const KEEP_AND_SELL = {
    decisions: [
      { itemId: "item_001", decision: "keep" },
      { itemId: "item_002", decision: "sell" },
    ],
    confirmed: [
      { itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" },
      { itemId: "item_002", aiDecision: "sell", confirmedDecision: "sell" },
    ],
  };

  test("no listing generation before confirmation", async () => {
    const user = userEvent.setup();
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    render(<BothPage />);

    await user.upload(screen.getByLabelText(/room photo/i), makeFile());
    await user.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /generate listing drafts/i })).not.toBeInTheDocument();
    expect(client.generateListings).not.toHaveBeenCalled();
  });

  test("no automatic generation after confirmation", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await toConfirmed(user, KEEP_AND_SELL);

    expect(screen.getByRole("button", { name: /generate listing drafts/i })).toBeInTheDocument();
    expect(client.generateListings).not.toHaveBeenCalled();
  });

  test("Keep + Sell shows both independent next-action capabilities", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await toConfirmed(user, KEEP_AND_SELL);

    expect(screen.getByRole("button", { name: /continue to reorganisation/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate listing drafts/i })).toBeInTheDocument();
  });

  test("zero confirmed Keep with confirmed Sell still allows Listings", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await toConfirmed(user, {
      decisions: [{ itemId: "item_001", decision: "sell" }],
      confirmed: [{ itemId: "item_001", aiDecision: "sell", confirmedDecision: "sell" }],
    });

    expect(screen.getByText(/nothing to reorganise/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue to reorganisation/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate listing drafts/i })).toBeInTheDocument();
  });

  test("confirmed Keep with zero confirmed Sell still allows Reorganise", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await toConfirmed(user, {
      decisions: [{ itemId: "item_001", decision: "keep" }],
      confirmed: [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }],
    });

    expect(screen.getByRole("button", { name: /continue to reorganisation/i })).toBeInTheDocument();
    expect(screen.getByText(/did not confirm any items as sell/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate listing drafts/i })).not.toBeInTheDocument();
  });

  test("zero confirmed Keep and zero confirmed Sell shows both truthful empty states", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await toConfirmed(user, {
      decisions: [{ itemId: "item_001", decision: "donate" }],
      confirmed: [{ itemId: "item_001", aiDecision: "donate", confirmedDecision: "donate" }],
    });

    expect(screen.getByText(/nothing to reorganise/i)).toBeInTheDocument();
    expect(screen.getByText(/did not confirm any items as sell/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue to reorganisation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate listing drafts/i })).not.toBeInTheDocument();
  });

  test("either action may start first, and both may be in flight concurrently, each disabled only by its own operation", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await toConfirmed(user, KEEP_AND_SELL);

    let resolveListings;
    client.generateListings.mockImplementationOnce(
      () => new Promise((r) => { resolveListings = () => r(makeListingsResponse(makeConfirmResponse(KEEP_AND_SELL.confirmed), [makeDraft("item_002")])); })
    );
    // Listings started FIRST.
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    expect(client.generateListings).toHaveBeenCalledTimes(1);

    // Reorganise is not disabled by the listing generation in flight.
    expect(screen.getByRole("button", { name: /continue to reorganisation/i })).toBeEnabled();

    let resolveReorganise;
    client.generateConfirmedReorganisation.mockImplementationOnce(
      () => new Promise((r) => { resolveReorganise = () => r(makeConfirmedGenerateResponse(KEEP_AND_SELL.confirmed)); })
    );
    // Reorganise started SECOND, while Listings is still in flight: both
    // concurrently in flight, proving the concurrency domains are
    // independent (neither is blocked by the other's own busy state).
    await user.click(screen.getByRole("button", { name: /continue to reorganisation/i }));
    expect(client.generateConfirmedReorganisation).toHaveBeenCalledTimes(1);
    // Both operations are genuinely in flight at once, each with its own
    // accessible progress text.
    expect(screen.getByText(/generating.*listing drafts/i)).toBeInTheDocument();
    expect(screen.getByText(/planning the room and generating a preview/i)).toBeInTheDocument();

    resolveListings();
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());
    // Reorganise is STILL generating, unaffected by the listing batch settling.
    expect(screen.queryByRole("heading", { name: /your room plan/i })).not.toBeInTheDocument();

    resolveReorganise();
    await waitFor(() => expect(screen.getByRole("heading", { name: /your room plan/i })).toBeInTheDocument());
    // The finished listing draft is still visible after Reorganise completes.
    expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument();
  });

  test("a listing failure does not hide, disable or relabel Reorganise", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await toConfirmed(user, KEEP_AND_SELL);

    client.generateListings.mockRejectedValueOnce(new Error("Listing service unreachable"));
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/listing service unreachable/i));
    const reorganiseButton = screen.getByRole("button", { name: /continue to reorganisation/i });
    expect(reorganiseButton).toBeEnabled();
    expect(reorganiseButton).toHaveTextContent(/^continue to reorganisation$/i);
  });

  test("a Reorganise failure does not hide or disable Listings", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await toConfirmed(user, KEEP_AND_SELL);

    client.generateConfirmedReorganisation.mockRejectedValueOnce(new Error("service unreachable"));
    await user.click(screen.getByRole("button", { name: /continue to reorganisation/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/service unreachable/i));

    const generateButton = screen.getByRole("button", { name: /generate listing drafts/i });
    expect(generateButton).toBeEnabled();

    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse(makeConfirmResponse(KEEP_AND_SELL.confirmed), [makeDraft("item_002")])
    );
    await user.click(generateButton);
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());
  });

  test("a completed Reorganise result keeps Listings visible and usable, and existing edits survive", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await toConfirmed(user, KEEP_AND_SELL);

    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse(makeConfirmResponse(KEEP_AND_SELL.confirmed), [makeDraft("item_002")])
    );
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());

    const titleInput = screen.getByLabelText(/listing title for/i);
    await user.clear(titleInput);
    await user.type(titleInput, "My edited title");

    client.generateConfirmedReorganisation.mockResolvedValueOnce(makeConfirmedGenerateResponse(KEEP_AND_SELL.confirmed));
    await user.click(screen.getByRole("button", { name: /continue to reorganisation/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /your room plan/i })).toBeInTheDocument());

    // Listings is still rendered and usable, the edit survived.
    expect(screen.getByDisplayValue("My edited title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy listing/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /regenerate draft/i })).toBeInTheDocument();
  });

  test("Start over resets both the Reorganise result and the listing drafts", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await toConfirmed(user, KEEP_AND_SELL);

    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse(makeConfirmResponse(KEEP_AND_SELL.confirmed), [makeDraft("item_002")])
    );
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());

    client.generateConfirmedReorganisation.mockResolvedValueOnce(makeConfirmedGenerateResponse(KEEP_AND_SELL.confirmed));
    await user.click(screen.getByRole("button", { name: /continue to reorganisation/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /your room plan/i })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /start over/i }));

    expect(screen.getByLabelText(/room photo/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /your room plan/i })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Great lamp for sale")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate listing drafts/i })).not.toBeInTheDocument();
  });

  test("regeneration calls the single-item endpoint only, independent of Reorganise", async () => {
    const user = userEvent.setup();
    render(<BothPage />);
    await toConfirmed(user, KEEP_AND_SELL);

    client.generateListings.mockResolvedValueOnce(
      makeListingsResponse(makeConfirmResponse(KEEP_AND_SELL.confirmed), [makeDraft("item_002")])
    );
    await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Great lamp for sale")).toBeInTheDocument());

    client.regenerateListing.mockResolvedValueOnce(
      makeSingleListingResponse(makeConfirmResponse(KEEP_AND_SELL.confirmed), makeDraft("item_002", { title: "Regenerated title" }))
    );
    await user.click(screen.getByRole("button", { name: /^regenerate draft$/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Regenerated title")).toBeInTheDocument());

    expect(client.regenerateListing).toHaveBeenCalledTimes(1);
    expect(client.generateConfirmedReorganisation).not.toHaveBeenCalled();
  });
});
