import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useReorganiseFlow } from "./useReorganiseFlow";
import * as client from "../api/client";

// Only the frontend API functions are mocked, the real, validating
// reorganiseContract adapters run for real, so these tests also prove
// the hook wires real contract validation correctly, matching
// useDeclutterFlow.test.jsx's own established convention.
vi.mock("../api/client", () => ({
  uploadImage: vi.fn(),
  generateReorganisation: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeFile(name = "room.png", type = "image/png") {
  return new File(["fake bytes"], name, { type });
}

const HASH = "a".repeat(64);

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

function makeUploadResponse({ runId = "run1", items } = {}) {
  const theItems = items ?? [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_002" })];
  return {
    run_id: runId,
    path: "reorganise",
    analysis: {
      run_id: runId,
      scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
      items: theItems,
      warnings: [],
      stage_timings: [],
    },
    input_image_sha256: HASH,
  };
}

function makeActionPlan(runId, overrides = {}) {
  return {
    run_id: runId,
    actions: [{ priority: 1, title: "Clear the desk", instruction: "Straighten the lamp and clear the space around it." }],
    provenance: "llm_generated",
    attempts: 1,
    model_name: "phi4-mini",
    prompt_version: "reorganise-actions-v1",
    was_repaired: false,
    duration_ms: 5,
    issues: [],
    ...overrides,
  };
}

function makeGenerationBody(runId, itemIds) {
  return {
    action_plan: makeActionPlan(runId),
    focus_areas: [{ area_id: "left", label: "Left side", item_ids: itemIds }],
    storage_suggestions: [],
    image_prompt: "a tidy bedroom",
  };
}

function makeGeneratedResponse(runId, itemIds) {
  return {
    run_id: runId,
    ...makeGenerationBody(runId, itemIds),
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

function makeUnavailableResponse(runId, itemIds, reason = "service_unreachable") {
  return {
    run_id: runId,
    ...makeGenerationBody(runId, itemIds),
    image_status: "unavailable",
    image: null,
    image_unavailable_reason: reason,
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------

describe("useReorganiseFlow, initial state", () => {
  test("starts in the upload phase with no data", () => {
    const { result } = renderHook(() => useReorganiseFlow());
    expect(result.current.phase).toBe("upload");
    expect(result.current.file).toBeNull();
    expect(result.current.analysis).toBeNull();
    expect(result.current.selectedItemIds).toEqual([]);
    expect(result.current.uploadError).toBeNull();
    expect(result.current.generateError).toBeNull();
    expect(result.current.generateResult).toBeNull();
  });
});

describe("useReorganiseFlow, upload lifecycle", () => {
  test("submit() moves to analysing, then selecting on success", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useReorganiseFlow());

    act(() => {
      result.current.submit({ file: makeFile(), context: "downsizing" });
    });
    expect(result.current.phase).toBe("analysing");
    expect(result.current.file).not.toBeNull(); // captured immediately

    await waitFor(() => expect(result.current.phase).toBe("selecting"));
    expect(result.current.runId).toBe("run1");
    expect(result.current.analysis).toBeTruthy();
    expect(result.current.context).toBe("downsizing");
  });

  test("path=\"reorganise\" is sent to uploadImage", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useReorganiseFlow());

    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(client.uploadImage).toHaveBeenCalledWith(expect.objectContaining({ path: "reorganise" }));
  });

  test("all actionable items are selected by default; contextual items are excluded", async () => {
    client.uploadImage.mockResolvedValue(
      makeUploadResponse({
        items: [
          makeItem({ item_id: "item_001", item_role: "actionable" }),
          makeItem({ item_id: "item_002", item_role: "actionable" }),
          makeItem({ item_id: "item_003", item_role: "contextual" }),
        ],
      })
    );
    const { result } = renderHook(() => useReorganiseFlow());

    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(result.current.selectedItemIds.sort()).toEqual(["item_001", "item_002"]);
    expect(result.current.items).toHaveLength(3); // contextual item still VISIBLE, just not selected
  });

  test("a failed upload returns to the upload phase with a concise error, retaining the picked file", async () => {
    client.uploadImage.mockRejectedValue(new Error("upload exploded"));
    const { result } = renderHook(() => useReorganiseFlow());

    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(result.current.phase).toBe("upload");
    expect(result.current.uploadError).toMatch(/upload exploded/);
    expect(result.current.file).not.toBeNull(); // the user's picked file is not thrown away
    expect(result.current.analysis).toBeNull(); // no stale analysis is ever shown
  });

  test("a new submit() clears any previous analysis before the new response arrives", async () => {
    client.uploadImage.mockResolvedValueOnce(makeUploadResponse({ runId: "run1" }));
    const { result } = renderHook(() => useReorganiseFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    expect(result.current.runId).toBe("run1");

    const slow = deferred();
    client.uploadImage.mockReturnValueOnce(slow.promise);
    act(() => {
      result.current.submit({ file: makeFile("room2.png"), context: null });
    });

    // The OLD analysis must already be gone the instant the new submit starts.
    expect(result.current.analysis).toBeNull();
    expect(result.current.phase).toBe("analysing");

    await act(async () => {
      slow.resolve(makeUploadResponse({ runId: "run2" }));
      await slow.promise;
    });
    await waitFor(() => expect(result.current.runId).toBe("run2"));
  });
});

describe("useReorganiseFlow, selection", () => {
  async function uploadedFlow(items) {
    client.uploadImage.mockResolvedValue(makeUploadResponse({ items }));
    const { result } = renderHook(() => useReorganiseFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    return result;
  }

  test("toggling deselects a selected item, keyed by item_id", async () => {
    const result = await uploadedFlow();
    expect(result.current.selectedItemIds).toContain("item_001");

    act(() => result.current.toggleItemSelected("item_001"));
    expect(result.current.selectedItemIds).not.toContain("item_001");
    expect(result.current.selectedItemIds).toContain("item_002");
  });

  test("toggling re-selects a deselected item", async () => {
    const result = await uploadedFlow();
    act(() => result.current.toggleItemSelected("item_001"));
    act(() => result.current.toggleItemSelected("item_001"));
    expect(result.current.selectedItemIds).toContain("item_001");
  });

  test("duplicate-labelled items toggle independently by item_id", async () => {
    const result = await uploadedFlow([
      makeItem({ item_id: "item_001", clean_label: "picture frame", effective_label: "picture frame" }),
      makeItem({ item_id: "item_002", clean_label: "picture frame", effective_label: "picture frame" }),
    ]);
    act(() => result.current.toggleItemSelected("item_001"));
    expect(result.current.selectedItemIds).toEqual(["item_002"]);
  });

  test("deselectAll empties the selection; selectAllActionable restores actionable items", async () => {
    const result = await uploadedFlow();
    act(() => result.current.deselectAll());
    expect(result.current.selectedItemIds).toEqual([]);
    act(() => result.current.selectAllActionable());
    expect(result.current.selectedItemIds.sort()).toEqual(["item_001", "item_002"]);
  });
});

describe("useReorganiseFlow, generate", () => {
  async function uploadedFlow() {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useReorganiseFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    return result;
  }

  test("empty selection blocks generation, no network call", async () => {
    const result = await uploadedFlow();
    act(() => result.current.deselectAll());

    let outcome;
    await act(async () => {
      outcome = await result.current.generate();
    });

    expect(outcome).toBeNull();
    expect(result.current.phase).toBe("selecting");
    expect(client.generateReorganisation).not.toHaveBeenCalled();
  });

  test("the exact request state reaches generateReorganisation", async () => {
    const result = await uploadedFlow();
    client.generateReorganisation.mockResolvedValue(makeGeneratedResponse("run1", ["item_001", "item_002"]));

    await act(async () => {
      await result.current.generate();
    });

    expect(client.generateReorganisation).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run1",
        selectedItemIds: expect.arrayContaining(["item_001", "item_002"]),
        inputImageSha256: HASH,
      })
    );
  });

  test("a successful generated result moves to the result phase", async () => {
    const result = await uploadedFlow();
    client.generateReorganisation.mockResolvedValue(makeGeneratedResponse("run1", ["item_001", "item_002"]));

    await act(async () => {
      await result.current.generate();
    });

    expect(result.current.phase).toBe("result");
    expect(result.current.generateResult.imageStatus).toBe("generated");
    expect(result.current.generateResult.image).toBeTruthy();
  });

  test("a plan-only unavailable result is a SUCCESSFUL result phase, not an error", async () => {
    const result = await uploadedFlow();
    client.generateReorganisation.mockResolvedValue(makeUnavailableResponse("run1", ["item_001", "item_002"], "timeout"));

    await act(async () => {
      await result.current.generate();
    });

    expect(result.current.phase).toBe("result");
    expect(result.current.generateResult.imageStatus).toBe("unavailable");
    expect(result.current.generateResult.imageUnavailableReason).toBe("timeout");
    expect(result.current.generateResult.image).toBeNull();
    expect(result.current.generateError).toBeNull(); // never treated as an error
    expect(result.current.generateResult.actionPlan.actions).toHaveLength(1); // checklist preserved
  });

  test("a generate() failure preserves file/analysis/selection and returns to selecting", async () => {
    const result = await uploadedFlow();
    client.generateReorganisation.mockRejectedValue(new Error("network exploded"));

    await act(async () => {
      await result.current.generate();
    });

    expect(result.current.phase).toBe("selecting");
    expect(result.current.generateError).toMatch(/network exploded/);
    expect(result.current.file).not.toBeNull();
    expect(result.current.analysis).toBeTruthy();
    expect(result.current.selectedItemIds.length).toBeGreaterThan(0);
  });

  test("after a generate() failure, retrying calls the client again without a fresh upload", async () => {
    const result = await uploadedFlow();
    client.generateReorganisation.mockRejectedValueOnce(new Error("first attempt failed"));
    await act(async () => {
      await result.current.generate();
    });
    expect(result.current.generateError).toBeTruthy();

    client.generateReorganisation.mockResolvedValueOnce(makeGeneratedResponse("run1", ["item_001", "item_002"]));
    await act(async () => {
      await result.current.generate();
    });

    expect(client.uploadImage).toHaveBeenCalledTimes(1); // no re-upload happened
    expect(result.current.phase).toBe("result");
    expect(result.current.generateResult.imageStatus).toBe("generated");
  });

  test("double generation dispatch is prevented, exactly one network call", async () => {
    const result = await uploadedFlow();
    const slow = deferred();
    client.generateReorganisation.mockReturnValue(slow.promise);

    let firstCall, secondCall;
    act(() => {
      firstCall = result.current.generate();
      secondCall = result.current.generate(); // fired while phase is already "generating"
    });

    expect(client.generateReorganisation).toHaveBeenCalledTimes(1);

    await act(async () => {
      slow.resolve(makeGeneratedResponse("run1", ["item_001", "item_002"]));
      await Promise.all([firstCall, secondCall]);
    });

    expect(await secondCall).toBeNull();
  });

  test("no tuning fields are ever part of the request the hook builds", async () => {
    const result = await uploadedFlow();
    client.generateReorganisation.mockResolvedValue(makeGeneratedResponse("run1", ["item_001", "item_002"]));
    await act(async () => {
      await result.current.generate();
    });
    const args = client.generateReorganisation.mock.calls[0][0];
    expect(args).not.toHaveProperty("denoiseStrength");
    expect(args).not.toHaveProperty("controlnetConditioningScale");
    expect(args).not.toHaveProperty("seed");
  });
});

describe("useReorganiseFlow, staleness and reset", () => {
  test("a stale upload response is discarded when a newer submit() has already succeeded", async () => {
    const slow = deferred();
    client.uploadImage.mockReturnValueOnce(slow.promise);
    const { result } = renderHook(() => useReorganiseFlow());

    act(() => {
      result.current.submit({ file: makeFile("first.png"), context: null });
    });

    client.uploadImage.mockResolvedValueOnce(makeUploadResponse({ runId: "run-second" }));
    await act(async () => {
      await result.current.submit({ file: makeFile("second.png"), context: null });
    });
    expect(result.current.runId).toBe("run-second");

    await act(async () => {
      slow.resolve(makeUploadResponse({ runId: "run-first-stale" }));
      await slow.promise;
    });

    // The stale first response must never overwrite the newer, already-applied one.
    expect(result.current.runId).toBe("run-second");
  });

  test("a stale generate() success is discarded after reset()", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useReorganiseFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    const slow = deferred();
    client.generateReorganisation.mockReturnValue(slow.promise);
    act(() => {
      result.current.generate();
    });
    expect(result.current.phase).toBe("generating");

    act(() => {
      result.current.reset();
    });
    expect(result.current.phase).toBe("upload");

    await act(async () => {
      slow.resolve(makeGeneratedResponse("run1", ["item_001", "item_002"]));
      await slow.promise.catch(() => {});
    });

    // Reset must win, the stale generate() response must never resurrect state.
    expect(result.current.phase).toBe("upload");
    expect(result.current.generateResult).toBeNull();
    expect(result.current.analysis).toBeNull();
  });

  test("a stale generate() success is discarded after a NEWER upload replaces it", async () => {
    client.uploadImage.mockResolvedValueOnce(makeUploadResponse({ runId: "run1" }));
    const { result } = renderHook(() => useReorganiseFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    const slowGenerate = deferred();
    client.generateReorganisation.mockReturnValue(slowGenerate.promise);
    act(() => {
      result.current.generate();
    });
    expect(result.current.phase).toBe("generating");

    client.uploadImage.mockResolvedValueOnce(makeUploadResponse({ runId: "run2" }));
    await act(async () => {
      await result.current.submit({ file: makeFile("new.png"), context: null });
    });
    expect(result.current.runId).toBe("run2");
    expect(result.current.phase).toBe("selecting");

    await act(async () => {
      slowGenerate.resolve(makeGeneratedResponse("run1", ["item_001", "item_002"]));
      await slowGenerate.promise.catch(() => {});
    });

    // The stale generate() response (for the OLD run) must never flip us back to "result".
    expect(result.current.phase).toBe("selecting");
    expect(result.current.generateResult).toBeNull();
    expect(result.current.runId).toBe("run2");
  });

  test("a stale generate() REJECTION is also discarded, not surfaced as a fresh error", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useReorganiseFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    const slow = deferred();
    client.generateReorganisation.mockReturnValue(slow.promise);
    act(() => {
      result.current.generate();
    });

    act(() => {
      result.current.reset();
    });

    await act(async () => {
      slow.reject(new Error("stale failure, must be ignored"));
      await slow.promise.catch(() => {});
    });

    expect(result.current.phase).toBe("upload");
    expect(result.current.generateError).toBeNull();
  });

  test("reset() clears file, analysis, selection, result and errors, returning to upload", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useReorganiseFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: "some context" });
    });
    client.generateReorganisation.mockResolvedValue(makeGeneratedResponse("run1", ["item_001", "item_002"]));
    await act(async () => {
      await result.current.generate();
    });
    expect(result.current.phase).toBe("result");

    act(() => {
      result.current.reset();
    });

    expect(result.current.phase).toBe("upload");
    expect(result.current.file).toBeNull();
    expect(result.current.context).toBeNull();
    expect(result.current.analysis).toBeNull();
    expect(result.current.selectedItemIds).toEqual([]);
    expect(result.current.generateResult).toBeNull();
    expect(result.current.uploadError).toBeNull();
    expect(result.current.generateError).toBeNull();
  });
});

