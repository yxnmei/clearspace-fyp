import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ApiError,
  confirmDecisions,
  generateConfirmedReorganisation,
  generateListings,
  generateReorganisation,
  overrideItem,
  regenerateListing,
  transcribeAudio,
  uploadImage,
} from "./client";

function mockFetchReject(error) {
  const fetchMock = vi.fn().mockRejectedValue(error);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockFetchOnce(responseBody, { ok = true, status = 200 } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirmDecisions", () => {
  test("sends a POST to /confirm", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await confirmDecisions({ runId: "run1", declutter: { run_id: "run1" }, overrides: [] });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/confirm$/);
    expect(options.method).toBe("POST");
  });

  test("sends JSON Content-Type", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await confirmDecisions({ runId: "run1", declutter: { run_id: "run1" }, overrides: [] });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  test("sends the exact {run_id, declutter, overrides} body", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });
    const declutter = { run_id: "run1", expected_item_ids: ["item_001"] };
    const overrides = [{ item_id: "item_001", decision: "donate" }];

    await confirmDecisions({ runId: "run1", declutter, overrides });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ run_id: "run1", declutter, overrides });
  });

  test("preserves the original declutter object's fields, warnings, provenance, validity, timings", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });
    const declutter = {
      run_id: "run1",
      expected_item_ids: ["item_001"],
      ai_decisions: [{ item_id: "item_001", decision: "keep", reason: "x" }],
      unresolved_item_ids: [],
      item_validity: { item_001: "mechanically_repaired" },
      mapping_warnings: [{ kind: "unexpected", detail: "y" }],
      semantic_errors: [],
      recovery_failures: [],
      provenance_warnings: [],
      model_name: "phi4-mini",
      prompt_version: "v2",
      stage_timings: [{ stage: "declutter_llm_classify", duration_ms: 105.5 }],
    };

    await confirmDecisions({ runId: "run1", declutter, overrides: [] });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body).declutter).toEqual(declutter);
  });

  test("defaults overrides to an empty array when omitted", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await confirmDecisions({ runId: "run1", declutter: { run_id: "run1" } });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body).overrides).toEqual([]);
  });

  test("confirmDecisions and overrideItem are genuinely distinct, hitting distinct endpoints", async () => {
    const confirmFetch = mockFetchOnce({ run_id: "run1" });
    await confirmDecisions({ runId: "run1", declutter: { run_id: "run1" }, overrides: [] });
    expect(confirmFetch.mock.calls[0][0]).toMatch(/\/confirm$/);
    expect(confirmFetch.mock.calls.some(([url]) => url.includes("/override"))).toBe(false);

    const overrideFetch = mockFetchOnce({ run_id: "run1" });
    await overrideItem({
      runId: "run1",
      analysis: { run_id: "run1" },
      declutter: { run_id: "run1" },
      itemId: "item_001",
      correctedLabel: "hoodie",
    });
    expect(overrideFetch.mock.calls[0][0]).toMatch(/\/override$/);
    expect(overrideFetch.mock.calls.some(([url]) => url.includes("/confirm"))).toBe(false);
  });
});

