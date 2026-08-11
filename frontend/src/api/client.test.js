import { afterEach, describe, expect, test, vi } from "vitest";
import { confirmDecisions, overrideItem } from "./client";

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

    const overrideFetch = mockFetchOnce({});
    await overrideItem({ itemId: "item_001", newLabel: "lamp", runId: "run1" });
    expect(overrideFetch.mock.calls[0][0]).toMatch(/\/override$/);
  });
});
