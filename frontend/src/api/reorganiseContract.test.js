import { describe, expect, test } from "vitest";
import {
  normaliseConfirmedGenerateResponse,
  normaliseGenerateResponse,
  normaliseReorganiseUploadResponse,
} from "./reorganiseContract";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

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

function makeUploadResponse(overrides = {}) {
  return {
    run_id: "run1",
    path: "reorganise",
    analysis: {
      run_id: "run1",
      scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
      items: [makeItem()],
      warnings: [],
      stage_timings: [],
    },
    input_image_sha256: HASH_A,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normaliseReorganiseUploadResponse
// ---------------------------------------------------------------------------

describe("normaliseReorganiseUploadResponse", () => {
  test("accepts a valid response and returns the normalised shape", () => {
    const result = normaliseReorganiseUploadResponse(makeUploadResponse());
    expect(result.runId).toBe("run1");
    expect(result.inputImageSha256).toBe(HASH_A);
    expect(result.items).toHaveLength(1);
    expect(result.analysis.items).toBe(result.items);
  });

  test("rejects a non-object response", () => {
    expect(() => normaliseReorganiseUploadResponse(null)).toThrow(/must be an object/);
    expect(() => normaliseReorganiseUploadResponse("nope")).toThrow(/must be an object/);
  });

  test("rejects the wrong path", () => {
    expect(() => normaliseReorganiseUploadResponse(makeUploadResponse({ path: "declutter" }))).toThrow(/path/);
  });

  test("rejects an empty run_id", () => {
    expect(() => normaliseReorganiseUploadResponse(makeUploadResponse({ run_id: "" }))).toThrow(/run_id/);
  });

  test("rejects analysis.run_id mismatch", () => {
    const bad = makeUploadResponse();
    bad.analysis.run_id = "different-run";
    expect(() => normaliseReorganiseUploadResponse(bad)).toThrow(/run_id/);
  });

  test("rejects a malformed input_image_sha256", () => {
    expect(() => normaliseReorganiseUploadResponse(makeUploadResponse({ input_image_sha256: "not-hex" }))).toThrow(
      /input_image_sha256/
    );
  });

  test("rejects duplicate item_id", () => {
    const bad = makeUploadResponse();
    bad.analysis.items = [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_001" })];
    expect(() => normaliseReorganiseUploadResponse(bad)).toThrow(/duplicate/);
  });

  test("duplicate LABELS with distinct item_id remain legal and separate", () => {
    const bad = makeUploadResponse();
    bad.analysis.items = [
      makeItem({ item_id: "item_001", clean_label: "picture frame", effective_label: "picture frame" }),
      makeItem({ item_id: "item_002", clean_label: "picture frame", effective_label: "picture frame" }),
    ];
    const result = normaliseReorganiseUploadResponse(bad);
    expect(result.items.map((i) => i.item_id)).toEqual(["item_001", "item_002"]);
  });

  test("rejects an item missing a required field", () => {
    const bad = makeUploadResponse();
    bad.analysis.items = [makeItem({ clean_label: undefined })];
    expect(() => normaliseReorganiseUploadResponse(bad)).toThrow(/clean_label/);
  });

  test("rejects a malformed box", () => {
    const bad = makeUploadResponse();
    bad.analysis.items = [makeItem({ box: { x1: 0.1, y1: 0.1 } })];
    expect(() => normaliseReorganiseUploadResponse(bad)).toThrow(/box/);
  });

  test("rejects analysis.items that is not an array", () => {
    const bad = makeUploadResponse();
    bad.analysis.items = "not-an-array";
    expect(() => normaliseReorganiseUploadResponse(bad)).toThrow(/analysis\.items/);
  });
});

// ---------------------------------------------------------------------------
// normaliseGenerateResponse
// ---------------------------------------------------------------------------

function makeGeneratedImage(overrides = {}) {
  return {
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
    generation_ms: 1234.5,
    prompt_sha256: HASH_A,
    input_image_sha256: HASH_B,
    ...overrides,
  };
}

function makeAction(overrides = {}) {
  return {
    priority: 1,
    title: "Clear the desk",
    instruction: "Group the lamp and the book together on the desk.",
    ...overrides,
  };
}

function makeActionPlan(overrides = {}) {
  return {
    run_id: "run1",
    actions: [makeAction(), makeAction({ priority: 2, title: "Straighten the lamp" })],
    provenance: "llm_generated",
    attempts: 1,
    model_name: "phi4-mini",
    prompt_version: "reorganise-actions-v1",
    was_repaired: false,
    duration_ms: 12.3,
    issues: [],
    ...overrides,
  };
}

function makeFocusArea(overrides = {}) {
  return { area_id: "left", label: "Left side", item_ids: ["item_001", "item_002"], ...overrides };
}

function makeSuggestion(overrides = {}) {
  return {
    name: "Bookends or a compact shelf",
    reason: "Stands 2 books or papers (book x2) upright so they stay visible instead of piling up.",
    related_item_ids: ["item_001", "item_002"],
    ...overrides,
  };
}

function makeGeneratedResponse(overrides = {}) {
  return {
    run_id: "run1",
    action_plan: makeActionPlan(),
    tidy_plan: { phases: [{ phase_id: "empty_clean", title: "Empty and clean", steps: [{ step_id: "empty_clean-1", text: "Clear the main surface.", item_ids: ["item_001"] }] }] },
    focus_areas: [makeFocusArea()],
    storage_suggestions: [],
    image_prompt: "A tidy, well-organised bedroom.",
    image_status: "generated",
    image: makeGeneratedImage(),
    image_unavailable_reason: null,
    ...overrides,
  };
}

function makeUnavailableResponse(reason = "service_unreachable", overrides = {}) {
  return {
    ...makeGeneratedResponse(),
    image_status: "unavailable",
    image: null,
    image_unavailable_reason: reason,
    ...overrides,
  };
}

const OPTS = { runId: "run1", selectedItemIds: ["item_001", "item_002"], inputImageSha256: HASH_B };

describe("normaliseGenerateResponse, generated", () => {
  test("accepts a valid generated response and returns the normalised shape", () => {
    const result = normaliseGenerateResponse(makeGeneratedResponse(), OPTS);
    expect(result.runId).toBe("run1");
    expect(result.actionPlan.actions).toHaveLength(2);
    expect(result.tidyPlan.phases[0].title).toBe("Empty and clean");
    expect(result.focusAreas).toHaveLength(1);
    expect(result.storageSuggestions).toEqual([]);
    expect(result.imagePrompt).toBe("A tidy, well-organised bedroom.");
    expect(result.imageStatus).toBe("generated");
    expect(result.image).toBeTruthy();
    expect(result.imageUnavailableReason).toBeNull();
    expect(result).not.toHaveProperty("planning");
  });

  test("rejects run_id mismatch", () => {
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ run_id: "other" }), OPTS)).toThrow(/run_id/);
  });

  test("rejects a missing or non-object action_plan", () => {
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ action_plan: undefined }), OPTS)).toThrow(/action_plan/);
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ action_plan: "nope" }), OPTS)).toThrow(/action_plan/);
  });

  test("rejects an old zone-plan shaped response outright", () => {
    const legacy = makeGeneratedResponse();
    delete legacy.action_plan;
    legacy.planning = { run_id: "run1", plan: { zones: [] } };
    expect(() => normaliseGenerateResponse(legacy, OPTS)).toThrow(/action_plan/);
  });

  test("rejects an empty image_prompt", () => {
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ image_prompt: " " }), OPTS)).toThrow(/image_prompt/);
  });

  test("rejects image_status generated with a non-null image_unavailable_reason", () => {
    const bad = makeGeneratedResponse({ image_unavailable_reason: "timeout" });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/image_unavailable_reason/);
  });

  test("rejects a null image when image_status is generated", () => {
    const bad = makeGeneratedResponse({ image: null });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/image/);
  });

  describe("generated image field validation", () => {
    test("rejects an unsupported media type", () => {
      const bad = makeGeneratedResponse({ image: makeGeneratedImage({ image_media_type: "image/gif" }) });
      expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/image_media_type/);
    });

    test("rejects depth_map_used !== true", () => {
      const bad = makeGeneratedResponse({ image: makeGeneratedImage({ depth_map_used: false }) });
      expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/depth_map_used/);
    });

    test("rejects malformed base64 image data", () => {
      const bad = makeGeneratedResponse({ image: makeGeneratedImage({ image: "not valid base64!!!" }) });
      expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/image\.image/);
    });

    test("rejects an empty image string", () => {
      const bad = makeGeneratedResponse({ image: makeGeneratedImage({ image: "" }) });
      expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/image\.image/);
    });

    test.each([-0.1, 1.1, NaN, Infinity])("rejects denoise_strength %s out of [0,1]", (value) => {
      const bad = makeGeneratedResponse({ image: makeGeneratedImage({ denoise_strength: value }) });
      expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/denoise_strength/);
    });

    test.each([0, -1, 2.1, NaN])("rejects controlnet_conditioning_scale %s out of (0,2]", (value) => {
      const bad = makeGeneratedResponse({ image: makeGeneratedImage({ controlnet_conditioning_scale: value }) });
      expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/controlnet_conditioning_scale/);
    });

    test.each([true, false, -1, 2 ** 32, 3.5])("rejects seed %s", (value) => {
      const bad = makeGeneratedResponse({ image: makeGeneratedImage({ seed: value }) });
      expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/seed/);
    });

    test.each([-1, NaN, Infinity, -Infinity])("rejects generation_ms %s", (value) => {
      const bad = makeGeneratedResponse({ image: makeGeneratedImage({ generation_ms: value }) });
      expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/generation_ms/);
    });

    test("rejects a malformed prompt_sha256", () => {
      const bad = makeGeneratedResponse({ image: makeGeneratedImage({ prompt_sha256: "not-hex" }) });
      expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/prompt_sha256/);
    });

    test("rejects an image.input_image_sha256 that does not match the upload-provided hash", () => {
      const bad = makeGeneratedResponse({ image: makeGeneratedImage({ input_image_sha256: HASH_A }) }); // OPTS expects HASH_B
      expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/input_image_sha256/);
    });
  });
});

