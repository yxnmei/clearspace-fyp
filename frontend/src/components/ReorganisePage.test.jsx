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
    focus_areas: [{ area_id: "left", label: "Left side", item_ids: ["item_001"] }],
    storage_suggestions: [],
    image_prompt: "a tidy bedroom",
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
  await userEvent.click(screen.getByRole("button", { name: /^analyse room$/i }));
  await waitFor(() => expect(screen.getByRole("heading", { name: /analysis complete/i })).toBeInTheDocument());
}

async function continueToGenerate() {
  await userEvent.click(screen.getByRole("button", { name: /continue to select items/i }));
  expect(screen.getByRole("heading", { name: /choose items for your tidy plan/i })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /continue to tidy plan/i }));
  expect(screen.getByRole("heading", { name: /generate reorganisation plan/i })).toBeInTheDocument();
}

describe("ReorganisePage screen-by-screen flow", () => {
  test("mounting owns exactly one image-health request", async () => {
    render(<ReorganisePage />);
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalledTimes(1));
  });

  test("shows one step screen at a time and supports Back navigation", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    render(<ReorganisePage />);

    expect(currentStep()).toBe("Upload photo");
    expect(screen.queryByRole("heading", { name: /choose items for your tidy plan/i })).not.toBeInTheDocument();

    await analyseRoom();
    expect(currentStep()).toBe("Analyse room");
    expect(screen.queryByRole("heading", { name: /choose items for your tidy plan/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /continue to select items/i }));
    expect(currentStep()).toBe("Select items");
    expect(screen.queryByRole("heading", { name: /analysis complete/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /back to analyse/i }));
    expect(currentStep()).toBe("Analyse room");
  });

  test("Review requires an included item before Generate is unlocked", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    render(<ReorganisePage />);
    await analyseRoom();
    await userEvent.click(screen.getByRole("button", { name: /continue to select items/i }));

    await userEvent.click(document.getElementById("reorganise-item-item_001"));
    expect(screen.getByRole("button", { name: /continue to tidy plan/i })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/include at least one item/i);
  });

  test("selection survives Back and forward navigation, Continue only navigates once selection is valid, and no API is called", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    render(<ReorganisePage />);
    await analyseRoom();
    await userEvent.click(screen.getByRole("button", { name: /continue to select items/i }));
    expect(currentStep()).toBe("Select items");
    expect(document.getElementById("reorganise-item-item_001")).toBeChecked();

    // exclude the only item, go back, come forward: still excluded, still blocked
    await userEvent.click(document.getElementById("reorganise-item-item_001"));
    expect(document.getElementById("reorganise-item-item_001")).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: /back to analyse/i }));
    expect(currentStep()).toBe("Analyse room");
    await userEvent.click(screen.getByRole("button", { name: /continue to select items/i }));
    expect(currentStep()).toBe("Select items");
    expect(document.getElementById("reorganise-item-item_001")).not.toBeChecked();
    expect(screen.getByRole("button", { name: /continue to tidy plan/i })).toBeDisabled();

    // include it again: Continue navigates to Tidy plan without generating anything
    await userEvent.click(document.getElementById("reorganise-item-item_001"));
    expect(document.getElementById("reorganise-item-item_001")).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: /continue to tidy plan/i }));
    expect(currentStep()).toBe("Tidy plan");
    expect(client.generateReorganisation).not.toHaveBeenCalled();
    expect(client.uploadImage).toHaveBeenCalledTimes(1);

    // and the selection is still there on the way back
    await userEvent.click(screen.getByRole("button", { name: /back to select items/i }));
    expect(document.getElementById("reorganise-item-item_001")).toBeChecked();
  });

  test("completes Upload → Analyse → Review → Generate without health blocking", async () => {
    client.getImageGenHealth.mockResolvedValue({ available: false });
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockResolvedValue(makeGeneratedResponse());
    render(<ReorganisePage />);

    await analyseRoom();
    await continueToGenerate();
    await waitFor(() => expect(screen.getByText(/visual preview is currently unavailable/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /generate reorganisation plan/i })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));
    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());
    expect(currentStep()).toBe("Tidy plan");
    expect(within(stepper()).getByText(/your reorganisation is complete/i)).toBeInTheDocument();
  });

  test("a generation error remains retryable on the Generate screen", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockRejectedValueOnce(new Error("plan service down"));
    render(<ReorganisePage />);

    await analyseRoom();
    await continueToGenerate();
    await userEvent.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/plan service down/i));
    expect(currentStep()).toBe("Tidy plan");
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
    await userEvent.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));

    await waitFor(() => expect(within(stepper()).getByText(/your reorganisation is complete/i)).toBeInTheDocument());
    expect(screen.getByText("Clear the desk")).toBeInTheDocument();
  });
});

