import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useImageGenHealth } from "./useImageGenHealth";
import * as client from "../api/client";

vi.mock("../api/client", () => ({
  getImageGenHealth: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useImageGenHealth", () => {
  test("starts in checking status", () => {
    client.getImageGenHealth.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useImageGenHealth());
    expect(result.current.status).toBe("checking");
  });

  test("a {available: true} response becomes available", async () => {
    client.getImageGenHealth.mockResolvedValue({ available: true });
    const { result } = renderHook(() => useImageGenHealth());
    await waitFor(() => expect(result.current.status).toBe("available"));
  });

  test("a {available: false} response becomes unavailable, even though the fetch did not throw", async () => {
    client.getImageGenHealth.mockResolvedValue({ available: false });
    const { result } = renderHook(() => useImageGenHealth());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  test("a response missing the available key becomes unavailable, not available", async () => {
    client.getImageGenHealth.mockResolvedValue({});
    const { result } = renderHook(() => useImageGenHealth());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  test("a rejected fetch becomes unavailable", async () => {
    client.getImageGenHealth.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useImageGenHealth());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  test("checks exactly once on mount", async () => {
    client.getImageGenHealth.mockResolvedValue({ available: true });
    renderHook(() => useImageGenHealth());
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalledTimes(1));
  });

  test("recheck() triggers another request and can change the status", async () => {
    client.getImageGenHealth.mockResolvedValueOnce({ available: false });
    const { result } = renderHook(() => useImageGenHealth());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));

    client.getImageGenHealth.mockResolvedValueOnce({ available: true });
    await act(async () => {
      await result.current.recheck();
    });

    expect(result.current.status).toBe("available");
    expect(client.getImageGenHealth).toHaveBeenCalledTimes(2);
  });
});
