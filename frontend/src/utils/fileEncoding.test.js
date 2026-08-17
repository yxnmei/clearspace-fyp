import { describe, expect, test } from "vitest";
import { fileToBase64 } from "./fileEncoding";

function makeFile(bytes, name = "room.png", type = "image/png") {
  return new File([bytes], name, { type });
}

describe("fileToBase64", () => {
  test("resolves to a base64 string with no data: URL prefix", async () => {
    const result = await fileToBase64(makeFile(new Uint8Array([137, 80, 78, 71])));
    expect(result.startsWith("data:")).toBe(false);
    expect(result).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  test("the resolved base64 decodes back to the exact original bytes", async () => {
    const originalBytes = new Uint8Array([1, 2, 3, 255, 0, 128]);
    const result = await fileToBase64(makeFile(originalBytes));
    const decoded = Uint8Array.from(atob(result), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(originalBytes));
  });

  test("works for jpeg files too", async () => {
    const result = await fileToBase64(makeFile(new Uint8Array([255, 216, 255]), "room.jpg", "image/jpeg"));
    expect(result.startsWith("data:")).toBe(false);
    expect(result.length).toBeGreaterThan(0);
  });

  test("an empty file resolves to an empty string, not an error", async () => {
    const result = await fileToBase64(makeFile(new Uint8Array([])));
    expect(result).toBe("");
  });

  test("a FileReader error rejects the promise with a real Error", async () => {
    const file = makeFile(new Uint8Array([1, 2, 3]));
    const originalFileReader = global.FileReader;

    class FailingFileReader {
      readAsDataURL() {
        this.error = new Error("simulated read failure");
        if (this.onerror) this.onerror();
      }
    }
    global.FileReader = FailingFileReader;

    await expect(fileToBase64(file)).rejects.toThrow("simulated read failure");

    global.FileReader = originalFileReader;
  });
});
