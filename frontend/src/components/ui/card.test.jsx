import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "./card";

describe("Card primitives", () => {
  test("compose into a labelled region without inventing semantics", () => {
    render(
      <Card aria-label="Plan">
        <CardHeader>
          <CardTitle>Room plan</CardTitle>
          <CardDescription>What stays where</CardDescription>
        </CardHeader>
        <CardContent>body</CardContent>
        <CardFooter>footer</CardFooter>
      </Card>
    );

    // CardTitle is a real heading
    expect(screen.getByRole("heading", { name: "Room plan" }).tagName).toBe("H3");
    expect(screen.getByText("What stays where").tagName).toBe("P");
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.getByText("footer")).toBeInTheDocument();
  });

  test("each part forwards refs and className (merged) and spreads props", () => {
    const cardRef = createRef();
    const titleRef = createRef();
    render(
      <Card ref={cardRef} className="mt-4" data-testid="card">
        <CardTitle ref={titleRef} className="text-foreground">
          T
        </CardTitle>
      </Card>
    );

    expect(cardRef.current).toBe(screen.getByTestId("card"));
    expect(cardRef.current.className).toMatch(/rounded-card/); // base token kept
    expect(cardRef.current.className).toMatch(/mt-4/); // caller class merged
    expect(titleRef.current.tagName).toBe("H3");
  });
});