describe("ReorganisePage checklist, focus areas and storage suggestions", () => {
  test("renders the shared checklist, focus areas and storage suggestions from the generate response", async () => {
    const response = makeGeneratedResponse();
    response.storage_suggestions = [
      { name: "Compartment tray", reason: "Gives 2 small personal items a fixed compartment each.", related_item_ids: ["item_001"] },
    ];
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockResolvedValue(response);
    render(<ReorganisePage />);

    await analyseRoom();
    await continueToGenerate();
    await userEvent.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: /your reorganisation checklist/i })).toBeInTheDocument());
    const checklist = screen.getByRole("list", { name: /checklist actions/i });
    expect(within(checklist).getByText("Clear the desk")).toBeInTheDocument();
    const areas = screen.getByRole("region", { name: /areas to focus on/i });
    expect(within(areas).getByRole("heading", { level: 3, name: "Left side" })).toBeInTheDocument();
    const suggestions = screen.getByRole("region", { name: /storage suggestions/i });
    expect(within(suggestions).getByText("Compartment tray")).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf("Your reorganisation checklist")).toBeLessThan(headings.indexOf("Areas to focus on"));
    expect(headings.indexOf("Areas to focus on")).toBeLessThan(headings.indexOf("Storage suggestions"));
    expect(headings.indexOf("Storage suggestions")).toBeLessThan(headings.indexOf("Visual preview"));
    expect(screen.queryByText(/room plan/i)).not.toBeInTheDocument();
    // the wizard is unchanged: Generate is the viewed step and Back still works
    expect(currentStep()).toBe("Tidy plan");
    expect(screen.getByRole("button", { name: /back to select items/i })).toBeEnabled();
  });

  test("a response whose focus area names an unselected item is rejected as a generation error", async () => {
    const response = makeGeneratedResponse();
    response.focus_areas = [{ area_id: "left", label: "Left side", item_ids: ["item_999"] }];
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockResolvedValue(response);
    render(<ReorganisePage />);

    await analyseRoom();
    await continueToGenerate();
    await userEvent.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/unselected/i));
    expect(screen.queryByRole("heading", { name: /your reorganisation checklist/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
  });

  test("a fallback checklist renders with an unavailable visual preview", async () => {
    const response = makeGeneratedResponse();
    response.action_plan = {
      ...response.action_plan,
      provenance: "deterministic_fallback",
      was_repaired: null,
      model_name: null,
      prompt_version: null,
      issues: [{ kind: "call_failed", detail: "checklist model call failed: RuntimeError" }],
    };
    response.image_status = "unavailable";
    response.image = null;
    response.image_unavailable_reason = "timeout";
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockResolvedValue(response);
    render(<ReorganisePage />);

    await analyseRoom();
    await continueToGenerate();
    await userEvent.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));

    await waitFor(() => expect(screen.getByText(/visual preview unavailable/i)).toBeInTheDocument());
    expect(screen.getByText("Clear the desk")).toBeInTheDocument();
    expect(screen.getByText(/did not return a usable checklist/i)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /areas to focus on/i })).toBeInTheDocument();
    expect(within(stepper()).getByText(/your reorganisation is complete/i)).toBeInTheDocument();
  });

  test("the production response shows zero checklist model calls and deterministic_direct, truthfully", async () => {
    // What the backend actually returns: no checklist model is called.
    const response = makeGeneratedResponse();
    response.action_plan = {
      ...response.action_plan,
      actions: [
        { priority: 1, title: "Start with the left side", instruction: "The left side of your photo holds 1 of your selected item (lamp). Straighten it and clear loose items from the space immediately around it." },
        { priority: 2, title: "Check the whole room", instruction: "Look over the bedroom once more and make sure each selected item has a visible, settled place before you finish." },
      ],
      provenance: "deterministic_direct",
      attempts: 0,
      model_name: null,
      prompt_version: null,
      was_repaired: null,
      issues: [],
    };
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockResolvedValue(response);
    render(<ReorganisePage />);

    await analyseRoom();
    await continueToGenerate();
    await userEvent.click(screen.getByRole("button", { name: /generate reorganisation plan/i }));

    await waitFor(() => expect(screen.getByText("Start with the left side")).toBeInTheDocument());
    expect(screen.getByText(/without the ai assistant/i)).toBeInTheDocument();
    expect(screen.queryByText(/suggested by the ai assistant/i)).not.toBeInTheDocument();
    const details = screen.getByText("Checklist details").closest("details");
    expect(details).toHaveTextContent("deterministic_direct");
    expect(within(details).getByText("Model calls").closest("div")).toHaveTextContent("0");
    expect(within(details).getByText("Model").closest("div")).toHaveTextContent("n/a");
    expect(within(details).getByText("Prompt version").closest("div")).toHaveTextContent("n/a");
    expect(details).not.toHaveTextContent("phi4-mini");
    expect(screen.getByRole("heading", { name: /^visual preview$/i })).toBeInTheDocument();
  });
});