describe("tidy_plan contract", () => {
  function badPlan(change) {
    const plan = structuredClone(makeGeneratedResponse().tidy_plan);
    change(plan);
    return makeGeneratedResponse({ tidy_plan: plan });
  }

  test("rejects absent, extra and malformed plan fields", () => {
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ tidy_plan: undefined }), OPTS)).toThrow(/tidy_plan/);
    expect(() => normaliseGenerateResponse(badPlan((p) => { p.extra = true; }), OPTS)).toThrow(/exactly the keys/);
    expect(() => normaliseGenerateResponse(badPlan((p) => { p.phases = []; }), OPTS)).toThrow(/1..5/);
    expect(() => normaliseGenerateResponse(badPlan((p) => { p.phases[0].steps = []; }), OPTS)).toThrow(/1..6/);
  });

  test("rejects phase order, repeats and title drift", () => {
    expect(() => normaliseGenerateResponse(badPlan((p) => { p.phases[0].phase_id = "unknown"; }), OPTS)).toThrow(/phase_id/);
    expect(() => normaliseGenerateResponse(badPlan((p) => { p.phases.push(structuredClone(p.phases[0])); }), OPTS)).toThrow(/PHASE_ORDER/);
    expect(() => normaliseGenerateResponse(badPlan((p) => { p.phases[0].title = "Wrong"; }), OPTS)).toThrow(/title/);
  });

  test("rejects malformed steps and unreviewed IDs", () => {
    expect(() => normaliseGenerateResponse(badPlan((p) => { p.phases[0].steps[0].extra = "x"; }), OPTS)).toThrow(/exactly the keys/);
    expect(() => normaliseGenerateResponse(badPlan((p) => { p.phases[0].steps[0].step_id = "wrong"; }), OPTS)).toThrow(/step_id/);
    expect(() => normaliseGenerateResponse(badPlan((p) => { p.phases[0].steps[0].text = "short"; }), OPTS)).toThrow(/text/);
    expect(() => normaliseGenerateResponse(badPlan((p) => { p.phases[0].steps[0].item_ids = ["item_999"]; }), OPTS)).toThrow(/outside/);
    expect(() => normaliseGenerateResponse(badPlan((p) => { p.phases[0].steps[0].item_ids = ["item_001", "item_001"]; }), OPTS)).toThrow(/duplicate/);
  });

  test("Both accepts a confirmed departing item in the sort phase", () => {
    const response = makeConfirmedGenerateResponse({ tidy_plan: { phases: [
      { phase_id: "sort", title: "Sort", steps: [{ step_id: "sort-1", text: "Set aside to sell: monitor.", item_ids: ["item_002"] }] },
    ] } });
    expect(normaliseConfirmedGenerateResponse(response, CONFIRMED_OPTS).tidyPlan.phases[0].steps[0].item_ids).toEqual(["item_002"]);
  });
});

