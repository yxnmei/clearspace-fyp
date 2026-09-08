import { render, screen, waitFor, within } from "@testing-library/react";
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

function stepper() {
  return screen.getByRole("navigation", { name: /reorganise workflow progress/i });
}

function currentStep() {
  return within(stepper())
    .getAllByRole("listitem")
    .find((item) => item.getAttribute("aria-current") === "step")
    ?.textContent.replace(/\d+/g, "")
    .trim();
}

async function analyseRoom() {
  await userEvent.upload(screen.getByLabelText(/room photo/i), makeFile());
  await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));
  await waitFor(() => expect(screen.getByRole("heading", { name: /analysis complete/i })).toBeInTheDocument());
}

async function continueToGenerate() {
  await userEvent.click(screen.getByRole("button", { name: /continue to review/i }));
  expect(screen.getByRole("heading", { name: /review items for your room plan/i })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /continue to generate/i }));
  expect(screen.getByRole("heading", { name: /generate room plan/i })).toBeInTheDocument();
}

describe("ReorganisePage screen-by-screen flow", () => {
  test("mounting owns exactly one image-health request", async () => {
    render(<ReorganisePage />);
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalledTimes(1));
  });

  test("shows one step screen at a time and supports Back navigation", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    render(<ReorganisePage />);

    expect(currentStep()).toBe("Upload");
    expect(screen.queryByRole("heading", { name: /review items for your room plan/i })).not.toBeInTheDocument();

    await analyseRoom();
    expect(currentStep()).toBe("Analyse");
    expect(screen.queryByRole("heading", { name: /review items for your room plan/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /continue to review/i }));
    expect(currentStep()).toBe("Review");
    expect(screen.queryByRole("heading", { name: /analysis complete/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /back to analyse/i }));
    expect(currentStep()).toBe("Analyse");
  });

  test("Review requires an included item before Generate is unlocked", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    render(<ReorganisePage />);
    await analyseRoom();
    await userEvent.click(screen.getByRole("button", { name: /continue to review/i }));

    await userEvent.click(document.getElementById("reorganise-item-item_001"));
    expect(screen.getByRole("button", { name: /continue to generate/i })).toBeDisabled();
  });

  test("completes Upload → Analyse → Review → Generate without health blocking", async () => {
    client.getImageGenHealth.mockResolvedValue({ available: false });
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockResolvedValue(makeGeneratedResponse());
    render(<ReorganisePage />);

    await analyseRoom();
    await continueToGenerate();
    await waitFor(() => expect(screen.getByText(/visual preview is currently unavailable/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /generate room plan/i })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /generate room plan/i }));
    await waitFor(() => expect(screen.getByText("Keep in place")).toBeInTheDocument());
    expect(currentStep()).toBe("Generate");
    expect(within(stepper()).getByText(/your reorganisation is complete/i)).toBeInTheDocument();
  });

  test("a generation error remains retryable on the Generate screen", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockRejectedValueOnce(new Error("plan service down"));
    render(<ReorganisePage />);

    await analyseRoom();
    await continueToGenerate();
    await userEvent.click(screen.getByRole("button", { name: /generate room plan/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/plan service down/i));
    expect(currentStep()).toBe("Generate");
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
  });

  test("a successful plan still completes when the visual preview is unavailable", async () => {
    const unavailable = makeGeneratedResponse();
    unavailable.image_status = "unavailable";
    unavailable.image = null;
    unavailable.image_unavailable_reason = "service_unreachable";
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockResolvedValue(unavailable);
    render(<ReorganisePage />);

    await analyseRoom();
    await continueToGenerate();
    await userEvent.click(screen.getByRole("button", { name: /generate room plan/i }));

    await waitFor(() => expect(within(stepper()).getByText(/your reorganisation is complete/i)).toBeInTheDocument());
    expect(screen.getByText("Keep in place")).toBeInTheDocument();
  });
});
