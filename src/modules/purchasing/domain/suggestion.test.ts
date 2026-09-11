/** 発注提案の状態遷移。自動発注しないという判断がここに現れる。 */
import { describe, expect, it } from "vitest";
import type { PurchaseSuggestion } from "./suggestion.ts";
import { hasOpenSuggestionFor, isOpen, markOrdered, markRejected } from "./suggestion.ts";

const FLOUR = "aaaaaaaa-0000-4000-8000-000000000001";
const BUTTER = "aaaaaaaa-0000-4000-8000-000000000002";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";

function suggestion(overrides: Partial<PurchaseSuggestion> = {}): PurchaseSuggestion {
  return {
    suggestionId: "44444444-4444-4444-8444-444444444444",
    ingredientId: FLOUR,
    suggestedQuantity: { amount: 25_000, unit: "g" },
    onHandAtDetection: { amount: 1_200, unit: "g" },
    status: "open",
    createdAt: "2026-09-11T00:00:00.000Z",
    purchaseOrderId: null,
    ...overrides,
  };
}

describe("提案の状態遷移", () => {
  it("未対応から発注済みに進める", () => {
    const ordered = markOrdered(suggestion(), ORDER_ID);

    expect(ordered.status).toBe("ordered");
    expect(ordered.purchaseOrderId).toBe(ORDER_ID);
    expect(isOpen(ordered)).toBe(false);
  });

  it("未対応から却下に進める", () => {
    expect(markRejected(suggestion()).status).toBe("rejected");
  });

  it("発注済みの提案をもう一度発注済みにはできない", () => {
    // 提案と発注の対応が追えなくなるため。
    expect(() => markOrdered(suggestion({ status: "ordered" }), ORDER_ID)).toThrow("既に ordered");
  });

  it("却下した提案を後から発注済みにはできない", () => {
    expect(() => markOrdered(suggestion({ status: "rejected" }), ORDER_ID)).toThrow(
      "既に rejected",
    );
  });
});

describe("未対応の提案があるか", () => {
  it("同じ原材料に未対応があれば true", () => {
    expect(hasOpenSuggestionFor([suggestion()], FLOUR)).toBe(true);
  });

  it("発注済みしか無ければ false (もう一度提案してよい)", () => {
    expect(hasOpenSuggestionFor([suggestion({ status: "ordered" })], FLOUR)).toBe(false);
  });

  it("別の原材料の未対応は数えない", () => {
    expect(hasOpenSuggestionFor([suggestion()], BUTTER)).toBe(false);
  });
});