describe("overrideItem", () => {
  test("sends a POST to /override", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await overrideItem({
      runId: "run1",
      analysis: { run_id: "run1" },
      declutter: { run_id: "run1" },
      itemId: "item_001",
      correctedLabel: "hoodie",
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/override$/);
    expect(options.method).toBe("POST");
  });

  test("sends JSON Content-Type", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await overrideItem({
      runId: "run1",
      analysis: { run_id: "run1" },
      declutter: { run_id: "run1" },
      itemId: "item_001",
      correctedLabel: "hoodie",
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  test("sends the exact backend field names, mapped from the JS-conventional signature", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });
    const analysis = { run_id: "run1", items: [{ item_id: "item_001" }] };
    const declutter = { run_id: "run1", expected_item_ids: ["item_001"] };

    await overrideItem({
      runId: "run1",
      analysis,
      declutter,
      itemId: "item_001",
      correctedLabel: "hoodie",
      userContext: "downsizing",
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      run_id: "run1",
      analysis,
      declutter,
      item_id: "item_001",
      corrected_label: "hoodie",
      user_context: "downsizing",
    });
  });

  test("defaults user_context to null when omitted", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await overrideItem({
      runId: "run1",
      analysis: { run_id: "run1" },
      declutter: { run_id: "run1" },
      itemId: "item_001",
      correctedLabel: "hoodie",
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body).user_context).toBeNull();
  });

  test("never renames item_id to id, and identifies the target purely by item_id", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await overrideItem({
      runId: "run1",
      analysis: { run_id: "run1" },
      declutter: { run_id: "run1" },
      itemId: "item_004",
      correctedLabel: "hoodie",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.item_id).toBe("item_004");
    expect("id" in body).toBe(false);
  });

  test("a network error propagates rather than being swallowed", async () => {
    mockFetchReject(new TypeError("Failed to fetch"));

    await expect(
      overrideItem({
        runId: "run1",
        analysis: { run_id: "run1" },
        declutter: { run_id: "run1" },
        itemId: "item_001",
        correctedLabel: "hoodie",
      })
    ).rejects.toThrow("Failed to fetch");
  });

  test("a non-ok response exposes structured status and detail with a safe message", async () => {
    mockFetchOnce({ detail: "not an expected item" }, { ok: false, status: 422 });

    await expect(
      overrideItem({
        runId: "run1",
        analysis: { run_id: "run1" },
        declutter: { run_id: "run1" },
        itemId: "item_099",
        correctedLabel: "hoodie",
      })
    ).rejects.toMatchObject({
      name: "ApiError",
      message: "The service could not complete the request. Please try again.",
      status: 422,
      detail: "not an expected item",
    });
  });
});

function makeFile(name = "room.png", type = "image/png", bytes = [137, 80, 78, 71]) {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("uploadImage", () => {
  test("path is path-agnostic, path=\"reorganise\" is sent exactly as given", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1", path: "reorganise" });

    await uploadImage({ file: makeFile(), path: "reorganise", context: null });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/upload$/);
    expect(options.method).toBe("POST");
    const form = options.body;
    expect(form instanceof FormData).toBe(true);
    expect(form.get("path")).toBe("reorganise");
    expect(form.get("image")).toBeTruthy();
    expect(form.has("context")).toBe(false); // null context is omitted, same as Declutter's convention
  });

  test("a non-JSON error body is never copied into the thrown error", async () => {
    const rawBody = "<html>proxy failure: upstream stack trace</html>";
    const text = vi.fn().mockResolvedValue(rawBody);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token '<'")),
        text,
      })
    );

    const error = await uploadImage({ file: makeFile(), path: "declutter", context: null }).catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: "The service could not complete the request. Please try again.",
      status: 502,
      detail: null,
    });
    expect(error.message).not.toContain(rawBody);
    expect(text).not.toHaveBeenCalled();
  });

  test("declutter path is unaffected", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1", path: "declutter" });
    await uploadImage({ file: makeFile(), path: "declutter", context: "some context" });
    const form = fetchMock.mock.calls[0][1].body;
    expect(form.get("path")).toBe("declutter");
    expect(form.get("context")).toBe("some context");
  });
});

