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
    stage_timings: [{ stage: "reorganise_plan", duration_ms: 12.3 }],
    ...overrides,
  };
}

function makeGeneratedResponse(overrides = {}) {
  return {
    run_id: "run1",
    planning: makePlanning(),
    image_status: "generated",
    image: makeGeneratedImage(),
    image_unavailable_reason: null,
    ...overrides,
  };
}

function makeUnavailableResponse(reason = "service_unreachable", overrides = {}) {
  return {
    run_id: "run1",
    planning: makePlanning(),
    image_status: "unavailable",
    image: null,
    image_unavailable_reason: reason,
    ...overrides,
  };
}

const OPTS = { runId: "run1", selectedItemIds: ["item_001", "item_002"], inputImageSha256: HASH_B };

describe("normaliseGenerateResponse, generated", () => {
  test("accepts a valid generated response", () => {
    const result = normaliseGenerateResponse(makeGeneratedResponse(), OPTS);
    expect(result.imageStatus).toBe("generated");
    expect(result.image).toBeTruthy();
    expect(result.imageUnavailableReason).toBeNull();
  });

  test("rejects run_id mismatch", () => {
    expect(() => normaliseGenerateResponse(makeGeneratedResponse({ run_id: "other" }), OPTS)).toThrow(/run_id/);
  });

  test("rejects planning.run_id mismatch", () => {
    const bad = makeGeneratedResponse();
    bad.planning.run_id = "other";
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/planning\.run_id/);
  });

  test("rejects zones that is not an array", () => {
    const bad = makeGeneratedResponse();
    bad.planning.plan.zones = "nope";
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/zones/);
  });

  test("rejects an empty zone_name", () => {
    const bad = makeGeneratedResponse();
    bad.planning.plan.zones[0].zone_name = "";
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/zone_name/);
  });

  test("rejects an empty instruction", () => {
    const bad = makeGeneratedResponse();
    bad.planning.plan.zones[0].instruction = "  ";
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/instruction/);
  });

  test("rejects an empty zone item_ids array", () => {
    const bad = makeGeneratedResponse();
    bad.planning.plan.zones[0].item_ids = [];
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/item_ids/);
  });

  test("rejects a missing selected item_id (plan omits it)", () => {
    const bad = makeGeneratedResponse();
    bad.planning.plan.zones[0].item_ids = ["item_001"]; // item_002 missing
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/omits/);
  });

  test("rejects an unexpected planned item_id (not in the selection)", () => {
    const bad = makeGeneratedResponse();
    bad.planning.plan.zones[0].item_ids = ["item_001", "item_002", "item_999"];
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/unselected/);
  });

  test("rejects a duplicate planned item_id across zones", () => {
    const bad = makeGeneratedResponse();
    bad.planning.plan.zones = [
      { zone_name: "A", item_ids: ["item_001"], instruction: "x" },
      { zone_name: "B", item_ids: ["item_001", "item_002"], instruction: "y" },
    ];
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/duplicate/);
  });

  test("rejects an empty image_prompt", () => {
    const bad = makeGeneratedResponse();
    bad.planning.plan.image_prompt = "";
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/image_prompt/);
  });

  test("rejects a non-string, non-null negative_prompt", () => {
    const bad = makeGeneratedResponse();
    bad.planning.plan.negative_prompt = 5;
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/negative_prompt/);
  });

  test("accepts a string negative_prompt", () => {
    const ok = makeGeneratedResponse();
    ok.planning.plan.negative_prompt = "blurry";
    expect(() => normaliseGenerateResponse(ok, OPTS)).not.toThrow();
  });

  test("rejects an unrecognised provenance", () => {
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse({ planning: makePlanning({ provenance: "made_up" }) }), OPTS)
    ).toThrow(/provenance/);
  });

  test("rejects attempts outside {1,2}", () => {
    expect(() =>
      normaliseGenerateResponse(makeGeneratedResponse({ planning: makePlanning({ attempts: 3 }) }), OPTS)
    ).toThrow(/attempts/);
  });

  test("rejects issues that is not an array", () => {
    const bad = makeGeneratedResponse();
    bad.planning.issues = "nope";
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/issues/);
  });

  test("rejects stage_timings that is not an array", () => {
    const bad = makeGeneratedResponse();
    bad.planning.stage_timings = "nope";
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/stage_timings/);
  });

  test("rejects model_name present with prompt_version null", () => {
    const bad = makeGeneratedResponse({ planning: makePlanning({ model_name: "phi4-mini", prompt_version: null }) });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/model_name/);
  });

  test("accepts both model_name and prompt_version null (deterministic fallback, both calls failed)", () => {
    const ok = makeGeneratedResponse({
      planning: makePlanning({ provenance: "deterministic_fallback", attempts: 2, model_name: null, prompt_version: null }),
    });
    expect(() => normaliseGenerateResponse(ok, OPTS)).not.toThrow();
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

  test("the complete plan is still validated and present even when unavailable", () => {
    const result = normaliseGenerateResponse(makeUnavailableResponse(), OPTS);
    expect(result.planning.plan.zones).toHaveLength(1);
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

describe("normaliseGenerateResponse, negative_prompt strictness", () => {
  test("rejects an empty-string negative_prompt (must be null or non-empty)", () => {
    const bad = makeGeneratedResponse();
    bad.planning.plan.negative_prompt = "   ";
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/negative_prompt/);
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

describe("normaliseGenerateResponse, planning.issues field validation", () => {
  test("rejects an issue with an invalid attempt", () => {
    const bad = makeGeneratedResponse({
      planning: makePlanning({
        provenance: "recovery_used",
        attempts: 2,
        issues: [{ attempt: "middle", kind: "invalid_json", detail: "x", conversion_errors: [] }],
      }),
    });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/issues\[0\]\.attempt/);
  });

  test("rejects an issue with an unrecognised kind", () => {
    const bad = makeGeneratedResponse({
      planning: makePlanning({
        provenance: "recovery_used",
        attempts: 2,
        issues: [{ attempt: "initial", kind: "made_up_kind", detail: "x", conversion_errors: [] }],
      }),
    });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/issues\[0\]\.kind/);
  });

  test("rejects an issue with a blank detail", () => {
    const bad = makeGeneratedResponse({
      planning: makePlanning({
        provenance: "recovery_used",
        attempts: 2,
        issues: [{ attempt: "initial", kind: "invalid_json", detail: "  ", conversion_errors: [] }],
      }),
    });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/issues\[0\]\.detail/);
  });

  test("rejects an issue whose conversion_errors is not an array", () => {
    const bad = makeGeneratedResponse({
      planning: makePlanning({
        provenance: "recovery_used",
        attempts: 2,
        issues: [{ attempt: "initial", kind: "semantic_invalid", detail: "x", conversion_errors: "nope" }],
      }),
    });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/conversion_errors/);
  });

  test("accepts a well-formed issue", () => {
    const ok = makeGeneratedResponse({
      planning: makePlanning({
        provenance: "recovery_used",
        attempts: 2,
        issues: [{ attempt: "initial", kind: "semantic_invalid", detail: "missing item", conversion_errors: [{ kind: "missing_selected_items", detail: "x", item_ids: ["item_001"] }] }],
      }),
    });
    expect(() => normaliseGenerateResponse(ok, OPTS)).not.toThrow();
  });
});

describe("normaliseGenerateResponse, the single reorganise_plan stage timing", () => {
  test("rejects zero stage timings", () => {
    const bad = makeGeneratedResponse({ planning: makePlanning({ stage_timings: [] }) });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/stage_timings/);
  });

  test("rejects more than one stage timing", () => {
    const bad = makeGeneratedResponse({
      planning: makePlanning({
        stage_timings: [
          { stage: "reorganise_plan", duration_ms: 5 },
          { stage: "reorganise_plan", duration_ms: 6 },
        ],
      }),
    });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/stage_timings/);
  });

  test("rejects a stage timing with the wrong stage name", () => {
    const bad = makeGeneratedResponse({ planning: makePlanning({ stage_timings: [{ stage: "detect_objects", duration_ms: 5 }] }) });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/stage_timings\[0\]\.stage/);
  });

  test("rejects a negative or non-finite duration_ms", () => {
    const bad = makeGeneratedResponse({ planning: makePlanning({ stage_timings: [{ stage: "reorganise_plan", duration_ms: -1 }] }) });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/duration_ms/);
  });

  test("accepts exactly one well-formed reorganise_plan timing", () => {
    const ok = makeGeneratedResponse({ planning: makePlanning({ stage_timings: [{ stage: "reorganise_plan", duration_ms: 12.3 }] }) });
    expect(() => normaliseGenerateResponse(ok, OPTS)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// normaliseConfirmedGenerateResponse (R6, Both)
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

// The plan reflects ONLY the server-derived confirmed Keep set
// (["item_001"]), never the full expected_item_ids or any client-supplied
// selection, there is no selection field in the /generate/confirmed
// request at all (see api/client.js's generateConfirmedReorganisation).
function makeConfirmedGenerateResponse(overrides = {}) {
  return {
    run_id: "run1",
    confirmation: makeConfirmationResponse(),
    planning: makePlanning({
      plan: {
        zones: [{ zone_name: "Keep in place", item_ids: ["item_001"], instruction: "keep as is" }],
        image_prompt: "a tidy bedroom",
        negative_prompt: null,
      },
    }),
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
    expect(result.planning.plan.zones[0].item_ids).toEqual(["item_001"]);
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
    // The server now reports item_002 as Keep too, but the client's own
    // earlier /confirm call only ever reported item_001. Otherwise fully
    // internally consistent (satisfies normaliseConfirmationResponse's
    // own checks), so this specifically exercises the drift check.
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
    bad.planning.plan.zones[0].item_ids = ["item_001", "item_002"];
    expect(() =>
      normaliseConfirmedGenerateResponse(bad, { ...CONFIRMED_OPTS, priorConfirmedKeepIds: ["item_001"] })
    ).toThrow(/confirmed_keep_ids/);
  });

  test("rejects a priorConfirmedKeepIds in a different order than the response, even with the same set", () => {
    // The response's own confirmed_keep_ids is internally pinned to
    // confirmed_decisions order (itself pinned to expected_item_ids
    // order, see confirmationContract.js), ["item_001", "item_002"] is
    // the only internally-valid order for "both kept". A caller-supplied
    // priorConfirmedKeepIds in a different order (however it got that
    // way) must still be rejected, the cross-check is order-sensitive,
    // not just set-equality.
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
    bothKeep.planning.plan.zones[0].item_ids = ["item_001", "item_002"];
    expect(() =>
      normaliseConfirmedGenerateResponse(bothKeep, { ...CONFIRMED_OPTS, priorConfirmedKeepIds: ["item_002", "item_001"] })
    ).toThrow(/confirmed_keep_ids/);
  });

  test("rejects a plan that doesn't exactly match the server-derived confirmed Keep set", () => {
    const bad = makeConfirmedGenerateResponse();
    bad.planning.plan.zones[0].item_ids = ["item_001", "item_002"]; // item_002 was never confirmed Keep
    expect(() => normaliseConfirmedGenerateResponse(bad, CONFIRMED_OPTS)).toThrow(/unselected/);
  });

  test("rejects a plan that omits a confirmed Keep item", () => {
    const bad = makeConfirmedGenerateResponse({
      confirmation: makeConfirmationResponse({ confirmed_keep_ids: ["item_001"] }),
    });
    bad.planning.plan.zones[0].item_ids = []; // will fail on empty item_ids first, use a different zone instead
    bad.planning.plan.zones = [{ zone_name: "Elsewhere", item_ids: ["item_002"], instruction: "n/a" }];
    expect(() => normaliseConfirmedGenerateResponse(bad, CONFIRMED_OPTS)).toThrow(/omits/);
  });

  test("a plan-preserving unavailable result is a successful, fully validated result", () => {
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

// ---------------------------------------------------------------------------
// deterministic_direct, the production provenance
//
// Production calls no LLM planner for Reorganise, so the response reports
// zero attempts, no issues and no model identity. The contract accepts
// exactly that shape and rejects any response that mixes it with evidence
// of an LLM call that never happened.
// ---------------------------------------------------------------------------

function makeDirectPlanning(overrides = {}) {
  return makePlanning({
    provenance: "deterministic_direct",
    attempts: 0,
    issues: [],
    model_name: null,
    prompt_version: null,
    ...overrides,
  });
}

describe("reorganiseContract, deterministic_direct", () => {
  test("accepts the production shape: zero attempts, no issues, null metadata", () => {
    const ok = makeGeneratedResponse({ planning: makeDirectPlanning() });
    expect(() => normaliseGenerateResponse(ok, OPTS)).not.toThrow();
  });

  test("normalises to a usable result with the provenance preserved", () => {
    const result = normaliseGenerateResponse(makeGeneratedResponse({ planning: makeDirectPlanning() }), OPTS);
    expect(result.planning.provenance).toBe("deterministic_direct");
    expect(result.planning.attempts).toBe(0);
    expect(result.planning.issues).toEqual([]);
    expect(result.planning.model_name).toBeNull();
    expect(result.planning.prompt_version).toBeNull();
  });

  test("accepts it on the Both (/generate/confirmed) contract too", () => {
    // Both's plan covers only the server-derived confirmed Keep set.
    const ok = makeConfirmedGenerateResponse({
      planning: makeDirectPlanning({
        plan: {
          zones: [{ zone_name: "Keep in place", item_ids: ["item_001"], instruction: "keep as is" }],
          image_prompt: "a tidy bedroom",
          negative_prompt: null,
        },
      }),
    });
    expect(() => normaliseConfirmedGenerateResponse(ok, CONFIRMED_OPTS)).not.toThrow();
  });

  test("still requires an unavailable image result to normalise cleanly", () => {
    const ok = makeUnavailableResponse("service_unreachable", { planning: makeDirectPlanning() });
    expect(() => normaliseGenerateResponse(ok, OPTS)).not.toThrow();
  });

  // --- contradictory combinations are rejected ---------------------------

  test.each([1, 2])("rejects deterministic_direct claiming %i attempt(s)", (attempts) => {
    const bad = makeGeneratedResponse({ planning: makeDirectPlanning({ attempts }) });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/attempts must be 0 for deterministic_direct/);
  });

  test("rejects deterministic_direct carrying a failed-attempt issue", () => {
    const bad = makeGeneratedResponse({
      planning: makeDirectPlanning({
        issues: [{ attempt: "initial", kind: "invalid_json", detail: "did not happen", conversion_errors: [] }],
      }),
    });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/issues to be empty/);
  });

  test("rejects deterministic_direct naming a model", () => {
    const bad = makeGeneratedResponse({
      planning: makeDirectPlanning({ model_name: "phi4-mini", prompt_version: "v1" }),
    });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/no model was called/);
  });

  // --- the other provenances keep their existing attempt rules -----------

  test.each(["raw_valid", "mechanically_repaired", "recovery_used", "deterministic_fallback"])(
    "%s still rejects zero attempts",
    (provenance) => {
      const bad = makeGeneratedResponse({ planning: makePlanning({ provenance, attempts: 0 }) });
      expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/attempts must be 1 or 2/);
    }
  );

  test.each([
    ["raw_valid", 1],
    ["mechanically_repaired", 1],
    ["recovery_used", 2],
  ])("%s still accepts its real attempt count of %i", (provenance, attempts) => {
    const ok = makeGeneratedResponse({ planning: makePlanning({ provenance, attempts }) });
    expect(() => normaliseGenerateResponse(ok, OPTS)).not.toThrow();
  });

  test("an unrecognised provenance is still rejected", () => {
    const bad = makeGeneratedResponse({ planning: makePlanning({ provenance: "deterministic_directish" }) });
    expect(() => normaliseGenerateResponse(bad, OPTS)).toThrow(/provenance/);
  });
});
