import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import ReorganiseResult from "./ReorganiseResult";

function makeItem(id, label = "lamp") {
  return { item_id: id, clean_label: label, effective_label: label, item_role: "actionable" };
}

function makePlanning(overrides = {}) {
  return {
    run_id: "run1",
    plan: {
      zones: [{ zone_name: "Keep in place", item_ids: ["item_001", "item_002"], instruction: "keep as is" }],
      image_prompt: "a tidy bedroom",
      negative_prompt: null,
    },
    provenance: "raw_valid",
    issues: [],
    attempts: 1,
    model_name: "phi4-mini",
    prompt_version: "v1",
    stage_timings: [{ stage: "reorganise_plan", duration_ms: 5 }],
    ...overrides,
  };
}

function makeGeneratedResult(overrides = {}) {
  return {
    runId: "run1",
    planning: makePlanning(),
    imageStatus: "generated",
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
      generation_ms: 4500,
      prompt_sha256: "a".repeat(64),
      input_image_sha256: "b".repeat(64),
    },
    imageUnavailableReason: null,
    ...overrides,
  };
}

function makeUnavailableResult(reason = "service_unreachable") {
  return {
    runId: "run1",
    planning: makePlanning(),
    imageStatus: "unavailable",
    image: null,
    imageUnavailableReason: reason,
  };
}

const items = [makeItem("item_001", "lamp"), makeItem("item_002", "desk")];