describe("generateReorganisation", () => {
  test("sends a POST to /generate with JSON Content-Type", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await generateReorganisation({
      runId: "run1",
      analysis: { run_id: "run1" },
      selectedItemIds: ["item_001"],
      file: makeFile(),
      inputImageSha256: "a".repeat(64),
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/generate$/);
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  test("sends the exact R4 JSON body shape, with no tuning fields", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });
    const analysis = { run_id: "run1", items: [{ item_id: "item_001" }] };

    await generateReorganisation({
      runId: "run1",
      analysis,
      selectedItemIds: ["item_001", "item_002"],
      file: makeFile(),
      inputImageSha256: "a".repeat(64),
      userContext: "downsizing",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Object.keys(body).sort()).toEqual(
      [
        "analysis",
        "image",
        "image_media_type",
        "input_image_sha256",
        "label_corrections",
        "run_id",
        "selected_item_ids",
        "user_context",
      ].sort()
    );
    expect(body.run_id).toBe("run1");
    expect(body.analysis).toEqual(analysis);
    expect(body.selected_item_ids).toEqual(["item_001", "item_002"]);
    expect(body.label_corrections).toEqual([]);
    expect(body.image_media_type).toBe("image/png");
    expect(body.input_image_sha256).toBe("a".repeat(64));
    expect(body.user_context).toBe("downsizing");
    expect(body).not.toHaveProperty("denoise_strength");
    expect(body).not.toHaveProperty("controlnet_conditioning_scale");
    expect(body).not.toHaveProperty("seed");
    expect(body).not.toHaveProperty("kept_item_labels");
  });

  test("sends label corrections as their own field and never edits the analysis", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });
    const analysis = { run_id: "run1", items: [{ item_id: "item_001", clean_label: "rope", corrected_label: null }] };
    const analysisBefore = structuredClone(analysis);
    const labelCorrections = [{ item_id: "item_001", corrected_label: "charger" }];

    await generateReorganisation({
      runId: "run1",
      analysis,
      selectedItemIds: ["item_001"],
      labelCorrections,
      file: makeFile(),
      inputImageSha256: "a".repeat(64),
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.label_corrections).toEqual([{ item_id: "item_001", corrected_label: "charger" }]);
    expect(body.analysis).toEqual(analysisBefore);
    expect(analysis).toEqual(analysisBefore);
  });

  test("the image field is base64 with no data: URL prefix", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await generateReorganisation({
      runId: "run1",
      analysis: { run_id: "run1" },
      selectedItemIds: ["item_001"],
      file: makeFile("room.png", "image/png", [1, 2, 3, 4]),
      inputImageSha256: "a".repeat(64),
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.image.startsWith("data:")).toBe(false);
    expect(body.image).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const decoded = Uint8Array.from(atob(body.image), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual([1, 2, 3, 4]);
  });

  test("sends file.type exactly as image_media_type, png", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });
    await generateReorganisation({
      runId: "run1",
      analysis: { run_id: "run1" },
      selectedItemIds: ["item_001"],
      file: makeFile("room.png", "image/png"),
      inputImageSha256: "a".repeat(64),
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).image_media_type).toBe("image/png");
  });

  test("sends file.type exactly as image_media_type, jpeg", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });
    await generateReorganisation({
      runId: "run1",
      analysis: { run_id: "run1" },
      selectedItemIds: ["item_001"],
      file: makeFile("room.jpg", "image/jpeg"),
      inputImageSha256: "a".repeat(64),
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).image_media_type).toBe("image/jpeg");
  });

  test("defaults user_context to null when omitted", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });
    await generateReorganisation({
      runId: "run1",
      analysis: { run_id: "run1" },
      selectedItemIds: ["item_001"],
      file: makeFile(),
      inputImageSha256: "a".repeat(64),
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).user_context).toBeNull();
  });

  test("rejects an unsupported file type before ever calling fetch", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await expect(
      generateReorganisation({
        runId: "run1",
        analysis: { run_id: "run1" },
        selectedItemIds: ["item_001"],
        file: makeFile("room.webp", "image/webp"),
        inputImageSha256: "a".repeat(64),
      })
    ).rejects.toThrow(/PNG or JPEG/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a non-ok response rejects with structured status and detail", async () => {
    mockFetchOnce({ detail: "invalid reorganise generation request" }, { ok: false, status: 422 });

    await expect(
      generateReorganisation({
        runId: "run1",
        analysis: { run_id: "run1" },
        selectedItemIds: ["item_001"],
        file: makeFile(),
        inputImageSha256: "a".repeat(64),
      })
    ).rejects.toMatchObject({ status: 422, detail: "invalid reorganise generation request" });
  });
});

