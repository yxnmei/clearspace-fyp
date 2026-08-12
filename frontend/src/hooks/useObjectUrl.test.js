import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useObjectUrl } from "./useObjectUrl";

function makeFile(name = "room.jpg") {
  return new File(["fake bytes"], name, { type: "image/jpeg" });
}

let nextUrlSuffix = 0;

beforeEach(() => {
  nextUrlSuffix = 0;
  // jsdom does not implement object URLs — each call returns a distinct,
  // inspectable URL so tests can assert exactly which one was revoked.
  global.URL.createObjectURL = vi.fn(() => `blob:mock-${nextUrlSuffix++}`);
  global.URL.revokeObjectURL = vi.fn();
});

describe("useObjectUrl", () => {
  test("no file yields no URL and no create/revoke calls", () => {
    const { result } = renderHook(() => useObjectUrl(null));
    expect(result.current).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  test("selecting a file creates exactly one object URL", () => {
    const file = makeFile();
    const { result } = renderHook(() => useObjectUrl(file));

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
    expect(result.current).toBe("blob:mock-0");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  test("an ordinary rerender with the SAME file reference does not create or revoke", () => {
    const file = makeFile();
    const { result, rerender } = renderHook(({ f }) => useObjectUrl(f), { initialProps: { f: file } });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    rerender({ f: file }); // same reference, unrelated re-render
    rerender({ f: file });

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1); // still just once
    expect(URL.revokeObjectURL).not.toHaveBeenCalled(); // never revoked prematurely
    expect(result.current).toBe("blob:mock-0");
  });

  test("replacing the file revokes the old URL before/alongside creating the new one", () => {
    const fileA = makeFile("a.jpg");
    const fileB = makeFile("b.jpg");
    const { result, rerender } = renderHook(({ f }) => useObjectUrl(f), { initialProps: { f: fileA } });
    expect(result.current).toBe("blob:mock-0");

    rerender({ f: fileB });

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-0"); // the OLD url, not the new one
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(result.current).toBe("blob:mock-1");
  });

  test("clearing the selection (file -> null) revokes the outstanding URL", () => {
    const file = makeFile();
    const { result, rerender } = renderHook(({ f }) => useObjectUrl(f), { initialProps: { f: file } });
    expect(result.current).toBe("blob:mock-0");

    rerender({ f: null });

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-0");
    expect(result.current).toBeNull();
  });

  test("unmounting with an outstanding URL revokes it exactly once", () => {
    const file = makeFile();
    const { unmount } = renderHook(() => useObjectUrl(file));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-0");
  });

  test("never revokes the URL that is still current", () => {
    const file = makeFile();
    const { rerender } = renderHook(({ f }) => useObjectUrl(f), { initialProps: { f: file } });

    // Several unrelated rerenders with the same file must never touch revoke.
    for (let i = 0; i < 5; i++) rerender({ f: file });

    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});