describe("normaliseGenerateResponse, unavailable", () => {
  test.each(["service_unreachable", "timeout", "request_failed", "service_error", "invalid_response"])(
    "accepts a valid unavailable response with reason %s",
    (reason) => {
      const result = normaliseGenerateResponse(makeUnavailableResponse(reason), OPTS);
      expect(result.imageStatus).toBe("unavailable");
      expect(result.image).toBeNull();
      expect(result.imageUnavailableReason).toBe(reason);
    }
  );

  test("the checklist, focus areas, suggestions and prompt are still validated and present when unavailable", () => {
    const result = normaliseGenerateResponse(
      makeUnavailableResponse("timeout", { storage_suggestions: [makeSuggestion()] }),
      OPTS
    );
    expect(result.actionPlan.actions).toHaveLength(2);
    expect(result.focusAreas).toHaveLength(1);
    expect(result.storageSuggestions).toHaveLength(1);
    expect(result.imagePrompt).toBeTruthy();
  });

  test("an unavailable response is validated as strictly as a generated one", () => {
    const bad = makeUnavailableResponse("timeout", { focus_areas: [makeFocusArea({ item_ids: ["item_999"] })] });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/unselected/);
  });

  test("rejects an unrecognised unavailable reason", () => {
    expect(() => normaliseGenerateResponse(makeUnavailableResponse("made_up_reason"), OPTS)).toThrow(
      /image_unavailable_reason/
    );
  });

  test("rejects a null image_unavailable_reason when unavailable", () => {
    expect(() => normaliseGenerateResponse(makeUnavailableResponse(null), OPTS)).toThrow(/image_unavailable_reason/);
  });

  test("rejects a non-null image when image_status is unavailable", () => {
    const bad = makeUnavailableResponse("timeout", { image: makeGeneratedImage() });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/image/);
  });

  test("never converts an unavailable result into a thrown error on its own", () => {
    expect(() => normaliseGenerateResponse(makeUnavailableResponse("service_error"), OPTS)).not.toThrow();
  });
});

describe("normaliseGenerateResponse, top-level shape", () => {
  test("rejects a non-object response", () => {
    expect(() => normaliseGenerateResponse(null, OPTS)).toThrow(/must be an object/);
  });

  test("rejects an unrecognised image_status", () => {
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ image_status: "pending" }), OPTS)).toThrow(
      /image_status/
    );
  });
});

// ---------------------------------------------------------------------------
// action_plan
// ---------------------------------------------------------------------------

function withPlan(overrides) {
  return makeGeneratedResponse({ action_plan: makeActionPlan(overrides) });
}

describe("normaliseGenerateResponse, action_plan actions", () => {
  test("rejects action_plan.run_id mismatch", () => {
    expect(() => normaliseGenerateResponse(withPlan({ run_id: "other" }), OPTS)).toThrow(/action_plan\.run_id/);
  });

  test("rejects actions that is not an array, empty, or longer than five", () => {
    expect(() => normaliseGenerateResponse(withPlan({ actions: "nope" }), OPTS)).toThrow(/actions must be an array/);
    expect(() => normaliseGenerateResponse(withPlan({ actions: [] }), OPTS)).toThrow(/1\.\.5 entries/);
    const six = [1, 2, 3, 4, 5, 6].map((n) => makeAction({ priority: n }));
    expect(() => normaliseGenerateResponse(withPlan({ actions: six }), OPTS)).toThrow(/1\.\.5 entries/);
  });

  test("accepts one to five well-formed actions", () => {
    expect(() => normaliseGenerateResponse(withPlan({ actions: [makeAction()] }), OPTS)).not.toThrow();
    const five = [1, 2, 3, 4, 5].map((n) => makeAction({ priority: n }));
    expect(() => normaliseGenerateResponse(withPlan({ actions: five }), OPTS)).not.toThrow();
  });

  test.each([
    [[makeAction({ priority: 2 }), makeAction({ priority: 1 })], /priority must be 1/],
    [[makeAction({ priority: 1 }), makeAction({ priority: 3 })], /priority must be 2/],
    [[makeAction({ priority: 1 }), makeAction({ priority: 1 })], /priority must be 2/],
    [[makeAction({ priority: "1" })], /priority must be an integer/],
    [[makeAction({ priority: 1.5 })], /priority must be an integer/],
  ])("rejects out-of-order, gapped, repeated or non-integer priorities (%j)", (actions, pattern) => {
    expect(() => normaliseGenerateResponse(withPlan({ actions }), OPTS)).toThrow(pattern);
  });

  test("rejects blank or oversized titles and instructions", () => {
    expect(() => normaliseGenerateResponse(withPlan({ actions: [makeAction({ title: "  " })] }), OPTS)).toThrow(/title/);
    expect(() => normaliseGenerateResponse(withPlan({ actions: [makeAction({ title: "x".repeat(81) })] }), OPTS)).toThrow(
      /title must be 3\.\.80/
    );
    expect(() => normaliseGenerateResponse(withPlan({ actions: [makeAction({ instruction: "" })] }), OPTS)).toThrow(
      /instruction/
    );
    expect(() =>
      normaliseGenerateResponse(withPlan({ actions: [makeAction({ instruction: "x".repeat(301) })] }), OPTS)
    ).toThrow(/instruction must be 10\.\.300/);
  });

  // Mirrors app.core.reorganise_actions: title 3..80, instruction 10..300,
  // measured after trimming. Exact boundaries on both sides.
  test.each([
    ["title", 2, false],
    ["title", 3, true],
    ["title", 80, true],
    ["title", 81, false],
    ["instruction", 9, false],
    ["instruction", 10, true],
    ["instruction", 300, true],
    ["instruction", 301, false],
  ])("%s of %i trimmed characters is accepted: %s", (field, length, accepted) => {
    const action = makeAction({ [field]: "x".repeat(length) });
    const attempt = () => normaliseGenerateResponse(withPlan({ actions: [action] }), OPTS);
    if (accepted) {
      expect(attempt).not.toThrow();
    } else {
      expect(attempt).toThrow(new RegExp(`${field} must be`));
    }
  });

  test("bounds are measured after trimming, so padding neither rescues a short value nor breaks a full one", () => {
    expect(() => normaliseGenerateResponse(withPlan({ actions: [makeAction({ title: "  ab  " })] }), OPTS)).toThrow(
      /title must be 3\.\.80 characters after trimming, got 2/
    );
    expect(() =>
      normaliseGenerateResponse(withPlan({ actions: [makeAction({ instruction: "   " + "x".repeat(9) + "   " })] }), OPTS)
    ).toThrow(/instruction must be 10\.\.300 characters after trimming, got 9/);
    expect(() => normaliseGenerateResponse(withPlan({ actions: [makeAction({ title: "  " + "x".repeat(80) + "  " })] }), OPTS)).not.toThrow();
    expect(() =>
      normaliseGenerateResponse(withPlan({ actions: [makeAction({ instruction: " " + "x".repeat(300) + " " })] }), OPTS)
    ).not.toThrow();
  });

  test("the same title and instruction bounds apply on the Both contract", () => {
    const short = makeConfirmedGenerateResponse({ action_plan: makeActionPlan({ actions: [makeAction({ instruction: "too short" })] }) });
    expect(() => normaliseConfirmedGenerateResponse(short, CONFIRMED_OPTS)).toThrow(/instruction must be 10\.\.300/);
  });

  test.each([
    ["item_ids", ["item_001"]],
    ["zone_name", "Desk"],
    ["coordinates", [0.1, 0.2]],
    ["product", "a box"],
  ])("rejects an action carrying an extra %s field", (key, value) => {
    expect(() => normaliseGenerateResponse(withPlan({ actions: [makeAction({ [key]: value })] }), OPTS)).toThrow(
      /exactly the keys/
    );
  });

  test("rejects an action missing a field", () => {
    const action = makeAction();
    delete action.instruction;
    expect(() => normaliseGenerateResponse(withPlan({ actions: [action] }), OPTS)).toThrow(/exactly the keys/);
  });
});