describe("ReorganiseResult — plan (always shown)", () => {
  test("renders zone name, instruction, and items joined back by item_id", () => {
    render(<ReorganiseResult generateResult={makeGeneratedResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    expect(screen.getByText("Keep in place")).toBeInTheDocument();
    expect(screen.getByText("keep as is")).toBeInTheDocument();
    expect(screen.getByText("lamp")).toBeInTheDocument();
    expect(screen.getByText("desk")).toBeInTheDocument();
  });

  test("stable item numbers are shown for zone items", () => {
    // Scoped to the zone list's own badge spans — a bare getByText("1")
    // would also match unrelated numeric text inside the (present-but-
    // collapsed, still-in-the-DOM-in-jsdom) planning-details disclosure.
    const { container } = render(
      <ReorganiseResult generateResult={makeGeneratedResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />
    );
    const badges = Array.from(container.querySelectorAll("ul li span")).map((el) => el.textContent);
    expect(badges).toEqual(["1", "2"]);
  });

  test("planning provenance and metadata are collapsed by default (secondary disclosure)", () => {
    render(<ReorganiseResult generateResult={makeGeneratedResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    const details = screen.getByText("Planning details").closest("details");
    expect(details).not.toHaveAttribute("open");
  });

  test("planning details include the planning duration, derived from stage_timings", () => {
    render(<ReorganiseResult generateResult={makeGeneratedResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    // makePlanning's default stage_timings is [{ stage: "reorganise_plan", duration_ms: 5 }] -> 0.01s
    expect(screen.getByText(/planning duration/i)).toBeInTheDocument();
    expect(screen.getByText("0.01s")).toBeInTheDocument();
  });

  test("planning issues, when present, are listed inside the technical disclosure", () => {
    const result = makeGeneratedResult({
      planning: makePlanning({
        provenance: "deterministic_fallback",
        attempts: 2,
        issues: [{ attempt: "initial", kind: "invalid_json", detail: "malformed response" }],
      }),
    });
    render(<ReorganiseResult generateResult={result} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    expect(screen.getByText(/malformed response/)).toBeInTheDocument();
  });
});

describe("ReorganiseResult — generated image", () => {
  test("shows both Before and Reorganised images with clear labels", () => {
    render(
      <ReorganiseResult generateResult={makeGeneratedResult()} items={items} originalImageUrl="blob:mock-original" onStartOver={vi.fn()} />
    );
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("Reorganised")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /original room photo/i })).toHaveAttribute("src", "blob:mock-original");
    expect(screen.getByRole("img", { name: /reorganised/i })).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
  });

  test("does not claim perfect preservation", () => {
    render(<ReorganiseResult generateResult={makeGeneratedResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    expect(screen.queryByText(/perfectly preserved/i)).not.toBeInTheDocument();
    expect(screen.getByText(/may not be preserved exactly/i)).toBeInTheDocument();
  });

  test("generation metadata is available in a collapsed technical section", () => {
    render(<ReorganiseResult generateResult={makeGeneratedResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    const details = screen.getByText("Generation details").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("runwayml/stable-diffusion-v1-5")).toBeInTheDocument();
  });

  test("generation details include API version, depth-map use, prompt hash, and input-image hash", () => {
    render(<ReorganiseResult generateResult={makeGeneratedResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    // Scoped to the Generation details <details> — planning's own
    // prompt_version fixture is also literally "v1" and would otherwise
    // match ambiguously via a bare getByText("v1").
    const details = screen.getByText("Generation details").closest("details");
    expect(details).toHaveTextContent("API version");
    expect(details).toHaveTextContent("v1");
    expect(details).toHaveTextContent(/depth-conditioned/i);
    expect(details).toHaveTextContent("Yes");
    expect(details).toHaveTextContent(`Prompt hash: ${"a".repeat(64)}`);
    expect(details).toHaveTextContent(`Input-image hash: ${"b".repeat(64)}`);
  });
});

describe("ReorganiseResult — unavailable image", () => {
  test("shows the plan, no broken-image placeholder, and an explanatory message", () => {
    render(<ReorganiseResult generateResult={makeUnavailableResult("timeout")} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    expect(screen.getByText("Keep in place")).toBeInTheDocument(); // plan still shown
    expect(screen.getByText(/visual preview unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument(); // no broken-image element at all
  });

  test.each([
    ["service_unreachable", /could not be reached/i],
    ["timeout", /timed out/i],
    ["request_failed", /connection.*failed/i],
    ["service_error", /reported an error/i],
    ["invalid_response", /unexpected response/i],
  ])("shows a reason-specific message for %s", (reason, expectedText) => {
    render(<ReorganiseResult generateResult={makeUnavailableResult(reason)} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });

  test("explains that only the visual preview is affected, not the plan", () => {
    render(<ReorganiseResult generateResult={makeUnavailableResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    expect(screen.getByText(/room plan above is complete/i)).toBeInTheDocument();
  });

  test("no Retry button is offered", () => {
    render(<ReorganiseResult generateResult={makeUnavailableResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });
});

describe("ReorganiseResult — start over", () => {
  test("Start over calls onStartOver", async () => {
    const onStartOver = vi.fn();
    render(<ReorganiseResult generateResult={makeGeneratedResult()} items={items} originalImageUrl={null} onStartOver={onStartOver} />);
    await userEvent.click(screen.getByRole("button", { name: /start over/i }));
    expect(onStartOver).toHaveBeenCalled();
  });

  test("Start over is available in the unavailable-image state too", async () => {
    const onStartOver = vi.fn();
    render(<ReorganiseResult generateResult={makeUnavailableResult()} items={items} originalImageUrl={null} onStartOver={onStartOver} />);
    await userEvent.click(screen.getByRole("button", { name: /start over/i }));
    expect(onStartOver).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deterministic_direct — what the user actually sees in production
//
// Production calls no LLM planner, so the technical disclosure must show
// that honestly: zero attempts, no model named, and no issue list implying
// a failed attempt that never happened.
// ---------------------------------------------------------------------------

describe("ReorganiseResult — deterministic_direct planning", () => {
  function directResult(overrides = {}) {
    return makeGeneratedResult({
      planning: makePlanning({
        provenance: "deterministic_direct",
        attempts: 0,
        issues: [],
        model_name: null,
        prompt_version: null,
        ...overrides,
      }),
    });
  }

  test("renders the provenance and a zero attempt count truthfully", () => {
    render(<ReorganiseResult generateResult={directResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    expect(screen.getByText("deterministic_direct")).toBeInTheDocument();
    const attempts = screen.getByText("Attempts").closest("div");
    expect(attempts).toHaveTextContent("0");
  });

  test("shows no model or prompt version, rather than inventing one", () => {
    render(<ReorganiseResult generateResult={directResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    expect(screen.getByText("Model").closest("div")).toHaveTextContent("—");
    expect(screen.getByText("Prompt version").closest("div")).toHaveTextContent("—");
    expect(screen.queryByText("phi4-mini")).not.toBeInTheDocument();
  });

  test("renders no planning-issues section, since no attempt was made to fail", () => {
    render(<ReorganiseResult generateResult={directResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    expect(screen.queryByText(/issues encountered while planning/i)).not.toBeInTheDocument();
  });

  test("still renders the full plan and the planning duration", () => {
    render(<ReorganiseResult generateResult={directResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    expect(screen.getByText("Keep in place")).toBeInTheDocument();
    expect(screen.getByText(/planning duration/i)).toBeInTheDocument();
    expect(screen.getByText("0.01s")).toBeInTheDocument();
  });

  test("keeps the technical detail collapsed by default, like every other provenance", () => {
    render(<ReorganiseResult generateResult={directResult()} items={items} originalImageUrl={null} onStartOver={vi.fn()} />);
    expect(screen.getByText("Planning details").closest("details")).not.toHaveAttribute("open");
  });
});
