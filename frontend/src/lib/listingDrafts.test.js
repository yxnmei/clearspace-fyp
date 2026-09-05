import { describe, expect, test } from "vitest";
import {
  TITLE_MIN,
  TITLE_MAX,
  DESCRIPTION_MIN,
  DESCRIPTION_MAX,
  UNAVAILABLE_REASON_MESSAGES,
  unavailableReasonMessage,
  fieldValidity,
  draftEditValidity,
  formatListingClipboardText,
  deriveEligibleSellItemIds,
} from "./listingDrafts";

describe("listingDrafts helpers", () => {
  describe("bounds mirror the backend", () => {
    test("title 2..120, description 10..1200", () => {
      expect([TITLE_MIN, TITLE_MAX]).toEqual([2, 120]);
      expect([DESCRIPTION_MIN, DESCRIPTION_MAX]).toEqual([10, 1200]);
    });
  });

  describe("unavailableReasonMessage", () => {
    test.each(["timeout", "service_unavailable", "invalid_output", "generation_failed"])(
      "maps the known reason %s to its friendly, non-technical message",
      (reason) => {
        expect(unavailableReasonMessage(reason)).toBe(UNAVAILABLE_REASON_MESSAGES[reason]);
        expect(unavailableReasonMessage(reason)).toMatch(/regenerat/i);
      }
    );

    test("an unknown or missing reason falls back to a safe generic sentence, never throwing", () => {
      expect(() => unavailableReasonMessage(undefined)).not.toThrow();
      expect(unavailableReasonMessage("something-else")).toMatch(/could not be generated/i);
      expect(unavailableReasonMessage(null)).toMatch(/could not be generated/i);
    });

    test("no message contains a literal em dash", () => {
      for (const message of Object.values(UNAVAILABLE_REASON_MESSAGES)) {
        expect(message.includes(String.fromCharCode(0x2014))).toBe(false);
      }
    });
  });

  describe("fieldValidity", () => {
    test("measures trimmed length and does not mutate the input", () => {
      const v = fieldValidity("  hello  ", 2, 10);
      expect(v.trimmedLength).toBe(5);
      expect(v.valid).toBe(true);
      expect(v.tooShort).toBe(false);
      expect(v.tooLong).toBe(false);
    });

    test("flags too-short and too-long by trimmed length", () => {
      expect(fieldValidity(" a ", 2, 10)).toMatchObject({ tooShort: true, valid: false });
      expect(fieldValidity("x".repeat(11), 2, 10)).toMatchObject({ tooLong: true, valid: false });
    });

    test("a non-string is treated as empty", () => {
      expect(fieldValidity(undefined, 2, 10)).toMatchObject({ trimmedLength: 0, valid: false });
    });
  });

  describe("draftEditValidity", () => {
    test("valid only when both fields are within bounds", () => {
      expect(draftEditValidity("ok", "a description that is long enough").valid).toBe(true);
      expect(draftEditValidity("", "a description that is long enough").valid).toBe(false);
      expect(draftEditValidity("ok", "short").valid).toBe(false);
    });

    test("intermediate invalid input is reported, not rejected", () => {
      const v = draftEditValidity("o", "short");
      expect(v.title.tooShort).toBe(true);
      expect(v.description.tooShort).toBe(true);
      expect(v.valid).toBe(false);
    });
  });

  describe("formatListingClipboardText", () => {
    test("joins verbatim title and description with one blank line, no trimming", () => {
      expect(formatListingClipboardText("  Title  ", "  Body  ")).toBe("  Title  \n\n  Body  ");
    });
  });

  describe("deriveEligibleSellItemIds", () => {
    const decisions = [
      { item_id: "item_001", confirmed_decision: "sell", excluded: false },
      { item_id: "item_002", confirmed_decision: "keep", excluded: false },
      { item_id: "item_003", confirmed_decision: "sell", excluded: true },
      { item_id: "item_004", confirmed_decision: "sell", excluded: false },
    ];

    test("returns confirmed non-excluded Sell ids in confirmation order", () => {
      expect(deriveEligibleSellItemIds({ confirmedDecisions: decisions })).toEqual(["item_001", "item_004"]);
    });

    test("a missing or malformed confirmation yields an empty list, not an error", () => {
      expect(deriveEligibleSellItemIds(null)).toEqual([]);
      expect(deriveEligibleSellItemIds({})).toEqual([]);
      expect(deriveEligibleSellItemIds({ confirmedDecisions: "nope" })).toEqual([]);
    });

    test("does not use labels, Keep ids, or any other field for eligibility", () => {
      const confirmation = {
        confirmedDecisions: [{ item_id: "item_009", confirmed_decision: "donate", excluded: false }],
        confirmedKeepIds: ["item_009"],
      };
      expect(deriveEligibleSellItemIds(confirmation)).toEqual([]);
    });
  });
});