describe("normaliseGenerateResponse, action_plan provenance rules", () => {
  test("rejects an unrecognised provenance, including the old zone-planner values", () => {
    for (const provenance of ["made_up", "raw_valid", "mechanically_repaired", "recovery_used"]) {
      expect(() => normaliseGenerateResponse(withPlan({ provenance }), OPTS)).toThrow(/provenance/);
    }
  });

  test("llm_generated requires one attempt, no issues, a model, a prompt version and a boolean was_repaired", () => {
    expect(() => normaliseGenerateResponse(withPlan({ attempts: 0 }), OPTS)).toThrow(/attempts must be 1/);
    expect(() => normaliseGenerateResponse(withPlan({ attempts: 2 }), OPTS)).toThrow(/attempts must be 1/);
    expect(() =>
      normaliseGenerateResponse(withPlan({ issues: [{ kind: "invalid_json", detail: "x" }] }), OPTS)
    ).toThrow(/issues to be empty/);
    expect(() => normaliseGenerateResponse(withPlan({ model_name: null, prompt_version: null }), OPTS)).toThrow(
      /model_name and action_plan\.prompt_version to be non-empty/
    );
    expect(() => normaliseGenerateResponse(withPlan({ was_repaired: null }), OPTS)).toThrow(/was_repaired must be a boolean/);
    expect(() => normaliseGenerateResponse(withPlan({ was_repaired: true }), OPTS)).not.toThrow();
  });

  test("model_name and prompt_version must be both present or both null", () => {
    expect(() => normaliseGenerateResponse(withPlan({ prompt_version: null }), OPTS)).toThrow(/both be non-empty strings or both be null/);
    expect(() => normaliseGenerateResponse(withPlan({ model_name: " " }), OPTS)).toThrow(/both be non-empty strings or both be null/);
  });

  function fallback(overrides = {}) {
    return withPlan({
      provenance: "deterministic_fallback",
      attempts: 1,
      was_repaired: null,
      issues: [{ kind: "invalid_json", detail: "checklist model did not return syntactically valid JSON" }],
      ...overrides,
    });
  }

  test("deterministic_fallback requires one attempt, exactly one issue and a null was_repaired", () => {
    expect(() => normaliseGenerateResponse(fallback(), OPTS)).not.toThrow();
    expect(() => normaliseGenerateResponse(fallback({ attempts: 0 }), OPTS)).toThrow(/attempts must be 1/);
    expect(() => normaliseGenerateResponse(fallback({ attempts: 2 }), OPTS)).toThrow(/attempts must be 1/);
    expect(() => normaliseGenerateResponse(fallback({ issues: [] }), OPTS)).toThrow(/exactly one action_plan issue/);
    expect(() =>
      normaliseGenerateResponse(
        fallback({ issues: [{ kind: "invalid_json", detail: "x" }, { kind: "call_failed", detail: "y" }] }),
        OPTS
      )
    ).toThrow(/exactly one action_plan issue/);
    expect(() => normaliseGenerateResponse(fallback({ was_repaired: false }), OPTS)).toThrow(/was_repaired to be null/);
  });

  test("deterministic_fallback may omit the model only when the call itself failed", () => {
    expect(() =>
      normaliseGenerateResponse(
        fallback({ model_name: null, prompt_version: null, issues: [{ kind: "call_failed", detail: "checklist model call failed: RuntimeError" }] }),
        OPTS
      )
    ).not.toThrow();
    expect(() => normaliseGenerateResponse(fallback({ model_name: null, prompt_version: null }), OPTS)).toThrow(
      /only when the call itself failed/
    );
  });

  test("rejects an issue with an unrecognised kind or blank detail", () => {
    expect(() => normaliseGenerateResponse(fallback({ issues: [{ kind: "semantic_invalid", detail: "x" }] }), OPTS)).toThrow(
      /issues\[0\]\.kind/
    );
    expect(() => normaliseGenerateResponse(fallback({ issues: [{ kind: "invalid_actions", detail: " " }] }), OPTS)).toThrow(
      /issues\[0\]\.detail/
    );
    expect(() => normaliseGenerateResponse(fallback({ issues: "nope" }), OPTS)).toThrow(/issues must be an array/);
  });

  function direct(overrides = {}) {
    return withPlan({
      provenance: "deterministic_direct",
      attempts: 0,
      model_name: null,
      prompt_version: null,
      was_repaired: null,
      issues: [],
      ...overrides,
    });
  }

  test("deterministic_direct accepts zero attempts, no issues, no model, null was_repaired", () => {
    const result = normaliseGenerateResponse(direct(), OPTS);
    expect(result.actionPlan.provenance).toBe("deterministic_direct");
    expect(result.actionPlan.attempts).toBe(0);
  });

  test("deterministic_direct rejects any evidence of a model call that never happened", () => {
    expect(() => normaliseGenerateResponse(direct({ attempts: 1 }), OPTS)).toThrow(/attempts must be 0 for deterministic_direct/);
    expect(() => normaliseGenerateResponse(direct({ model_name: "phi4-mini", prompt_version: "reorganise-actions-v1" }), OPTS)).toThrow(
      /no model was called/
    );
    expect(() =>
      normaliseGenerateResponse(direct({ issues: [{ kind: "call_failed", detail: "did not happen" }] }), OPTS)
    ).toThrow(/issues to be empty/);
    expect(() => normaliseGenerateResponse(direct({ was_repaired: false }), OPTS)).toThrow(/was_repaired to be null/);
  });

  test("rejects a negative or non-finite duration_ms", () => {
    expect(() => normaliseGenerateResponse(withPlan({ duration_ms: -1 }), OPTS)).toThrow(/duration_ms/);
    expect(() => normaliseGenerateResponse(withPlan({ duration_ms: NaN }), OPTS)).toThrow(/duration_ms/);
    expect(() => normaliseGenerateResponse(withPlan({ duration_ms: "5" }), OPTS)).toThrow(/duration_ms/);
  });
});

