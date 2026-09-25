import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import ImageLightbox from "./ImageLightbox";

function renderOpen(overrides = {}) {
  const onClose = vi.fn();
  const utils = render(
    <ImageLightbox
      open
      onClose={onClose}
      src="blob:photo"
      alt="The space photo you uploaded"
      title="Analysed space"
      description="Item outlines are not shown in this view."
      {...overrides}
    />
  );
  return { onClose, ...utils };
}

afterEach(() => {
  document.body.style.overflow = "";
});

describe("ImageLightbox", () => {
  test("renders nothing while closed", () => {
    render(<ImageLightbox open={false} onClose={vi.fn()} src="blob:photo" alt="x" title="Analysed space" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("open: a modal dialog named by its title, the image at 1x, focus on Close, page scroll locked", () => {
    renderOpen();
    const dialog = screen.getByRole("dialog", { name: "Analysed space" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Item outlines are not shown in this view.");
    const img = screen.getByRole("img", { name: "The space photo you uploaded" });
    expect(img).toHaveAttribute("src", "blob:photo");
    expect(img).toHaveAttribute("data-zoom", "1");
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("zoom buttons step through 1x, 2x and 3x, widening the image and disabling at the ends", async () => {
    const user = userEvent.setup();
    renderOpen();
    const img = screen.getByRole("img", { name: "The space photo you uploaded" });
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    expect(zoomOut).toBeDisabled();
    await user.click(zoomIn);
    expect(img).toHaveAttribute("data-zoom", "2");
    // The wrapper carries the zoom width so outlines scale with the image.
    expect(img.parentElement.style.width).toBe("200%");
    await user.click(zoomIn);
    expect(img).toHaveAttribute("data-zoom", "3");
    expect(zoomIn).toBeDisabled();
    await user.click(zoomOut);
    expect(img).toHaveAttribute("data-zoom", "2");
    expect(screen.getByText("2x")).toBeInTheDocument();
  });

  test("keyboard: + and - zoom, Escape closes", async () => {
    const user = userEvent.setup();
    const { onClose } = renderOpen();
    const img = screen.getByRole("img", { name: "The space photo you uploaded" });
    await user.keyboard("+");
    expect(img).toHaveAttribute("data-zoom", "2");
    await user.keyboard("-");
    expect(img).toHaveAttribute("data-zoom", "1");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Close button and backdrop click close; clicking the image does not", async () => {
    const user = userEvent.setup();
    const { onClose } = renderOpen();
    await user.click(screen.getByRole("img", { name: "The space photo you uploaded" }));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("lightbox-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("Tab cycles inside the dialog", async () => {
    const user = userEvent.setup();
    renderOpen();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Zoom in" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  test("closing returns focus to the element that opened it and restores page scroll", () => {
    const opener = document.createElement("button");
    opener.textContent = "Expand image";
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(
      <ImageLightbox open onClose={vi.fn()} src="blob:photo" alt="x" title="Analysed space" />
    );
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    rerender(<ImageLightbox open={false} onClose={vi.fn()} src="blob:photo" alt="x" title="Analysed space" />);
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
    opener.remove();
  });

  describe("detection outlines", () => {
    const overlays = [
      { id: "item_001", box: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.6 }, label: "1", className: "border-primary" },
      { id: "item_002", box: { x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.9 }, label: "2", className: "border-primary" },
    ];

    test("renders through a portal on document.body so page chrome cannot stack above it", () => {
      const { container } = renderOpen();
      const dialog = screen.getByRole("dialog");
      expect(container).not.toContainElement(dialog);
      expect(dialog.parentElement).toBe(document.body);
      expect(dialog.className).toMatch(/z-\[100\]/);
    });

    test("no outlines and no toggle when the host passes none", () => {
      renderOpen();
      expect(screen.queryByRole("checkbox", { name: "Show boxes" })).not.toBeInTheDocument();
      expect(screen.queryAllByTestId("lightbox-overlay")).toHaveLength(0);
    });

    test("outlines start from the host's setting, sit in the image wrapper by percentage, and stay at every zoom", async () => {
      const user = userEvent.setup();
      renderOpen({ overlays, initialShowOverlays: true });
      expect(screen.getByRole("checkbox", { name: "Show boxes" })).toBeChecked();
      const boxes = screen.getAllByTestId("lightbox-overlay");
      expect(boxes).toHaveLength(2);
      expect(boxes[0].style.left).toBe("10%");
      expect(boxes[0].style.top).toBe("20%");
      expect(boxes[0].style.width).toBe("20%");
      expect(boxes[0].style.height).toBe("40%");
      expect(boxes[0]).toHaveTextContent("1");
      const img = screen.getByRole("img", { name: "The space photo you uploaded" });
      expect(boxes[0].parentElement.parentElement).toBe(img.parentElement);
      await user.click(screen.getByRole("button", { name: "Zoom in" }));
      expect(img).toHaveAttribute("data-zoom", "2");
      expect(img.parentElement.style.width).toBe("200%");
      expect(screen.getAllByTestId("lightbox-overlay")).toHaveLength(2);
      // The outline layer never intercepts the backdrop or the image.
      expect(boxes[0].parentElement.className).toMatch(/pointer-events-none/);
      expect(boxes[0].parentElement).toHaveAttribute("aria-hidden", "true");
    });

    test("the toggle hides and shows the outlines without closing, and a hidden host setting starts unchecked", async () => {
      const user = userEvent.setup();
      const { onClose, rerender } = renderOpen({ overlays, initialShowOverlays: true });
      const toggle = screen.getByRole("checkbox", { name: "Show boxes" });
      await user.click(toggle);
      expect(toggle).not.toBeChecked();
      expect(screen.queryAllByTestId("lightbox-overlay")).toHaveLength(0);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      await user.click(toggle);
      expect(screen.getAllByTestId("lightbox-overlay")).toHaveLength(2);

      rerender(
        <ImageLightbox open={false} onClose={onClose} src="blob:photo" alt="x" title="Analysed space" overlays={overlays} initialShowOverlays={false} />
      );
      rerender(
        <ImageLightbox open onClose={onClose} src="blob:photo" alt="x" title="Analysed space" overlays={overlays} initialShowOverlays={false} />
      );
      expect(screen.getByRole("checkbox", { name: "Show boxes" })).not.toBeChecked();
      expect(screen.queryAllByTestId("lightbox-overlay")).toHaveLength(0);
    });
  });

  test("rendered copy contains no em dash", () => {
    const { container } = renderOpen();
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
