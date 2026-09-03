import { render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ItemCropThumbnail, { computeCropStyle } from "./ItemCropThumbnail";

describe("computeCropStyle, proportion-preserving cover crop", () => {
  test("a square box on a square image scales uniformly and offsets to the box", () => {
    const style = computeCropStyle({ x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 });
    // box is 0.4 x 0.4; smaller rendered dimension must fill → 1/0.4 = 250%
    expect(style.backgroundSize).toBe("250.0000% 250.0000%");
    expect(style.backgroundPosition).toBe("16.6667% 33.3333%");
  });

  test("both background-size axes stay in the image's aspect ratio (never stretched)", () => {
    const box = { x1: 0.2, y1: 0.2, x2: 0.6, y2: 0.6 }; // square in normalized space

    const wide = computeCropStyle(box, 2); // image twice as wide as tall
    const [wx, wy] = wide.backgroundSize.split(" ").map((s) => parseFloat(s));
    expect(wx / wy).toBeCloseTo(2, 5);

    const tall = computeCropStyle(box, 0.5); // image twice as tall as wide
    const [tx, ty] = tall.backgroundSize.split(" ").map((s) => parseFloat(s));
    expect(tx / ty).toBeCloseTo(0.5, 5);
  });

  test("a wide source image: the box's shorter rendered side fills the square", () => {
    const style = computeCropStyle({ x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 }, 2);
    expect(style.backgroundSize).toBe("400.0000% 200.0000%");
    expect(style.backgroundPosition).toBe("50.0000% 50.0000%");
  });

  test("a tall source image: the box's shorter rendered side fills the square", () => {
    const style = computeCropStyle({ x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 }, 0.5);
    expect(style.backgroundSize).toBe("200.0000% 400.0000%");
    expect(style.backgroundPosition).toBe("50.0000% 50.0000%");
  });

  test("a full-frame box on a square image maps to 100% at the origin", () => {
    expect(computeCropStyle({ x1: 0, y1: 0, x2: 1, y2: 1 })).toEqual({
      backgroundSize: "100.0000% 100.0000%",
      backgroundPosition: "0.0000% 0.0000%",
    });
  });

  test("a box hugging the far edge is clamped to the 100% position, never past it", () => {
    const style = computeCropStyle({ x1: 0.75, y1: 0.75, x2: 1, y2: 1 });
    expect(style.backgroundPosition).toBe("100.0000% 100.0000%");
  });

  test("out-of-range coordinates are clamped, not rejected", () => {
    expect(computeCropStyle({ x1: -0.5, y1: -3, x2: 2, y2: 5 })).toEqual({
      backgroundSize: "100.0000% 100.0000%",
      backgroundPosition: "0.0000% 0.0000%",
    });
  });

  test("a non-positive or non-finite aspect ratio falls back to square, without throwing", () => {
    const box = { x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 };
    expect(computeCropStyle(box, 0)).toEqual(computeCropStyle(box, 1));
    expect(computeCropStyle(box, -2)).toEqual(computeCropStyle(box, 1));
    expect(computeCropStyle(box, NaN)).toEqual(computeCropStyle(box, 1));
  });

  test("returns null for unusable boxes", () => {
    expect(computeCropStyle(null)).toBeNull();
    expect(computeCropStyle({ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 })).toBeNull(); // zero area
    expect(computeCropStyle({ x1: 0.6, y1: 0.1, x2: 0.2, y2: 0.4 })).toBeNull(); // inverted x
    expect(computeCropStyle({ x1: "a", y1: 0, x2: 1, y2: 1 })).toBeNull(); // non-numeric
  });
});

describe("ItemCropThumbnail, rendering", () => {
  const box = { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 };

  test("decorative by default: no img role, aria-hidden, and it is not a control", () => {
    render(<ItemCropThumbnail imageUrl="blob:mock" box={box} />);
    const thumb = screen.getByTestId("item-crop-thumbnail");
    expect(thumb).toHaveAttribute("aria-hidden", "true");
    expect(thumb.tagName).toBe("SPAN");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("crops from the shared source image via CSS background, creating no object URL and no DOM image", () => {
    const createObjectURL = vi.fn(() => "blob:should-never-be-called");
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    try {
      render(<ItemCropThumbnail imageUrl="blob:room-abc" box={box} />);
      const thumb = screen.getByTestId("item-crop-thumbnail");
      expect(thumb.style.backgroundImage).toBe('url("blob:room-abc")');
      // square-image fallback until the probe resolves (it never does in jsdom)
      expect(thumb.style.backgroundSize).toBe("250.0000% 250.0000%");
      expect(thumb.querySelector("img")).toBeNull();
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(revokeObjectURL).not.toHaveBeenCalled();
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  test("falls back to a neutral placeholder when the image is missing", () => {
    render(<ItemCropThumbnail imageUrl={null} box={box} />);
    const fallback = screen.getByTestId("item-crop-fallback");
    expect(fallback).toHaveAttribute("aria-hidden", "true");
    expect(fallback.style.backgroundImage).toBe("");
    expect(screen.queryByTestId("item-crop-thumbnail")).not.toBeInTheDocument();
  });

  test("falls back when the box is unusable, without throwing", () => {
    render(<ItemCropThumbnail imageUrl="blob:mock" box={{ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }} />);
    expect(screen.getByTestId("item-crop-fallback")).toBeInTheDocument();
  });

  test("an explicit alt exposes it as an image to assistive tech", () => {
    render(<ItemCropThumbnail imageUrl="blob:mock" box={box} alt="Crop of the lamp" />);
    expect(screen.getByRole("img", { name: "Crop of the lamp" })).toBeInTheDocument();
  });

  test("unmounts cleanly: the aspect-ratio probe is abandoned and no URLs are revoked", () => {
    const revokeObjectURL = vi.fn();
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    try {
      const { unmount } = render(<ItemCropThumbnail imageUrl="blob:mock" box={box} />);
      expect(() => unmount()).not.toThrow();
      expect(revokeObjectURL).not.toHaveBeenCalled();
    } finally {
      URL.revokeObjectURL = originalRevoke;
    }
  });
});

describe("ItemCropThumbnail, aspect-ratio measurement lifecycle", () => {
  // Per-test fake for global.Image, restored after each test. Every
  // constructed probe is captured so a test can resolve or fail it
  // explicitly and prove exactly which probe (if any) affected the
  // rendered crop. Each test uses a distinct imageUrl so the module's
  // shared measurement cache never carries a value between tests.
  const box = { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 }; // square in normalized space
  const SQUARE_SIZE = "200.0000% 200.0000%"; // computeCropStyle(box, 1)

  let probes;
  let OriginalImage;

  class FakeImage {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      this._src = "";
      probes.push(this);
    }
    set src(value) {
      this._src = value;
    }
    get src() {
      return this._src;
    }
    succeed(naturalWidth, naturalHeight) {
      this.naturalWidth = naturalWidth;
      this.naturalHeight = naturalHeight;
      act(() => {
        if (this.onload) this.onload();
      });
    }
    fail() {
      act(() => {
        if (this.onerror) this.onerror();
      });
    }
  }

  beforeEach(() => {
    probes = [];
    OriginalImage = global.Image;
    global.Image = FakeImage;
  });

  afterEach(() => {
    global.Image = OriginalImage;
  });

  const bgSize = () => screen.getByTestId("item-crop-thumbnail").style.backgroundSize;
  const bgImage = () => screen.getByTestId("item-crop-thumbnail").style.backgroundImage;

  test("a successful 2:1 measurement updates the rendered crop", () => {
    render(<ItemCropThumbnail imageUrl="blob:life-1" box={box} />);
    // square fallback until the probe resolves
    expect(bgSize()).toBe(SQUARE_SIZE);

    probes[0].succeed(200, 100); // 2:1
    expect(bgSize()).toBe("400.0000% 200.0000%");
  });

  test("changing to a new uncached URL immediately stops using the old ratio", () => {
    const { rerender } = render(<ItemCropThumbnail imageUrl="blob:life-2a" box={box} />);
    probes[0].succeed(200, 100); // measure 2a as 2:1
    expect(bgSize()).toBe("400.0000% 200.0000%");

    rerender(<ItemCropThumbnail imageUrl="blob:life-2b" box={box} />);
    // no probe for 2b has resolved: back to the square fallback at once
    expect(bgImage()).toBe('url("blob:life-2b")');
    expect(bgSize()).toBe(SQUARE_SIZE);
  });

  test("a failed probe for the new URL leaves the square fallback active", () => {
    const { rerender } = render(<ItemCropThumbnail imageUrl="blob:life-3a" box={box} />);
    probes[0].succeed(200, 100);
    expect(bgSize()).toBe("400.0000% 200.0000%");

    rerender(<ItemCropThumbnail imageUrl="blob:life-3b" box={box} />);
    probes[1].fail();
    expect(bgSize()).toBe(SQUARE_SIZE);
  });

  test("a successful measurement of the new URL applies only its own ratio", () => {
    const { rerender } = render(<ItemCropThumbnail imageUrl="blob:life-4a" box={box} />);
    probes[0].succeed(100, 100); // 1:1
    expect(bgSize()).toBe(SQUARE_SIZE);

    rerender(<ItemCropThumbnail imageUrl="blob:life-4b" box={box} />);
    probes[1].succeed(100, 300); // 1:3
    expect(bgSize()).toBe("200.0000% 600.0000%");
  });

  test("a late onload from the previous URL cannot update the current thumbnail", () => {
    const { rerender } = render(<ItemCropThumbnail imageUrl="blob:life-5a" box={box} />);
    rerender(<ItemCropThumbnail imageUrl="blob:life-5b" box={box} />);

    // the previous URL's probe resolves LATE
    probes[0].succeed(200, 100); // would be 2:1 for 5a
    expect(bgSize()).toBe(SQUARE_SIZE); // 5b is unaffected

    // 5b's own probe still works
    probes[1].succeed(300, 100); // 3:1
    expect(bgSize()).toBe("600.0000% 200.0000%");
  });

  test("unmounting prevents a late callback from changing state", () => {
    const { unmount } = render(<ItemCropThumbnail imageUrl="blob:life-6" box={box} />);
    unmount();
    expect(() => probes[0].succeed(200, 100)).not.toThrow();
  });

  test("existing rendering behaviour is unchanged under the fake Image", () => {
    render(<ItemCropThumbnail imageUrl="blob:life-7" box={box} alt="Crop of the lamp" />);
    const thumb = screen.getByRole("img", { name: "Crop of the lamp" });
    expect(thumb).toBeInTheDocument();
    expect(thumb.querySelector("img")).toBeNull();
    // malformed box still falls back, never throws
    render(<ItemCropThumbnail imageUrl="blob:life-7b" box={{ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }} />);
    expect(screen.getByTestId("item-crop-fallback")).toBeInTheDocument();
  });
});