describe("generateConfirmedReorganisation", () => {
  test("sends a POST to /generate/confirmed with JSON Content-Type", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await generateConfirmedReorganisation({
      runId: "run1",
      analysis: { run_id: "run1" },
      declutter: { run_id: "run1" },
      overrides: [],
      file: makeFile(),
      inputImageSha256: "a".repeat(64),
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/generate\/confirmed$/);
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  test("sends the exact R6 JSON body shape, declutter+overrides, never a selection list", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });
    const analysis = { run_id: "run1", items: [{ item_id: "item_001" }] };
    const declutter = { run_id: "run1", expected_item_ids: ["item_001"] };
    const overrides = [{ item_id: "item_001", decision: "keep" }];

    await generateConfirmedReorganisation({
      runId: "run1",
      analysis,
      declutter,
      overrides,
      file: makeFile(),
      inputImageSha256: "a".repeat(64),
      userContext: "downsizing",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Object.keys(body).sort()).toEqual(
      [
        "analysis",
        "declutter",
        "image",
        "image_media_type",
        "input_image_sha256",
        "overrides",
        "run_id",
        "user_context",
      ].sort()
    );
    expect(body.run_id).toBe("run1");
    expect(body.analysis).toEqual(analysis);
    expect(body.declutter).toEqual(declutter);
    expect(body.overrides).toEqual(overrides);
    expect(body.image_media_type).toBe("image/png");
    expect(body.input_image_sha256).toBe("a".repeat(64));
    expect(body.user_context).toBe("downsizing");
  });

  test("never sends selected_item_ids, confirmed_keep_ids, or any tuning field", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await generateConfirmedReorganisation({
      runId: "run1",
      analysis: { run_id: "run1" },
      declutter: { run_id: "run1" },
      overrides: [],
      file: makeFile(),
      inputImageSha256: "a".repeat(64),
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("selected_item_ids");
    expect(body).not.toHaveProperty("confirmed_keep_ids");
    expect(body).not.toHaveProperty("confirmation");
    expect(body).not.toHaveProperty("denoise_strength");
    expect(body).not.toHaveProperty("controlnet_conditioning_scale");
    expect(body).not.toHaveProperty("seed");
  });

  test("defaults overrides to an empty array and user_context to null when omitted", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await generateConfirmedReorganisation({
      runId: "run1",
      analysis: { run_id: "run1" },
      declutter: { run_id: "run1" },
      file: makeFile(),
      inputImageSha256: "a".repeat(64),
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.overrides).toEqual([]);
    expect(body.user_context).toBeNull();
  });

  test("the image field is base64 with no data: URL prefix", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await generateConfirmedReorganisation({
      runId: "run1",
      analysis: { run_id: "run1" },
      declutter: { run_id: "run1" },
      overrides: [],
      file: makeFile("room.png", "image/png", [1, 2, 3, 4]),
      inputImageSha256: "a".repeat(64),
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.image.startsWith("data:")).toBe(false);
    const decoded = Uint8Array.from(atob(body.image), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual([1, 2, 3, 4]);
  });

  test("rejects an unsupported file type before ever calling fetch", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await expect(
      generateConfirmedReorganisation({
        runId: "run1",
        analysis: { run_id: "run1" },
        declutter: { run_id: "run1" },
        overrides: [],
        file: makeFile("room.webp", "image/webp"),
        inputImageSha256: "a".repeat(64),
      })
    ).rejects.toThrow(/PNG or JPEG/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a non-ok response rejects with structured status and detail", async () => {
    mockFetchOnce({ detail: "no items were confirmed as Keep" }, { ok: false, status: 409 });

    await expect(
      generateConfirmedReorganisation({
        runId: "run1",
        analysis: { run_id: "run1" },
        declutter: { run_id: "run1" },
        overrides: [],
        file: makeFile(),
        inputImageSha256: "a".repeat(64),
      })
    ).rejects.toMatchObject({ status: 409, detail: "no items were confirmed as Keep" });
  });

  test("generateReorganisation and generateConfirmedReorganisation hit distinct endpoints", async () => {
    const directFetch = mockFetchOnce({ run_id: "run1" });
    await generateReorganisation({
      runId: "run1",
      analysis: { run_id: "run1" },
      selectedItemIds: ["item_001"],
      file: makeFile(),
      inputImageSha256: "a".repeat(64),
    });
    expect(directFetch.mock.calls[0][0]).toMatch(/\/generate$/);
    expect(directFetch.mock.calls[0][0]).not.toMatch(/\/generate\/confirmed$/);

    const confirmedFetch = mockFetchOnce({ run_id: "run1" });
    await generateConfirmedReorganisation({
      runId: "run1",
      analysis: { run_id: "run1" },
      declutter: { run_id: "run1" },
      overrides: [],
      file: makeFile(),
      inputImageSha256: "a".repeat(64),
    });
    expect(confirmedFetch.mock.calls[0][0]).toMatch(/\/generate\/confirmed$/);
  });
});

describe("transcribeAudio", () => {
  function audioBlob(type = "audio/webm") {
    return new Blob(["fake audio bytes"], { type });
  }

  test("sends a POST to /transcribe", async () => {
    const fetchMock = mockFetchOnce({ transcript: "tidy the desk" });

    await transcribeAudio({ audioBlob: audioBlob() });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/transcribe$/);
    expect(options.method).toBe("POST");
  });

  test("sends multipart form data under the field name the route expects", async () => {
    const fetchMock = mockFetchOnce({ transcript: "tidy the desk" });
    const blob = audioBlob();

    await transcribeAudio({ audioBlob: blob });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.body).toBeInstanceOf(FormData);
    // The backend route is `audio: UploadFile = File(...)`, any other
    // field name is a 422 there, so this name is the contract.
    expect([...options.body.keys()]).toEqual(["audio"]);
    const sent = options.body.get("audio");
    expect(sent).toBeInstanceOf(Blob);
    expect(sent.size).toBe(blob.size);
  });

  test("carries the blob's own media type, which the backend cross-checks", async () => {
    const fetchMock = mockFetchOnce({ transcript: "" });

    await transcribeAudio({ audioBlob: audioBlob("audio/ogg") });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.body.get("audio").type).toBe("audio/ogg");
  });

  test("sets no Content-Type header, the browser must add the multipart boundary", async () => {
    const fetchMock = mockFetchOnce({ transcript: "tidy the desk" });

    await transcribeAudio({ audioBlob: audioBlob() });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).toBeUndefined();
  });

  test("returns the parsed transcription contract", async () => {
    mockFetchOnce({
      transcript: "tidy the desk",
      model_name: "whisper-base",
      transcription_ms: 812.5,
      audio_duration_s: 3.25,
    });

    const response = await transcribeAudio({ audioBlob: audioBlob() });

    expect(response).toEqual({
      transcript: "tidy the desk",
      model_name: "whisper-base",
      transcription_ms: 812.5,
      audio_duration_s: 3.25,
    });
  });

  test("an empty transcript is a normal response, not an error", async () => {
    mockFetchOnce({ transcript: "", model_name: "whisper-base", transcription_ms: 5, audio_duration_s: 1 });

    await expect(transcribeAudio({ audioBlob: audioBlob() })).resolves.toMatchObject({ transcript: "" });
  });

  test("a non-ok response rejects with status and detail for safe caller routing", async () => {
    mockFetchOnce({ detail: "transcription is busy" }, { ok: false, status: 503 });

    await expect(transcribeAudio({ audioBlob: audioBlob() })).rejects.toMatchObject({
      status: 503,
      detail: "transcription is busy",
    });
  });

  test("a network failure propagates", async () => {
    mockFetchReject(new TypeError("Failed to fetch"));

    await expect(transcribeAudio({ audioBlob: audioBlob() })).rejects.toThrow(/Failed to fetch/);
  });
});

