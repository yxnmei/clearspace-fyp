import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import ReorganisePage from "./ReorganisePage";
import * as client from "../api/client";

vi.mock("../api/client", () => ({
  uploadImage: vi.fn(),
  generateReorganisation: vi.fn(),
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

function makeUploadResponse() {
  return {
    run_id: "run1",
    path: "reorganise",
    analysis: {
      run_id: "run1",
      scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
      items: [
        {
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
        },
      ],
      warnings: [],
      stage_timings: [],
    },
    input_image_sha256: HASH,
  };
}

function makeGeneratedResponse() {
  return {
    run_id: "run1",
    planning: {
      run_id: "run1",
      plan: {
        zones: [{ zone_name: "Keep in place", item_ids: ["item_001"], instruction: "keep as is" }],
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
    image_status: "generated",
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
      generation_ms: 100,
      prompt_sha256: "b".repeat(64),
      input_image_sha256: HASH,
    },
    image_unavailable_reason: null,
  };
}

describe("ReorganisePage — health ownership", () => {
  test("mounting the page issues exactly one health request", async () => {
    render(<ReorganisePage onBackToPathSelection={vi.fn()} />);
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalledTimes(1));
  });

  test("an unavailable health status is shown via the banner, sourced from the one hook instance", async () => {
    client.getImageGenHealth.mockResolvedValue({ available: false });
    render(<ReorganisePage onBackToPathSelection={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/visual preview is currently unavailable/i)).toBeInTheDocument());
    expect(client.getImageGenHealth).toHaveBeenCalledTimes(1);
  });
});

describe("ReorganisePage — end-to-end phase flow", () => {
  test("upload -> select -> generate -> result, with health advisory shown but never blocking", async () => {
    client.getImageGenHealth.mockResolvedValue({ available: false }); // unavailable throughout
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockResolvedValue(makeGeneratedResponse());

    render(<ReorganisePage onBackToPathSelection={vi.fn()} />);

    await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /generate room plan/i })).toBeInTheDocument());
    expect(screen.getByText(/visual preview is currently unavailable/i)).toBeInTheDocument(); // the banner
    expect(screen.getByText(/image service is offline/i)).toBeInTheDocument(); // the item-selector's own advisory
    expect(screen.getByRole("button", { name: /generate room plan/i })).toBeEnabled(); // health never blocks it

    await userEvent.click(screen.getByRole("button", { name: /generate room plan/i }));

    await waitFor(() => expect(screen.getByText(/your room plan/i)).toBeInTheDocument());
    expect(screen.getByText("Keep in place")).toBeInTheDocument();
  });

  test("Back to workflow selection calls onBackToPathSelection", async () => {
    const onBack = vi.fn();
    render(<ReorganisePage onBackToPathSelection={onBack} />);
    await userEvent.click(screen.getByRole("button", { name: /back to workflow selection/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
