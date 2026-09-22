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
      previewAlt="Preview of the space photo you selected"
      helpText="JPG or PNG of one indoor space."
      {...props}
    />
  );
  return { onChange, ...utils };
}

const trigger = () => document.querySelector(`label[for="test-image"]`);
const classes = (el) => el.className.split(/\s+/).filter(Boolean);

describe("RoomPhotoField, the native input stays accessible", () => {
  test("a real <input type=file> is reachable by its 'Space photo' label", () => {
    setup();
    const input = screen.getByLabelText(/space photo/i);
    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveAttribute("type", "file");
  });

  test("the input carries whatever accept value the host form gives it", () => {
    const { rerender } = setup();
    expect(screen.getByLabelText(/space photo/i)).toHaveAttribute("accept", "image/*");
    rerender(
      <RoomPhotoField id="test-image" accept="image/png,image/jpeg" onChange={vi.fn()} previewAlt="x" />
    );
    expect(screen.getByLabelText(/space photo/i)).toHaveAttribute("accept", "image/png,image/jpeg");
  });

  test("it is visually hidden but kept in the accessibility tree and focusable", () => {
    setup();
    const input = screen.getByLabelText(/space photo/i);
    expect(input.className).toContain("sr-only");
    expect(input).not.toHaveAttribute("hidden");
    expect(input).not.toHaveAttribute("aria-hidden", "true");
    input.focus();
    expect(input).toHaveFocus();
  });

  test("it is disabled when the field is disabled", () => {
    setup({ disabled: true });
    expect(screen.getByLabelText(/space photo/i)).toBeDisabled();
  });

  test("choosing a file calls the host's onChange", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.upload(screen.getByLabelText(/space photo/i), new File(["x"], "room.png", { type: "image/png" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("the visible trigger label is associated with the input and shows a focus ring driven by the input", () => {
    setup();
    const input = screen.getByLabelText(/space photo/i);
    expect(trigger()).not.toBeNull();
    expect(trigger()).toHaveAttribute("for", input.id);
    expect(trigger()).toHaveTextContent(/choose photo/i);
    expect(trigger().className).toMatch(/peer-focus-visible:ring-2/);
  });

  test("the trigger is a full-width 44px target on phones and a natural-width small button from sm", () => {
    setup();
    const cls = classes(trigger());
    for (const c of ["min-h-11", "w-full", "sm:min-h-0", "sm:w-auto"]) expect(cls).toContain(c);
  });
});

describe("RoomPhotoField, empty state", () => {
  test("shows a calm dashed placeholder, not an image, and no filename slot", () => {
    setup();
    expect(screen.getByText(/no photo selected yet/i)).toBeInTheDocument();
    expect(screen.getByText("Choose a photo of your space to get started.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText("No photo selected")).not.toBeInTheDocument();
    const surface = screen.getByText(/no photo selected yet/i).closest("div").parentElement;
    expect(surface.className).toMatch(/border-dashed/);
    expect(surface.className).not.toMatch(/border-primary/);
  });

  test("the trigger reads 'Choose photo' with nothing selected", () => {
    setup();
    expect(screen.getByText(/choose photo/i)).toBeInTheDocument();
    expect(screen.queryByText(/replace photo/i)).not.toBeInTheDocument();
  });

  test("never implies drag-and-drop", () => {
    const { container } = setup();
    expect(container.textContent).not.toMatch(/drag|drop/i);
  });
});

describe("RoomPhotoField, with a selected file", () => {
  test("shows File.name only, never a path or a fake path, and it cannot overflow", () => {
    setup({ fileName: "living_room.png" });
    const shown = screen.getByText("living_room.png");
    expect(shown.textContent).toBe("living_room.png");
    expect(shown.textContent).not.toMatch(/[\\/]/);
    expect(shown.textContent).not.toMatch(/fakepath|Users|C:\\/i);
    expect(shown.className).toMatch(/\btruncate\b/);
    expect(shown.className).toMatch(/\bmin-w-0\b/);
    expect(shown).toHaveAttribute("title", "living_room.png"); // the full name stays reachable
  });

  test("a very long filename is still shown in full text but in a truncating, non-wrapping slot", () => {
    const long = `${"a-very-long-photo-name-".repeat(6)}from-my-phone.jpeg`;
    setup({ fileName: long });
    const shown = screen.getByText(long);
    expect(shown.className).toMatch(/\btruncate\b/);
    expect(shown.parentElement.className).toMatch(/flex-col/); // stacked under the trigger on phones
    expect(shown.parentElement.className).toMatch(/sm:flex-row/);
  });

  test("the trigger switches to 'Replace photo'", () => {
    setup({ fileName: "living_room.png" });
    expect(screen.getByText(/replace photo/i)).toBeInTheDocument();
    expect(screen.queryByText(/choose photo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/change photo/i)).not.toBeInTheDocument();
  });

  test("renders a bounded, emphasised preview image with the alt text it is given", () => {
    setup({ previewUrl: "blob:mock", previewAlt: "Preview of the space photo you selected to declutter" });
    const img = screen.getByRole("img");
    expect(img).toHaveAccessibleName(/preview of the space photo/i);
    expect(img).toHaveAttribute("src", "blob:mock");
    expect(img.className).toMatch(/max-h-80/); // bounded, taller than the empty surface
    expect(img.className).toMatch(/object-contain/);
    const frame = img.parentElement;
    expect(frame.className).toMatch(/border-primary/); // emphasised over the empty dashed surface
    expect(frame.className).not.toMatch(/border-dashed/);
    expect(screen.queryByText(/no photo selected yet/i)).not.toBeInTheDocument();
  });
});

describe("RoomPhotoField, help and error text", () => {
  test("help text is rendered and wired to the input via aria-describedby", () => {
    setup({ helpText: "JPG or PNG of one indoor space." });
    const input = screen.getByLabelText(/space photo/i);
    const help = screen.getByText("JPG or PNG of one indoor space.");
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
        helpText="JPG or PNG of one indoor space."
        error='"image/webp" is not supported. Please choose a PNG or JPEG photo.'
      />
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/not supported/i);
    const describedBy = screen.getByLabelText(/space photo/i).getAttribute("aria-describedby");
    expect(describedBy).toContain(alert.id);
    expect(describedBy).toContain(screen.getByText("JPG or PNG of one indoor space.").id); // help stays associated too
  });
});