// ---------------------------------------------------------------------------
// focus_areas
// ---------------------------------------------------------------------------

describe("normaliseGenerateResponse, focus_areas", () => {
  test("accepts up to three count-ordered areas covering selected items", () => {
    const opts = { ...OPTS, selectedItemIds: ["item_001", "item_002", "item_003", "item_004"] };
    const ok = makeGeneratedResponse({
      focus_areas: [
        makeFocusArea({ area_id: "left", item_ids: ["item_001", "item_002"] }),
        makeFocusArea({ area_id: "centre", label: "Centre", item_ids: ["item_003"] }),
        makeFocusArea({ area_id: "right", label: "Right side", item_ids: ["item_004"] }),
      ],
    });
    expect(normaliseGenerateResponse(ok, opts).focusAreas).toHaveLength(3);
  });

  test("rejects a missing, empty or over-long list", () => {
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ focus_areas: undefined }), OPTS)).toThrow(/focus_areas must be an array/);
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ focus_areas: [] }), OPTS)).toThrow(/1\.\.3 entries/);
    const four = ["left", "centre", "right", "other"].map((id) => makeFocusArea({ area_id: id, item_ids: [] }));
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ focus_areas: four }), OPTS)).toThrow(/1\.\.3 entries/);
  });

  test("rejects an unrecognised or duplicated area_id", () => {
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse({ focus_areas: [makeFocusArea({ area_id: "upper-left" })] }), OPTS)
    ).toThrow(/area_id/);
    expect(() =>
      normaliseGenerateResponse(
        makeGeneratedResponse({ focus_areas: [makeFocusArea({ item_ids: ["item_001"] }), makeFocusArea({ item_ids: ["item_002"] })] }),
        OPTS
      )
    ).toThrow(/duplicate focus area/);
  });

  test("rejects an area referencing an unselected item or an item shown twice", () => {
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse({ focus_areas: [makeFocusArea({ item_ids: ["item_001", "item_999"] })] }), OPTS)
    ).toThrow(/unselected/);
    expect(() =>
      normaliseGenerateResponse(
        makeGeneratedResponse({
          focus_areas: [
            makeFocusArea({ area_id: "left", item_ids: ["item_001"] }),
            makeFocusArea({ area_id: "right", label: "Right side", item_ids: ["item_001"] }),
          ],
        }),
        OPTS
      )
    ).toThrow(/duplicate focus area item_id/);
  });

  test("rejects areas that are not ordered by item count, highest first", () => {
    const opts = { ...OPTS, selectedItemIds: ["item_001", "item_002", "item_003"] };
    const bad = makeGeneratedResponse({
      focus_areas: [
        makeFocusArea({ area_id: "left", item_ids: ["item_001"] }),
        makeFocusArea({ area_id: "right", label: "Right side", item_ids: ["item_002", "item_003"] }),
      ],
    });
    expect(() => normaliseGenerateResponse(bad, opts)).toThrow(/highest first/);
  });

  test("rejects an area with an empty item list, a blank label, or an extra field", () => {
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse({ focus_areas: [makeFocusArea({ item_ids: [] })] }), OPTS)
    ).toThrow(/must not be empty/);
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse({ focus_areas: [makeFocusArea({ label: " " })] }), OPTS)
    ).toThrow(/label/);
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse({ focus_areas: [makeFocusArea({ x: 0.2 })] }), OPTS)
    ).toThrow(/exactly the keys/);
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse({ focus_areas: [makeFocusArea({ severity: "high" })] }), OPTS)
    ).toThrow(/exactly the keys/);
  });
});

// ---------------------------------------------------------------------------
// storage_suggestions
// ---------------------------------------------------------------------------

