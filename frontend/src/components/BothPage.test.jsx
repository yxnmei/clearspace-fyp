import { render, screen, waitFor } from "@testing-library/react";
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

describe("BothPage — health ownership", () => {
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

describe("BothPage — end-to-end: upload -> review -> confirm -> continue -> result", () => {
  test("no second item-selection screen — DeclutterReview alone drives what's kept", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    render(<BothPage />);

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeInTheDocument());
    // The Reorganise-only item-selector (ReorganiseItemSelector, a
    // SEPARATE selection screen) never renders here at all — Both
    // answers "what to keep" entirely through Declutter's own review.
    expect(screen.queryByText(/choose what to keep/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate room plan/i })).not.toBeInTheDocument();
  });

  test("Continue only appears after explicit confirmation — never auto-generates", async () => {
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
    // Upload/review screen is gone — Result is the terminal screen.
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
    // Confirmation/review are still visible — nothing was thrown away.
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