// ---------------------------------------------------------------------------
// generateListings - POST /listings (whole set)
// ---------------------------------------------------------------------------

const LISTING_ANALYSIS = { run_id: "run1", items: [{ item_id: "item_001", effective_label: "lamp" }] };
const LISTING_DECLUTTER = {
  run_id: "run1",
  expected_item_ids: ["item_001"],
  ai_decisions: [{ item_id: "item_001", decision: "sell", reason: "x" }],
  unresolved_item_ids: [],
  item_validity: { item_001: "raw_valid" },
};

describe("generateListings", () => {
  test("POSTs to /listings with a JSON content type", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1", drafts: [] });

    await generateListings({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER, overrides: [] });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/listings$/);
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  test("sends exactly {run_id, analysis, declutter, overrides} and nothing else", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1", drafts: [] });
    const overrides = [{ item_id: "item_001", decision: "sell" }];

    await generateListings({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER, overrides });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      run_id: "run1",
      analysis: LISTING_ANALYSIS,
      declutter: LISTING_DECLUTTER,
      overrides,
      listing_details: [],
    });
    expect(Object.keys(body).sort()).toEqual(["analysis", "declutter", "listing_details", "overrides", "run_id"]);
  });

  test("sends seller-supplied listing details as the structured listing_details field, verbatim", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1", drafts: [] });
    const listingDetails = [
      { item_id: "item_001", listing_name: "Oak desk lamp", condition: "good" },
      { item_id: "item_003", listing_name: null, condition: "not_specified" },
    ];

    await generateListings({
      runId: "run1",
      analysis: LISTING_ANALYSIS,
      declutter: LISTING_DECLUTTER,
      overrides: [],
      listingDetails,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.listing_details).toEqual(listingDetails);
    expect(body).not.toHaveProperty("condition");
    expect(body).not.toHaveProperty("listing_name");
  });

  test("round-trips analysis and declutter whole (fields, validity, timings preserved)", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1", drafts: [] });

    await generateListings({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.analysis).toEqual(LISTING_ANALYSIS);
    expect(body.declutter).toEqual(LISTING_DECLUTTER);
  });

  test("defaults overrides to an empty array when omitted", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1", drafts: [] });

    await generateListings({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).overrides).toEqual([]);
  });

  test("never sends a confirmation, eligible/Sell ids, labels, drafts, image data, user context or model config", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1", drafts: [] });

    await generateListings({
      runId: "run1",
      analysis: LISTING_ANALYSIS,
      declutter: LISTING_DECLUTTER,
      // extras a caller might mistakenly pass - the function must ignore them
      confirmation: { anything: true },
      eligibleItemIds: ["item_001"],
      sellItemIds: ["item_001"],
      drafts: [{ item_id: "item_001" }],
      effectiveLabels: { item_001: "lamp" },
      image: "data",
      userContext: "make it sparkle",
      modelName: "gpt-4",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    for (const forbidden of [
      "confirmation",
      "eligible_item_ids",
      "eligibleItemIds",
      "sell_item_ids",
      "sellItemIds",
      "drafts",
      "effective_labels",
      "effectiveLabels",
      "image",
      "user_context",
      "userContext",
      "model_name",
      "modelName",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  test("a non-ok response rejects with structured status and detail", async () => {
    mockFetchOnce({ detail: "invalid listing request" }, { ok: false, status: 422 });

    await expect(
      generateListings({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER })
    ).rejects.toMatchObject({ status: 422, detail: "invalid listing request" });
  });

  test("a network failure propagates", async () => {
    mockFetchReject(new TypeError("Failed to fetch"));

    await expect(
      generateListings({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER })
    ).rejects.toThrow(/Failed to fetch/);
  });
});

// ---------------------------------------------------------------------------
// regenerateListing - POST /listings/{item_id}/regenerate (one item)
// ---------------------------------------------------------------------------

describe("regenerateListing", () => {
  test("POSTs to the encoded /listings/{item_id}/regenerate path with a JSON content type", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await regenerateListing({
      runId: "run1",
      analysis: LISTING_ANALYSIS,
      declutter: LISTING_DECLUTTER,
      overrides: [],
      itemId: "item_001",
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/listings\/item_001\/regenerate$/);
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  test("encodeURIComponent-encodes the path item id", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await regenerateListing({
      runId: "run1",
      analysis: LISTING_ANALYSIS,
      declutter: LISTING_DECLUTTER,
      itemId: "weird id/with slash",
    });

    expect(fetchMock.mock.calls[0][0]).toContain(`/listings/${encodeURIComponent("weird id/with slash")}/regenerate`);
    expect(fetchMock.mock.calls[0][0]).not.toContain("weird id/with slash");
  });

  test("the body is exactly {run_id, analysis, declutter, overrides} - item id appears ONLY in the path", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });
    const overrides = [{ item_id: "item_001", decision: "sell" }];

    await regenerateListing({
      runId: "run1",
      analysis: LISTING_ANALYSIS,
      declutter: LISTING_DECLUTTER,
      overrides,
      itemId: "item_001",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      run_id: "run1",
      analysis: LISTING_ANALYSIS,
      declutter: LISTING_DECLUTTER,
      overrides,
      listing_details: [],
    });
    expect(body).not.toHaveProperty("item_id");
    expect(body).not.toHaveProperty("itemId");
  });

  test("defaults overrides to an empty array when omitted", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await regenerateListing({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER, itemId: "item_001" });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).overrides).toEqual([]);
  });

  test("never sends a confirmation, eligible ids, labels, drafts, image data, user context or model config", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await regenerateListing({
      runId: "run1",
      analysis: LISTING_ANALYSIS,
      declutter: LISTING_DECLUTTER,
      itemId: "item_001",
      confirmation: { anything: true },
      eligibleItemIds: ["item_001"],
      draft: { item_id: "item_001" },
      image: "data",
      userContext: "x",
      modelName: "gpt-4",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    for (const forbidden of ["confirmation", "eligible_item_ids", "draft", "drafts", "image", "user_context", "model_name"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  test("a blank itemId rejects before ever calling fetch", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await expect(
      regenerateListing({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER, itemId: "   " })
    ).rejects.toThrow(/non-blank string/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a non-string itemId rejects before ever calling fetch", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await expect(
      regenerateListing({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER, itemId: 123 })
    ).rejects.toThrow(/non-blank string/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a missing itemId rejects before ever calling fetch", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1" });

    await expect(
      regenerateListing({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER })
    ).rejects.toThrow(/non-blank string/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a non-ok response rejects with structured status and detail", async () => {
    mockFetchOnce({ detail: "item is not eligible" }, { ok: false, status: 422 });

    await expect(
      regenerateListing({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER, itemId: "item_001" })
    ).rejects.toMatchObject({ status: 422, detail: "item is not eligible" });
  });

  test("a network failure propagates", async () => {
    mockFetchReject(new TypeError("Failed to fetch"));

    await expect(
      regenerateListing({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER, itemId: "item_001" })
    ).rejects.toThrow(/Failed to fetch/);
  });
});

// ---------------------------------------------------------------------------
// batch vs single: distinct endpoints
// ---------------------------------------------------------------------------

describe("listing endpoints are distinct", () => {
  test("generateListings hits /listings, regenerateListing hits /listings/{id}/regenerate", async () => {
    const fetchMock = mockFetchOnce({ run_id: "run1", drafts: [] });

    await generateListings({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER });
    await regenerateListing({ runId: "run1", analysis: LISTING_ANALYSIS, declutter: LISTING_DECLUTTER, itemId: "item_007" });

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/listings$/);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/listings\/item_007\/regenerate$/);
    expect(fetchMock.mock.calls[0][0]).not.toMatch(/regenerate/);
  });
});