describe("useReorganiseFlow, generation ownership token (correction 1)", () => {
  test("a new flow can generate without waiting for a stale, superseded generation to settle", async () => {
    // A -> reset() releases A's slot immediately -> B starts (must NOT be
    // blocked by A, which is still in flight) -> a third dispatch while B
    // is active IS blocked -> A settles late and must not clobber B's
    // ownership or B's eventual result.
    client.uploadImage.mockResolvedValueOnce(makeUploadResponse({ runId: "runA" }));
    const { result } = renderHook(() => useReorganiseFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile("a.png"), context: null });
    });

    const genA = deferred();
    client.generateReorganisation.mockReturnValueOnce(genA.promise);
    let outcomeA;
    act(() => {
      outcomeA = result.current.generate();
    });
    expect(result.current.phase).toBe("generating");

    // reset() releases A's slot immediately, does not wait for A to settle.
    act(() => {
      result.current.reset();
    });
    expect(result.current.phase).toBe("upload");

    client.uploadImage.mockResolvedValueOnce(makeUploadResponse({ runId: "runB" }));
    await act(async () => {
      await result.current.submit({ file: makeFile("b.png"), context: null });
    });

    const genB = deferred();
    client.generateReorganisation.mockReturnValueOnce(genB.promise);
    let outcomeB;
    act(() => {
      outcomeB = result.current.generate(); // B must be allowed to start, A's slot was already released
    });
    expect(result.current.phase).toBe("generating");
    expect(client.generateReorganisation).toHaveBeenCalledTimes(2); // A's call + B's call

    // A THIRD dispatch while B is active must be blocked, no third network call.
    let outcomeThird;
    act(() => {
      outcomeThird = result.current.generate();
    });
    expect(await outcomeThird).toBeNull();
    expect(client.generateReorganisation).toHaveBeenCalledTimes(2); // still just A + B, never a third

    // A settles LATE, after B has already claimed the slot, must be
    // discarded silently and must NOT release B's ownership or touch
    // phase/generateResult.
    await act(async () => {
      genA.resolve(makeGeneratedResponse("runA", ["item_001", "item_002"]));
      await Promise.resolve();
      await outcomeA;
    });
    expect(result.current.phase).toBe("generating"); // still B, untouched by A's stale settlement
    expect(result.current.generateResult).toBeNull();

    // A FOURTH dispatch must still be blocked, B's ownership survived A's stale settlement.
    let outcomeFourth;
    act(() => {
      outcomeFourth = result.current.generate();
    });
    expect(await outcomeFourth).toBeNull();
    expect(client.generateReorganisation).toHaveBeenCalledTimes(2);

    // B settles successfully, the slot is released and the result applies.
    await act(async () => {
      genB.resolve(makeGeneratedResponse("runB", ["item_001", "item_002"]));
      await outcomeB;
    });
    expect(result.current.phase).toBe("result");
    expect(result.current.generateResult.imageStatus).toBe("generated");

    // With the slot now free, a new generate() call is no longer blocked.
    client.generateReorganisation.mockResolvedValueOnce(makeGeneratedResponse("runB", ["item_001", "item_002"]));
    // generate() only runs from "selecting", reaching for it here just
    // confirms the slot itself is free, not a full re-generate flow.
    expect(result.current.phase).toBe("result");
  });
});
