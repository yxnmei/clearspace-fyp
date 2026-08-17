import { afterEach, describe, expect, test, vi } from "vitest";
import { confirmDecisions, generateReorganisation, overrideItem, uploadImage } from "./client";

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

  test("preserves the original declutter object's fields — warnings, provenance, validity, timings", async () => {
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

  test("a non-ok response propagates as a thrown Error, like every other client function", async () => {
    mockFetchOnce({ detail: "not an expected item" }, { ok: false, status: 422 });

    await expect(
      overrideItem({
        runId: "run1",
        analysis: { run_id: "run1" },
        declutter: { run_id: "run1" },
        itemId: "item_099",
        correctedLabel: "hoodie",
      })
    ).rejects.toThrow(/422/);
  });
});

function makeFile(name = "room.png", type = "image/png", bytes = [137, 80, 78, 71]) {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("uploadImage", () => {
  test("path is path-agnostic — path=\"reorganise\" is sent exactly as given", async () => {
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
      ["analysis", "image", "image_media_type", "input_image_sha256", "run_id", "selected_item_ids", "user_context"].sort()
    );
    expect(body.run_id).toBe("run1");
    expect(body.analysis).toEqual(analysis);
    expect(body.selected_item_ids).toEqual(["item_001", "item_002"]);
    expect(body.image_media_type).toBe("image/png");
    expect(body.input_image_sha256).toBe("a".repeat(64));
    expect(body.user_context).toBe("downsizing");
    expect(body).not.toHaveProperty("denoise_strength");
    expect(body).not.toHaveProperty("controlnet_conditioning_scale");
    expect(body).not.toHaveProperty("seed");
    expect(body).not.toHaveProperty("kept_item_labels");
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

  test("sends file.type exactly as image_media_type — png", async () => {
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

  test("sends file.type exactly as image_media_type — jpeg", async () => {
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

  test("a non-ok response propagates as a thrown Error", async () => {
    mockFetchOnce({ detail: "invalid reorganise generation request" }, { ok: false, status: 422 });

    await expect(
      generateReorganisation({
        runId: "run1",
        analysis: { run_id: "run1" },
        selectedItemIds: ["item_001"],
        file: makeFile(),
        inputImageSha256: "a".repeat(64),
      })
    ).rejects.toThrow(/422/);
  });
});
