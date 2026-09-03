import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import RoomPhotoField from "./RoomPhotoField";

function setup(props = {}) {
  const onChange = vi.fn();
  const utils = render(
    <RoomPhotoField
      id="test-image"
      accept="image/*"
      onChange={onChange}
      previewAlt="Preview of the room photo you selected"
      helpText="JPG or PNG of one room."
      {...props}
    />
  );
  return { onChange, ...utils };
}

describe("RoomPhotoField, the native input stays accessible", () => {
  test("a real <input type=file> is reachable by its 'Room photo' label", () => {
    setup();
    const input = screen.getByLabelText(/room photo/i);
    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveAttribute("type", "file");
  });

  test("the input carries whatever accept value the host form gives it", () => {
    const { rerender } = setup();
    expect(screen.getByLabelText(/room photo/i)).toHaveAttribute("accept", "image/*");
    rerender(
      <RoomPhotoField id="test-image" accept="image/png,image/jpeg" onChange={vi.fn()} previewAlt="x" />
    );
    expect(screen.getByLabelText(/room photo/i)).toHaveAttribute("accept", "image/png,image/jpeg");
  });

  test("it is visually hidden but kept in the accessibility tree and focusable", () => {
    setup();
    const input = screen.getByLabelText(/room photo/i);
    expect(input.className).toContain("sr-only");
    expect(input).not.toHaveAttribute("hidden");
    expect(input).not.toHaveAttribute("aria-hidden", "true");
    input.focus();
    expect(input).toHaveFocus();
  });

  test("it is disabled when the field is disabled", () => {
    setup({ disabled: true });
    expect(screen.getByLabelText(/room photo/i)).toBeDisabled();
  });

  test("choosing a file calls the host's onChange", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.upload(screen.getByLabelText(/room photo/i), new File(["x"], "room.png", { type: "image/png" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("the visible trigger label is associated with the input", () => {
    setup();
    const input = screen.getByLabelText(/room photo/i);
    const trigger = document.querySelector(`label[for="${input.id}"]`);
    expect(trigger).not.toBeNull();
    expect(trigger).toHaveTextContent(/choose photo/i);
  });
});

describe("RoomPhotoField, empty state", () => {
  test("says no photo is selected and shows a quiet placeholder, not an image", () => {
    setup();
    expect(screen.getByText("No photo selected")).toBeInTheDocument();
    expect(screen.getByText(/no photo selected yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  test("the trigger reads 'Choose photo' with nothing selected", () => {
    setup();
    expect(screen.getByText(/choose photo/i)).toBeInTheDocument();
  });
});

describe("RoomPhotoField, with a selected file", () => {
  test("shows File.name only, never a path or a fake path", () => {
    setup({ fileName: "living_room.png" });
    const shown = screen.getByText("living_room.png");
    expect(shown.textContent).toBe("living_room.png");
    expect(shown.textContent).not.toMatch(/[\\/]/);
    expect(shown.textContent).not.toMatch(/fakepath|Users|C:\\/i);
    expect(screen.queryByText("No photo selected")).not.toBeInTheDocument();
  });

  test("the trigger switches to 'Change photo'", () => {
    setup({ fileName: "living_room.png" });
    expect(screen.getByText(/change photo/i)).toBeInTheDocument();
  });

  test("renders a bounded preview image with the alt text it is given", () => {
    setup({ previewUrl: "blob:mock", previewAlt: "Preview of the room photo you selected to declutter" });
    const img = screen.getByRole("img");
    expect(img).toHaveAccessibleName(/preview of the room photo/i);
    expect(img).toHaveAttribute("src", "blob:mock");
    expect(img.className).toMatch(/max-h-64/); // bounded
  });
});

describe("RoomPhotoField, help and error text", () => {
  test("help text is rendered and wired to the input via aria-describedby", () => {
    setup({ helpText: "JPG or PNG of one room." });
    const input = screen.getByLabelText(/room photo/i);
    const help = screen.getByText("JPG or PNG of one room.");
    expect(input.getAttribute("aria-describedby")).toContain(help.id);
  });

  test("a field error is an alert, wired to the input, and no error node exists otherwise", () => {
    const { rerender } = setup();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(
      <RoomPhotoField
        id="test-image"
        accept="image/*"
        onChange={vi.fn()}
        previewAlt="x"
        error='"image/webp" is not supported. Please choose a PNG or JPEG photo.'
      />
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/not supported/i);
    expect(screen.getByLabelText(/room photo/i).getAttribute("aria-describedby")).toContain(alert.id);
  });
});