describe("normaliseGenerateResponse, storage_suggestions", () => {
  test("accepts an empty list and up to three well-formed suggestions tied to selected items", () => {
    expect(normaliseGenerateResponse(makeGeneratedResponse(), OPTS).storageSuggestions).toEqual([]);
    const three = makeGeneratedResponse({
      storage_suggestions: [
        makeSuggestion(),
        makeSuggestion({ name: "Compartment tray", related_item_ids: ["item_002"] }),
        makeSuggestion({ name: "Hooks or a hanging organiser", related_item_ids: ["item_001"] }),
      ],
    });
    expect(normaliseGenerateResponse(three, OPTS).storageSuggestions).toHaveLength(3);
  });

  test("rejects a missing list or more than three suggestions", () => {
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ storage_suggestions: undefined }), OPTS)).toThrow(
      /storage_suggestions must be an array/
    );
    const four = ["a", "b", "c", "d"].map((name) => makeSuggestion({ name }));
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ storage_suggestions: four }), OPTS)).toThrow(/at most 3/);
  });

  test("rejects a suggestion referencing an unselected item, no items, or duplicate ids", () => {
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse({ storage_suggestions: [makeSuggestion({ related_item_ids: ["item_999"] })] }), OPTS)
    ).toThrow(/unselected/);
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse({ storage_suggestions: [makeSuggestion({ related_item_ids: [] })] }), OPTS)
    ).toThrow(/must not be empty/);
    expect(() =>
      normaliseGenerateResponse(
        makeGeneratedResponse({ storage_suggestions: [makeSuggestion({ related_item_ids: ["item_001", "item_001"] })] }),
        OPTS
      )
    ).toThrow(/duplicate/);
  });

  test("rejects duplicate names case-insensitively, and blank names or reasons", () => {
    expect(() =>
      normaliseGenerateResponse(
        makeGeneratedResponse({ storage_suggestions: [makeSuggestion(), makeSuggestion({ name: "BOOKENDS OR A COMPACT SHELF" })] }),
        OPTS
      )
    ).toThrow(/duplicate storage suggestion name/);
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse({ storage_suggestions: [makeSuggestion({ name: " " })] }), OPTS)
    ).toThrow(/name/);
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse({ storage_suggestions: [makeSuggestion({ reason: "" })] }), OPTS)
    ).toThrow(/reason/);
  });

  test.each([
    ["price", "9.99"],
    ["url", "https://example.test/box"],
    ["brand", "SomeBrand"],
    ["in_stock", true],
    ["retailer", "a shop"],
  ])("rejects a commercial field (%s) rather than displaying it", (key, value) => {
    const bad = makeGeneratedResponse({ storage_suggestions: [makeSuggestion({ [key]: value })] });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/exactly the keys/);
  });

  test("a missing key is contract drift too", () => {
    const suggestion = makeSuggestion();
    delete suggestion.reason;
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ storage_suggestions: [suggestion] }), OPTS)).toThrow(
      /exactly the keys/
    );
  });
});

// ---------------------------------------------------------------------------
// Correction 2 hardening
// ---------------------------------------------------------------------------

describe("normaliseReorganiseUploadResponse, item_id shape", () => {
  test.each(["item_1", "item_12", "item_abc", "item001", "ITEM_001", ""])(
    "rejects a malformed item_id %s",
    (badId) => {
      const bad = makeUploadResponse();
      bad.analysis.items = [makeItem({ item_id: badId })];
      expect(() => normaliseReorganiseUploadResponse(bad)).toThrow(/item_id/);
    }
  );

  test("accepts item_ids with 3 or more digits", () => {
    const ok = makeUploadResponse();
    ok.analysis.items = [makeItem({ item_id: "item_1234" })];
    expect(() => normaliseReorganiseUploadResponse(ok)).not.toThrow();
  });
});

describe("normaliseReorganiseUploadResponse, item_role", () => {
  test.each(["ACTIONABLE", "keep", "", null, 5])("rejects an invalid item_role %s", (badRole) => {
    const bad = makeUploadResponse();
    bad.analysis.items = [makeItem({ item_role: badRole })];
    expect(() => normaliseReorganiseUploadResponse(bad)).toThrow(/item_role/);
  });

  test("accepts \"actionable\" and \"contextual\"", () => {
    const ok = makeUploadResponse();
    ok.analysis.items = [makeItem({ item_id: "item_001", item_role: "actionable" }), makeItem({ item_id: "item_002", item_role: "contextual" })];
    expect(() => normaliseReorganiseUploadResponse(ok)).not.toThrow();
  });
});

describe("normaliseReorganiseUploadResponse, confidence", () => {
  test.each([-0.1, 1.1, NaN, Infinity, -Infinity, "0.5", null])("rejects an invalid confidence %s", (bad) => {
    const badResponse = makeUploadResponse();
    badResponse.analysis.items = [makeItem({ confidence: bad })];
    expect(() => normaliseReorganiseUploadResponse(badResponse)).toThrow(/confidence/);
  });

  test.each([0, 0.5, 1])("accepts confidence %s within [0,1]", (good) => {
    const ok = makeUploadResponse();
    ok.analysis.items = [makeItem({ confidence: good })];
    expect(() => normaliseReorganiseUploadResponse(ok)).not.toThrow();
  });
});

describe("normaliseReorganiseUploadResponse, box validity", () => {
  test.each([
    { x1: -0.1, y1: 0, x2: 0.5, y2: 0.5 },
    { x1: 0, y1: 0, x2: 1.1, y2: 0.5 },
    { x1: NaN, y1: 0, x2: 0.5, y2: 0.5 },
    { x1: 0, y1: 0, x2: Infinity, y2: 0.5 },
  ])("rejects an out-of-range or non-finite box coordinate %j", (box) => {
    const bad = makeUploadResponse();
    bad.analysis.items = [makeItem({ box })];
    expect(() => normaliseReorganiseUploadResponse(bad)).toThrow(/box/);
  });

  test("rejects a box where x2 does not exceed x1", () => {
    const bad = makeUploadResponse();
    bad.analysis.items = [makeItem({ box: { x1: 0.5, y1: 0.1, x2: 0.5, y2: 0.3 } })];
    expect(() => normaliseReorganiseUploadResponse(bad)).toThrow(/box\.x2/);
  });

  test("rejects an inverted box (x2 < x1)", () => {
    const bad = makeUploadResponse();
    bad.analysis.items = [makeItem({ box: { x1: 0.5, y1: 0.1, x2: 0.1, y2: 0.3 } })];
    expect(() => normaliseReorganiseUploadResponse(bad)).toThrow(/box\.x2/);
  });

  test("rejects a box where y2 does not exceed y1", () => {
    const bad = makeUploadResponse();
    bad.analysis.items = [makeItem({ box: { x1: 0.1, y1: 0.5, x2: 0.3, y2: 0.5 } })];
    expect(() => normaliseReorganiseUploadResponse(bad)).toThrow(/box\.y2/);
  });
});

