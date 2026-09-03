import { useRef } from "react";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import BackToTopButton from "./BackToTopButton";

// Per-test browser API stubs, restored after every test.
let observers;
let originalIO;
let originalMatchMedia;
let originalScrollIntoView;

class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.elements = [];
    observers.push(this);
  }
  observe(el) {
    this.elements.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  emit(isIntersecting) {
    this.callback(this.elements.map((target) => ({ target, isIntersecting })));
  }
}

beforeEach(() => {
  observers = [];
  originalIO = global.IntersectionObserver;
  originalMatchMedia = window.matchMedia;
  originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
  global.IntersectionObserver = FakeIntersectionObserver;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  global.IntersectionObserver = originalIO;
  window.matchMedia = originalMatchMedia;
  window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  vi.restoreAllMocks();
});

function Harness(props) {
  const scrollTargetRef = useRef(null);
  const topSentinelRef = useRef(null);
  const bottomSentinelRef = useRef(null);
  return (
    <div>
      <div ref={scrollTargetRef} tabIndex={-1} data-testid="workspace-top">
        workspace
      </div>
      <span ref={topSentinelRef} data-testid="top-sentinel" />
      <span ref={bottomSentinelRef} data-testid="bottom-sentinel" />
      <BackToTopButton
        scrollTargetRef={scrollTargetRef}
        topSentinelRef={topSentinelRef}
        bottomSentinelRef={bottomSentinelRef}
        {...props}
      />
    </div>
  );
}

const topObserver = () => observers[0];
const bottomObserver = () => observers[1];
const scrollPastTop = () => act(() => topObserver().emit(false));
const scrollBackToTop = () => act(() => topObserver().emit(true));
const reachBottom = () => act(() => bottomObserver().emit(true));

describe("BackToTopButton", () => {
  test("is hidden until the top sentinel has scrolled out of view", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: /back to top/i })).not.toBeInTheDocument();

    scrollPastTop();
    expect(screen.getByRole("button", { name: /back to top/i })).toBeInTheDocument();

    scrollBackToTop();
    expect(screen.queryByRole("button", { name: /back to top/i })).not.toBeInTheDocument();
  });

  test("hides again near the bottom so it cannot cover the wizard controls", () => {
    render(<Harness />);
    scrollPastTop();
    expect(screen.getByRole("button", { name: /back to top/i })).toBeInTheDocument();

    reachBottom();
    expect(screen.queryByRole("button", { name: /back to top/i })).not.toBeInTheDocument();
  });

  test("keeps an accessible name even when the label text is visually hidden on narrow screens", () => {
    render(<Harness />);
    scrollPastTop();
    const button = screen.getByRole("button", { name: "Back to top" });
    // the visible text span is the one that toggles with the sm breakpoint
    expect(button.querySelector("span.hidden")).toHaveTextContent("Back to top");
  });

  test("returns scroll and focus to the top of the workspace, smoothly by default", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    scrollPastTop();
    await user.click(screen.getByRole("button", { name: /back to top/i }));

    const workspace = screen.getByTestId("workspace-top");
    expect(workspace.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(workspace).toHaveFocus();
  });

  test("uses an immediate jump when the viewer prefers reduced motion", async () => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query.includes("reduce"),
      addEventListener() {},
      removeEventListener() {},
    }));
    const user = userEvent.setup();
    render(<Harness />);
    scrollPastTop();
    await user.click(screen.getByRole("button", { name: /back to top/i }));

    expect(screen.getByTestId("workspace-top").scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
  });

  test("disconnects its observers on unmount", () => {
    const { unmount } = render(<Harness />);
    unmount();
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });

  test("never appears when IntersectionObserver is unavailable", () => {
    global.IntersectionObserver = undefined;
    render(<Harness />);
    expect(screen.queryByRole("button", { name: /back to top/i })).not.toBeInTheDocument();
  });
});
