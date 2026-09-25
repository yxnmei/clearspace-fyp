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
    tidy_plan: { phases: [{ phase_id: "empty_clean", title: "Empty and clean", steps: [{ step_id: "empty_clean-1", text: "Clear the desk", item_ids: ["item_001"] }] }] },
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
  await userEvent.upload(screen.getByLabelText(/space photo/i), makeFile());
  await userEvent.click(screen.getByRole("button", { name: /^analyse space$/i }));
  await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "What we found" })).toBeInTheDocument());
}

async function continueToGenerate() {
  await userEvent.click(screen.getByRole("button", { name: /continue to select items/i }));
  expect(screen.getByRole("heading", { name: /choose items for your tidy plan/i })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /continue to tidy plan/i }));
  expect(screen.getByRole("heading", { name: /create your tidy plan/i })).toBeInTheDocument();
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
    expect(currentStep()).toBe("Analyse space");
    expect(screen.queryByRole("heading", { name: /choose items for your tidy plan/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /continue to select items/i }));
    expect(currentStep()).toBe("Select items");
    expect(screen.queryByRole("heading", { name: /analysis complete/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /back to analyse/i }));
    expect(currentStep()).toBe("Analyse space");
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
    expect(currentStep()).toBe("Analyse space");
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
    expect(screen.getByRole("button", { name: /create tidy plan/i })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /create tidy plan/i }));
    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());
    expect(currentStep()).toBe("Tidy plan");
    expect(within(stepper()).getByText("Your tidy plan is ready.")).toBeInTheDocument();
  });

  test("a generation error remains retryable on the Generate screen", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockRejectedValueOnce(new Error("plan service down"));
    render(<ReorganisePage />);

    await analyseRoom();
    await continueToGenerate();
    await userEvent.click(screen.getByRole("button", { name: /create tidy plan/i }));

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
    await userEvent.click(screen.getByRole("button", { name: /create tidy plan/i }));

    await waitFor(() => expect(within(stepper()).getByText("Your tidy plan is ready.")).toBeInTheDocument());
    expect(screen.getByText("Clear the desk")).toBeInTheDocument();
  });
});