describe("normaliseGenerateResponse, caller-supplied selectedItemIds", () => {
  test("rejects an empty selectedItemIds", () => {
    expect(() => normaliseGenerateResponse(makeGeneratedResponse(), { ...OPTS, selectedItemIds: [] })).toThrow(
      /selectedItemIds/
    );
  });

  test("rejects a malformed item_id inside selectedItemIds", () => {
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse(), { ...OPTS, selectedItemIds: ["item_001", "not-an-item-id"] })
    ).toThrow(/selectedItemIds/);
  });

  test("rejects duplicate entries inside selectedItemIds", () => {
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse(), { ...OPTS, selectedItemIds: ["item_001", "item_001"] })
    ).toThrow(/selectedItemIds/);
  });
});

describe("normaliseGenerateResponse, generated image api_version exactness", () => {
  test("rejects an api_version that is a non-empty string but not exactly \"v1\"", () => {
    const bad = makeGeneratedResponse({ image: makeGeneratedImage({ api_version: "v2" }) });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/api_version/);
  });
});

describe("normaliseGenerateResponse, base64 length/padding strictness", () => {
  test.each([
    "aGVsbG8", // valid chars, but length not a multiple of 4 (no padding at all)
    "aGVsb=8=", // padding character in the middle
    "aGVsbG8=8", // trailing garbage after padding
    "a===", // excessive/misplaced padding
  ])("rejects malformed base64 %s (wrong length or misplaced padding)", (badImage) => {
    const bad = makeGeneratedResponse({ image: makeGeneratedImage({ image: badImage }) });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/image\.image/);
  });

  test("accepts correctly-padded base64 of every valid padding length", () => {
    for (const validImage of ["aGVsbG8=", "aGVsbG9v", "aGVsbG9vaA=="]) {
      const ok = makeGeneratedResponse({ image: makeGeneratedImage({ image: validImage }) });
      expect(() => normaliseGenerateResponse(ok, OPTS)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// normaliseConfirmedGenerateResponse (Both)
// ---------------------------------------------------------------------------

function makeAiDecision(overrides = {}) {
  return { item_id: "item_001", decision: "keep", reason: "still useful", ...overrides };
}

function makeSourceDeclutter(overrides = {}) {
  return {
    run_id: "run1",
    expected_item_ids: ["item_001", "item_002"],
    ai_decisions: [
      makeAiDecision({ item_id: "item_001", decision: "keep" }),
      makeAiDecision({ item_id: "item_002", decision: "sell", reason: "not needed" }),
    ],
    unresolved_item_ids: [],
    item_validity: { item_001: "raw_valid", item_002: "raw_valid" },
    ...overrides,
  };
}

function makeConfirmedDecision(overrides = {}) {
  return {
    item_id: "item_001",
    ai_decision: "keep",
    confirmed_decision: "keep",
    ai_reason: "still useful",
    user_reason: null,
    excluded: false,
    decision_changed: false,
    ...overrides,
  };
}

function makeConfirmationResponse(overrides = {}) {
  return {
    run_id: "run1",
    confirmed_decisions: [
      makeConfirmedDecision({ item_id: "item_001" }),
      makeConfirmedDecision({
        item_id: "item_002",
        ai_decision: "sell",
        confirmed_decision: "sell",
        ai_reason: "not needed",
      }),
    ],
    confirmed_keep_ids: ["item_001"], // only item_001 is Keep, item_002 is Sell
    decision_changed_count: 0,
    excluded_count: 0,
    ...overrides,
  };
}

// Focus areas and suggestions reflect ONLY the server-derived confirmed
// Keep set (["item_001"]), never the full expected_item_ids or any
// client-supplied selection, there is no selection field in the
// /generate/confirmed request at all (see api/client.js).
function makeConfirmedGenerateResponse(overrides = {}) {
  return {
    run_id: "run1",
    confirmation: makeConfirmationResponse(),
    action_plan: makeActionPlan(),
    tidy_plan: { phases: [{ phase_id: "empty_clean", title: "Empty and clean", steps: [{ step_id: "empty_clean-1", text: "Clear the main surface.", item_ids: ["item_001"] }] }] },
    focus_areas: [makeFocusArea({ item_ids: ["item_001"] })],
    storage_suggestions: [],
    image_prompt: "A tidy, well-organised bedroom.",
    image_status: "generated",
    image: makeGeneratedImage(),
    image_unavailable_reason: null,
    ...overrides,
  };
}

const CONFIRMED_OPTS = {
  runId: "run1",
  sourceDeclutter: makeSourceDeclutter(),
  priorConfirmedKeepIds: ["item_001"],
  inputImageSha256: HASH_B,
};

describe("normaliseConfirmedGenerateResponse", () => {
  test("accepts a valid response and returns confirmation alongside the generation fields", () => {
    const result = normaliseConfirmedGenerateResponse(makeConfirmedGenerateResponse(), CONFIRMED_OPTS);
    expect(result.runId).toBe("run1");
    expect(result.confirmation.confirmedKeepIds).toEqual(["item_001"]);
    expect(result.imageStatus).toBe("generated");
    expect(result.image).toBeTruthy();
    expect(result.actionPlan.actions).toHaveLength(2);
    expect(result.focusAreas[0].item_ids).toEqual(["item_001"]);
    expect(result.storageSuggestions).toEqual([]);
    expect(result.imagePrompt).toBe("A tidy, well-organised bedroom.");
  });

  test("rejects run_id mismatch", () => {
    expect(() =>
      normaliseConfirmedGenerateResponse(makeConfirmedGenerateResponse({ run_id: "other" }), CONFIRMED_OPTS)
    ).toThrow(/run_id/);
  });

  test("rejects a confirmation whose run_id does not match", () => {
    const bad = makeConfirmedGenerateResponse();
    bad.confirmation.run_id = "other";
    expect(() => normaliseConfirmedGenerateResponse(bad, CONFIRMED_OPTS)).toThrow(/run_id/);
  });

  test("rejects a malformed confirmation object outright (reuses normaliseConfirmationResponse's own checks)", () => {
    const bad = makeConfirmedGenerateResponse();
    bad.confirmation.confirmed_decisions = [
      makeConfirmedDecision({ item_id: "item_001" }),
      makeConfirmedDecision({ item_id: "item_001" }), // duplicate, confirmationContract's own check
    ];
    expect(() => normaliseConfirmedGenerateResponse(bad, CONFIRMED_OPTS)).toThrow(/duplicate/);
  });

  test("rejects when the server's confirmed_keep_ids drifts from the prior /confirm result", () => {
    const bad = makeConfirmedGenerateResponse({
      confirmation: makeConfirmationResponse({
        confirmed_keep_ids: ["item_001", "item_002"],
        confirmed_decisions: [
          makeConfirmedDecision({ item_id: "item_001" }),
          makeConfirmedDecision({
            item_id: "item_002",
            ai_decision: "sell",
            confirmed_decision: "keep",
            ai_reason: "not needed",
            decision_changed: true,
          }),
        ],
        decision_changed_count: 1,
      }),
    });
    expect(() =>
      normaliseConfirmedGenerateResponse(bad, { ...CONFIRMED_OPTS, priorConfirmedKeepIds: ["item_001"] })
    ).toThrow(/confirmed_keep_ids/);
  });

  test("rejects a priorConfirmedKeepIds in a different order than the response, even with the same set", () => {
    const bothKeep = makeConfirmedGenerateResponse({
      confirmation: makeConfirmationResponse({
        confirmed_keep_ids: ["item_001", "item_002"],
        confirmed_decisions: [
          makeConfirmedDecision({ item_id: "item_001" }),
          makeConfirmedDecision({
            item_id: "item_002",
            ai_decision: "sell",
            confirmed_decision: "keep",
            ai_reason: "not needed",
            decision_changed: true,
          }),
        ],
        decision_changed_count: 1,
      }),
    });
    expect(() =>
      normaliseConfirmedGenerateResponse(bothKeep, { ...CONFIRMED_OPTS, priorConfirmedKeepIds: ["item_002", "item_001"] })
    ).toThrow(/confirmed_keep_ids/);
  });

  test("rejects a focus area naming an item that was not confirmed Keep", () => {
    const bad = makeConfirmedGenerateResponse({ focus_areas: [makeFocusArea({ item_ids: ["item_001", "item_002"] })] });
    expect(() => normaliseConfirmedGenerateResponse(bad, CONFIRMED_OPTS)).toThrow(/unselected/);
  });

  test("rejects a storage suggestion naming a non-Keep item", () => {
    const bad = makeConfirmedGenerateResponse({
      storage_suggestions: [makeSuggestion({ related_item_ids: ["item_002"] })],
    });
    expect(() => normaliseConfirmedGenerateResponse(bad, CONFIRMED_OPTS)).toThrow(/unselected/);
  });

  test("accepts a storage suggestion tied to the confirmed Keep set", () => {
    const ok = makeConfirmedGenerateResponse({ storage_suggestions: [makeSuggestion({ related_item_ids: ["item_001"] })] });
    expect(normaliseConfirmedGenerateResponse(ok, CONFIRMED_OPTS).storageSuggestions).toHaveLength(1);
  });

  test("validates the action plan the same way normaliseGenerateResponse does (reused, not reimplemented)", () => {
    const bad = makeConfirmedGenerateResponse({ action_plan: makeActionPlan({ attempts: 0 }) });
    expect(() => normaliseConfirmedGenerateResponse(bad, CONFIRMED_OPTS)).toThrow(/attempts must be 1/);
    const missing = makeConfirmedGenerateResponse();
    delete missing.action_plan;
    expect(() => normaliseConfirmedGenerateResponse(missing, CONFIRMED_OPTS)).toThrow(/action_plan/);
  });

  test("a checklist-preserving unavailable result is a successful, fully validated result", () => {
    const response = makeConfirmedGenerateResponse({
      image_status: "unavailable",
      image: null,
      image_unavailable_reason: "service_unreachable",
    });
    const result = normaliseConfirmedGenerateResponse(response, CONFIRMED_OPTS);
    expect(result.imageStatus).toBe("unavailable");
    expect(result.image).toBeNull();
    expect(result.imageUnavailableReason).toBe("service_unreachable");
    expect(result.confirmation.confirmedKeepIds).toEqual(["item_001"]); // confirmation still present
    expect(result.actionPlan.actions).toHaveLength(2);
  });

  test("rejects image_status generated with a non-null image_unavailable_reason", () => {
    const bad = makeConfirmedGenerateResponse({ image_unavailable_reason: "timeout" });
    expect(() => normaliseConfirmedGenerateResponse(bad, CONFIRMED_OPTS)).toThrow(/image_unavailable_reason/);
  });

  test("rejects an unrecognised image_status", () => {
    const bad = makeConfirmedGenerateResponse({ image_status: "pending" });
    expect(() => normaliseConfirmedGenerateResponse(bad, CONFIRMED_OPTS)).toThrow(/image_status/);
  });

  test("validates the generated image the same way normaliseGenerateResponse does (reused, not reimplemented)", () => {
    const bad = makeConfirmedGenerateResponse({ image: makeGeneratedImage({ image_media_type: "image/gif" }) });
    expect(() => normaliseConfirmedGenerateResponse(bad, CONFIRMED_OPTS)).toThrow(/image_media_type/);
  });

  test("rejects a non-object response", () => {
    expect(() => normaliseConfirmedGenerateResponse(null, CONFIRMED_OPTS)).toThrow(/must be an object/);
  });
});
