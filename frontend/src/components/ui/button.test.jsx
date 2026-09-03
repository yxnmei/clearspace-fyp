import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { Button, buttonVariants } from "./button";

describe("Button", () => {
  test("renders a native <button> and forwards the ref to it", () => {
    const ref = createRef();
    render(
      <Button ref={ref} type="button">
        Go
      </Button>
    );
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.tagName).toBe("BUTTON");
    expect(ref.current).toBe(button);
  });

  test("does not force a type, native behaviour is preserved", () => {
    render(<Button>No type</Button>);
    // React leaves `type` unset unless the caller provides it.
    expect(screen.getByRole("button", { name: "No type" })).not.toHaveAttribute("type");
  });

  test("forwards arbitrary semantic props (type, name, aria-*, disabled)", () => {
    render(
      <Button type="submit" name="save" aria-label="Save changes" disabled>
        Save
      </Button>
    );
    const button = screen.getByRole("button", { name: "Save changes" });
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toHaveAttribute("name", "save");
    expect(button).toBeDisabled();
  });

  test("click fires; a disabled button does not", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    const { rerender } = render(
      <Button type="button" onClick={onClick}>
        Click
      </Button>
    );
    await user.click(screen.getByRole("button", { name: "Click" }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button type="button" onClick={onClick} disabled>
        Click
      </Button>
    );
    await user.click(screen.getByRole("button", { name: "Click" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("applies default variant/size classes and a visible focus ring", () => {
    render(
      <Button type="button">
        Default
      </Button>
    );
    const cls = screen.getByRole("button", { name: "Default" }).className;
    expect(cls).toMatch(/bg-primary/); // default variant = primary
    expect(cls).toMatch(/h-10/); // default size = md
    expect(cls).toMatch(/focus-visible:ring-2/);
  });

  test("variant and size props switch the class set", () => {
    render(
      <Button type="button" variant="outline" size="lg">
        Outline
      </Button>
    );
    const cls = screen.getByRole("button", { name: "Outline" }).className;
    expect(cls).toMatch(/border border-input/);
    expect(cls).toMatch(/h-12/);
    expect(cls).not.toMatch(/bg-primary\b/);
  });

  test("caller className is merged and wins conflicts via cn()", () => {
    render(
      <Button type="button" className="bg-error">
        Custom
      </Button>
    );
    const cls = screen.getByRole("button", { name: "Custom" }).className;
    expect(cls).toMatch(/bg-error/);
    expect(cls).not.toMatch(/(^|\s)bg-primary(\s|$)/); // tailwind-merge dropped the default fill
  });

  test("buttonVariants is callable directly for non-button elements", () => {
    expect(typeof buttonVariants()).toBe("string");
    expect(buttonVariants({ variant: "ghost" })).toMatch(/hover:bg-accent/);
  });
});