describe("ReorganisePage checklist and storage suggestions", () => {
  test("renders the shared checklist and storage suggestions from the generate response, never a focus-areas section", async () => {
    const response = makeGeneratedResponse();
    response.storage_suggestions = [
      { name: "Compartment tray", reason: "Gives 2 small personal items a fixed compartment each.", related_item_ids: ["item_001"] },
    ];
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockResolvedValue(response);
    render(<ReorganisePage />);

    await analyseRoom();
    await continueToGenerate();
    await userEvent.click(screen.getByRole("button", { name: /create tidy plan/i }));

    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Your tidy plan" })).toBeInTheDocument());
    const checklist = screen.getByRole("list", { name: /empty and clean steps/i });
    expect(within(checklist).getByText("Clear the desk")).toBeInTheDocument();
    expect(within(checklist).getByRole("checkbox", { name: /clear the desk/i })).not.toBeChecked();
    expect(screen.queryByRole("region", { name: /areas to focus on|focus areas/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/areas to focus on|focus area/i)).not.toBeInTheDocument();
    const suggestions = screen.getByRole("region", { name: /storage and organisation ideas/i });
    expect(within(suggestions).getByText("Compartment tray")).toBeInTheDocument();
    expect(within(suggestions).queryByText(/^For:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^storage suggestions$/i })).not.toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Tidy plan", "Visual preview", "Storage and organisation ideas"]);
    expect(screen.queryByText(/room plan/i)).not.toBeInTheDocument();
    // checking a step is local only: no request, no navigation change
    await userEvent.click(within(checklist).getByRole("checkbox", { name: /clear the desk/i }));
    expect(screen.getByText("1 of 1 completed")).toBeInTheDocument();
    expect(client.generateReorganisation).toHaveBeenCalledTimes(1);
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
    await userEvent.click(screen.getByRole("button", { name: /create tidy plan/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/unselected/i));
    expect(screen.queryByRole("heading", { name: "Your tidy plan" })).not.toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: /create tidy plan/i }));

    await waitFor(() => expect(screen.getByText(/visual preview unavailable/i)).toBeInTheDocument());
    expect(screen.getByText("Clear the desk")).toBeInTheDocument();
    // the fallback is not explained to the user in technical terms; the checklist just works
    expect(screen.queryByText(/did not return a usable checklist|ai assistant|call_failed|deterministic/i)).not.toBeInTheDocument();
    expect(screen.getByText(/took too long/i)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /areas to focus on/i })).not.toBeInTheDocument();
    expect(within(stepper()).getByText("Your tidy plan is ready.")).toBeInTheDocument();
  });

  test("the production response renders as a plain checklist with no provenance, model or call details shown", async () => {
    // What the backend actually returns: no checklist model is called.
    const response = makeGeneratedResponse();
    response.action_plan = {
      ...response.action_plan,
      actions: [
        { priority: 1, title: "Group the picture frame items", instruction: "Keep all 6 together so they are easier to find and put back." },
        { priority: 2, title: "Tidy loose items on the left side", instruction: "Straighten the painting, jewelry, clock and the other loose items, then clear the surrounding space." },
        { priority: 3, title: "Do a final space check", instruction: "Review the space once more and make sure every selected item has a clear place." },
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
    await userEvent.click(screen.getByRole("button", { name: /create tidy plan/i }));

    await waitFor(() => expect(screen.getByText("Clear the desk")).toBeInTheDocument());
    expect(screen.queryByText("Group the picture frame items")).not.toBeInTheDocument();
    expect(screen.queryByText(/ai assistant|deterministic|model call|prompt version|phi4-mini|checklist details|generation details/i)).not.toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
    expect(screen.getByText("0 of 1 completed")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^visual preview$/i })).toBeInTheDocument();
    // Direct Reorganise keeps its own result heading and its own Start over inside the result
    expect(screen.getByRole("heading", { level: 2, name: "Your tidy plan" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Tidy up" })).not.toBeInTheDocument();
    const startOver = screen.getByRole("button", { name: /start over/i });
    expect(screen.getAllByRole("button", { name: /start over/i })).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Your tidy plan" })).toContainElement(startOver);
    // The phased plan is the displayed result; the legacy action_plan is retained only in the response.
    const rows = within(screen.getByRole("list", { name: /empty and clean steps/i })).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Clear the desk")).toBeInTheDocument();
    for (const row of rows) expect(within(row).getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Clear the desk" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /areas to focus on|focus areas/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Upload photo + Analyse space screens (shared redesign phase)
// ---------------------------------------------------------------------------

describe("ReorganisePage Upload photo and Analyse space screens", () => {
  const analyseHeading = (name) => screen.getByRole("heading", { level: 2, name });
  const whatWeFound = () => screen.getByRole("heading", { level: 2, name: "What we found" });
  const visibleH2s = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent.trim());
  const JARGON = /scene classification|object detection|item reasoning|candidate|confidence|\d+%|analysis time|this computer|\broom\b/i;

  test("Upload photo uses the shared heading and copy, a short outcome intro, and no step number", () => {
    render(<ReorganisePage />);
    expect(screen.getByRole("form", { name: "Upload a photo of your space" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Upload one clear photo with most items in frame. Context is optional."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Choose which items to include, then get a phased tidy plan with storage ideas and an optional preview.")).toBeInTheDocument();
    expect(screen.queryByText(/reorganisation checklist|storage suggestions when relevant/i)).not.toBeInTheDocument();
    const upload = screen.getByRole("form", { name: "Upload a photo of your space" }).parentElement;
    expect(upload.textContent).not.toMatch(/\broom\b|^\s*1\./i);
    expect(client.uploadImage).not.toHaveBeenCalled();
  });

  test("analysing: one heading, one calm jargon-free status, locked controls, exactly one request", async () => {
    let resolveUpload;
    client.uploadImage.mockImplementationOnce(() => new Promise((r) => { resolveUpload = () => r(makeUploadResponse()); }));
    render(<ReorganisePage />);
    await userEvent.upload(screen.getByLabelText(/space photo/i), makeFile());
    await userEvent.type(screen.getByLabelText(/context for the ai/i), "desk by the window");
    await userEvent.click(screen.getByRole("button", { name: /^analyse space$/i }));

    await waitFor(() => expect(currentStep()).toBe("Analyse space"));
    expect(analyseHeading("Analysing your space")).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Finding items and preparing your next step. This may take up to two minutes.");
    expect(status.querySelector("svg")).not.toBeNull();
    expect(status.textContent).not.toMatch(JARGON);
    expect(screen.queryByRole("heading", { name: /what we found/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back to upload photo/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /continue to select items/i })).toBeDisabled();
    expect(client.uploadImage).toHaveBeenCalledTimes(1);
    resolveUpload();
    await waitFor(() => expect(whatWeFound()).toBeInTheDocument());
  });

  test("error: Analysis unsuccessful, one alert pointing back to the preserved photo and context, no auto retry", async () => {
    client.uploadImage.mockRejectedValueOnce(new Error("The analysis service is unavailable."));
    render(<ReorganisePage />);
    await userEvent.upload(screen.getByLabelText(/space photo/i), makeFile());
    await userEvent.type(screen.getByLabelText(/context for the ai/i), "desk by the window");
    await userEvent.click(screen.getByRole("button", { name: /^analyse space$/i }));

    await waitFor(() => expect(analyseHeading("Analysis unsuccessful")).toBeInTheDocument());
    const alerts = screen.getAllByRole("alert").filter((a) => a.closest("[hidden]") === null);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/the analysis service is unavailable/i);
    expect(alerts[0]).toHaveTextContent(/your selected photo and context are still on upload photo/i);
    expect(screen.queryByRole("heading", { name: /what we found/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to select items/i })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /back to upload photo/i }));
    expect(currentStep()).toBe("Upload photo");
    expect(screen.getByText("room.png")).toBeInTheDocument();
    expect(screen.getByText(/replace photo/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/context for the ai/i)).toHaveValue("desk by the window");
    expect(client.uploadImage).toHaveBeenCalledTimes(1);
  });

  test("success: What we found is the single visible h2, with no second heading or banner, and Reorganise's own stats", async () => {
    const response = makeUploadResponse();
    response.analysis.items.push({ ...response.analysis.items[0], item_id: "item_002", source_detection_index: 1, item_role: "contextual" });
    client.uploadImage.mockResolvedValue(response);
    render(<ReorganisePage />);
    await analyseRoom();

    // the success state carries no page heading or banner of its own: the tracker's
    // live status line says it once, and What we found is the only visible h2
    expect(screen.queryByRole("heading", { name: /analysis complete/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/your space has been analysed/i)).not.toBeInTheDocument();
    expect(visibleH2s()).toEqual(["What we found"]);
    expect(whatWeFound().closest("section").parentElement.querySelector('[role="status"]')).toBeNull();
    expect(whatWeFound().closest("section").parentElement.querySelector(".bg-success\\/10")).toBeNull();
    expect(within(stepper()).getByText("Analysis complete.")).toBeInTheDocument();
    expect(within(stepper()).getByText("Continue to Select items to check the detected items.")).toBeInTheDocument();
    expect(within(stepper()).getByText("Analysis complete.").closest("[aria-live]")).not.toBeNull();
    const summary = screen.getByRole("region", { name: "What we found" });
    expect(within(summary).getByRole("heading", { level: 2, name: "What we found" })).toBeInTheDocument();
    expect(Array.from(summary.querySelectorAll("dt")).map((dt) => dt.textContent)).toEqual([
      "Space type",
      "Items found",
      "Available to include",
    ]);
    expect(Array.from(summary.querySelectorAll("dd")).map((dd) => dd.textContent)).toEqual(["bedroom", "2", "1"]);
    expect(summary.textContent).not.toMatch(JARGON);
    expect(screen.queryByText(/extra review/i)).not.toBeInTheDocument();
    expect(whatWeFound().closest("section").parentElement.textContent).not.toMatch(/\broom\b/i);
    expect(screen.getByRole("button", { name: /continue to select items/i })).toBeEnabled();
    expect(currentStep()).toBe("Analyse space");
    expect(client.generateReorganisation).not.toHaveBeenCalled();
  });

  test("a warning in the analysis shows one calm sentence, never the code", async () => {
    const response = makeUploadResponse();
    response.analysis.warnings = [{ code: "low_confidence_scene", message: "internal detail" }];
    client.uploadImage.mockResolvedValue(response);
    render(<ReorganisePage />);
    await analyseRoom();
    expect(screen.getByText("Some results may need extra review.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What we found" }).textContent).not.toMatch(/low_confidence_scene|internal detail/);
  });

  test("Back to Upload photo keeps the selected photo and context, and forward again does not re-analyse", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    render(<ReorganisePage />);
    await userEvent.type(screen.getByLabelText(/context for the ai/i), "desk by the window");
    await analyseRoom();

    await userEvent.click(screen.getByRole("button", { name: /back to upload photo/i }));
    expect(currentStep()).toBe("Upload photo");
    expect(screen.getByText("room.png")).toBeInTheDocument();
    expect(screen.getByLabelText(/context for the ai/i)).toHaveValue("desk by the window");

    await userEvent.click(within(stepper()).getByRole("button", { name: /go to analyse space/i }));
    expect(currentStep()).toBe("Analyse space");
    expect(whatWeFound()).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /analysis complete/i })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What we found" })).toBeInTheDocument();
    expect(client.uploadImage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tidy plan screen terminology, layout and image-service notice (cleanup pass)
// ---------------------------------------------------------------------------

describe("ReorganisePage Tidy plan screen (cleanup pass)", () => {
  const createTidyPlan = () => screen.getByRole("button", { name: "Create tidy plan" });
  const classes = (el) => el.className.split(/\s+/).filter(Boolean);

  test("is a labelled section headed Create your tidy plan, describing the outcome from the Select items count, with no stale wording", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    render(<ReorganisePage />);
    await analyseRoom();
    await continueToGenerate();

    const section = screen.getByRole("region", { name: "Create your tidy plan" });
    expect(within(section).getByRole("heading", { level: 2, name: "Create your tidy plan" })).toBeInTheDocument();
    expect(section).toHaveTextContent(
      /prioritised checklist, relevant storage and organisation ideas and an optional visual preview from the 1 item you included on Select items\./
    );
    expect(section.textContent).not.toMatch(/reorganisation plan|generate|during review|^\s*4\.|\broom\b/i);
    expect(screen.queryByRole("heading", { name: /generate reorganisation plan/i })).not.toBeInTheDocument();
    const button = createTidyPlan();
    expect(button).toBeEnabled();
    for (const c of ["min-h-11", "w-full", "sm:min-h-0", "sm:w-auto"]) expect(classes(button)).toContain(c);
    expect(client.generateReorganisation).not.toHaveBeenCalled();
  });

  test("loading and failure use the tidy plan terms in the button and the tracker, and retry keeps the selection", async () => {
    let rejectPlan;
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockImplementationOnce(() => new Promise((_, reject) => { rejectPlan = () => reject(new Error("plan service down")); }));
    render(<ReorganisePage />);
    await analyseRoom();
    await continueToGenerate();

    await userEvent.click(createTidyPlan());
    const busy = screen.getByRole("button", { name: /creating tidy plan…/i });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(within(stepper()).getByText("Creating your tidy plan…")).toBeInTheDocument();
    expect(screen.queryByText(/generating…|writing your checklist/i)).not.toBeInTheDocument();

    rejectPlan();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/plan service down/i));
    expect(within(stepper()).getByText("The tidy plan didn't finish.")).toBeInTheDocument();
    expect(within(stepper()).getByText("Your selection is unchanged. Try again below.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(client.generateReorganisation).toHaveBeenCalledTimes(1);
    expect(currentStep()).toBe("Tidy plan");
  });

  test("the image-service notice sits inside the tidy plan section as the one notice, never disables the action, and is not repeated beside a result with its own unavailable preview", async () => {
    client.getImageGenHealth.mockResolvedValue({ available: false });
    const unavailable = makeGeneratedResponse();
    unavailable.image_status = "unavailable";
    unavailable.image = null;
    unavailable.image_unavailable_reason = "service_unreachable";
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.generateReorganisation.mockResolvedValue(unavailable);
    render(<ReorganisePage />);
    await analyseRoom();
    await continueToGenerate();

    const notices = await screen.findAllByText(/visual preview is currently unavailable/i);
    expect(notices).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Create your tidy plan" })).toContainElement(notices[0]);
    expect(screen.queryByText(/image service is offline/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /check again/i })).toBeEnabled();
    expect(createTidyPlan()).toBeEnabled();

    await userEvent.click(createTidyPlan());
    await waitFor(() => expect(screen.getByRole("heading", { name: /visual preview unavailable/i })).toBeInTheDocument());
    expect(screen.queryByText(/visual preview is currently unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check again/i })).not.toBeInTheDocument();
    expect(screen.getByText("Clear the desk")).toBeInTheDocument();
    expect(within(stepper()).getByText("Your tidy plan is ready.")).toBeInTheDocument();
  });

  test("Check again inside the tidy plan section rechecks availability exactly as before", async () => {
    client.getImageGenHealth.mockResolvedValue({ available: false });
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    render(<ReorganisePage />);
    await analyseRoom();
    await continueToGenerate();
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalledTimes(1));
    client.getImageGenHealth.mockResolvedValue({ available: true });
    await userEvent.click(screen.getByRole("button", { name: /check again/i }));
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/visual preview is currently unavailable/i)).not.toBeInTheDocument());
    expect(createTidyPlan()).toBeEnabled();
  });
});
