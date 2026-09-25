import { describe, expect, test } from "vitest";
import {
  LISTING_CONDITIONS,
  DEFAULT_LISTING_CONDITION,
  LISTING_NAME_MAX,
  isListingCondition,
  listingConditionLabel,
  resolveListingDetails,
  serialiseListingDetails,
  listingDetailsMatch,
} from "./listingDrafts";

describe("listing details helpers", () => {
  test("the condition list mirrors the backend enum with Not specified first", () => {
    expect(LISTING_CONDITIONS.map((c) => c.value)).toEqual([
      "not_specified",
      "new",
      "like_new",
      "good",
      "fair",
      "well_used",
    ]);
    expect(DEFAULT_LISTING_CONDITION).toBe("not_specified");
    expect(isListingCondition("good")).toBe(true);
    expect(isListingCondition("mint")).toBe(false);
    expect(listingConditionLabel("like_new")).toBe("Like new");
    expect(listingConditionLabel("nope")).toBe("Not specified");
  });

  test("resolveListingDetails defaults to the reviewed label and not specified, and prefers explicit values", () => {
    const reviewItem = { item_id: "item_001", effective_label: "lamp" };
    expect(resolveListingDetails("item_001", {}, reviewItem)).toEqual({ listing_name: "lamp", condition: "not_specified" });
    expect(resolveListingDetails("item_001", { item_001: { condition: "good" } }, reviewItem)).toEqual({
      listing_name: "lamp",
      condition: "good",
    });
    // an explicitly cleared name stays cleared rather than snapping back
    expect(resolveListingDetails("item_001", { item_001: { listing_name: "" } }, reviewItem).listing_name).toBe("");
    expect(resolveListingDetails("item_001", { item_001: { condition: "bogus" } }, reviewItem).condition).toBe(
      "not_specified"
    );
  });

  test("serialiseListingDetails keeps the given order, joins by item_id, trims, bounds and sends blank as null", () => {
    const reviewItems = [
      { item_id: "item_001", effective_label: "lamp" },
      { item_id: "item_003", effective_label: "lamp" },
    ];
    const details = {
      item_003: { listing_name: "  Brass lamp  ", condition: "fair" },
      item_001: { listing_name: "   " },
    };
    expect(serialiseListingDetails(["item_003", "item_001"], details, reviewItems)).toEqual([
      { item_id: "item_003", listing_name: "Brass lamp", condition: "fair" },
      { item_id: "item_001", listing_name: null, condition: "not_specified" },
    ]);
    const long = serialiseListingDetails(["item_001"], { item_001: { listing_name: "x".repeat(100) } }, reviewItems);
    expect(long[0].listing_name).toHaveLength(LISTING_NAME_MAX);
  });

  test("listingDetailsMatch compares on the request shape", () => {
    expect(
      listingDetailsMatch({ listing_name: "lamp", condition: "good" }, { listing_name: " lamp ", condition: "good" })
    ).toBe(true);
    expect(
      listingDetailsMatch(
        { listing_name: null, condition: "not_specified" },
        { listing_name: "  ", condition: "not_specified" }
      )
    ).toBe(true);
    expect(
      listingDetailsMatch({ listing_name: "lamp", condition: "good" }, { listing_name: "lamp", condition: "fair" })
    ).toBe(false);
    expect(
      listingDetailsMatch({ listing_name: "lamp", condition: "good" }, { listing_name: "Lamp A", condition: "good" })
    ).toBe(false);
    expect(listingDetailsMatch(null, { listing_name: "lamp", condition: "good" })).toBe(false);
  });
});
