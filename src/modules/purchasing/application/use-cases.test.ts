/**
 * ユースケースの単体テスト。DB を使わない。
 *
 * ports.ts の口をインメモリで差し替えるので、トランザクションもイベントも
 * このファイルの中で完結する。ここで見たいのは業務の筋であって、
 * SQL が通るかどうかではない (そちらは tests/integration/purchasing.test.ts)。
 */
import { describe, expect, it } from "vitest";
import type { EventName, EventPayload, Quantity } from "../../../shared/events.ts";
import type { PurchaseOrderStatus } from "../domain/purchase-order.ts";
import type { PurchaseSuggestion, SuggestionStatus } from "../domain/suggestion.ts";
import type {
  NewGoodsReceipt,
  NewPurchaseOrder,
  NewSuggestion,
  PurchasingDeps,
  PurchasingRepository,
  Supplier,
  UnitOfWork,
} from "./ports.ts";
import {
  acceptGoodsReceipt,
  listPurchaseSuggestions,
  placePurchaseOrder,
  receiveGoods,
  registerSupplier,
  suggestOrderOnReorderPoint,
} from "./use-cases.ts";

const FLOUR = "aaaaaaaa-0000-4000-8000-000000000001";
const BUTTER = "aaaaaaaa-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-11T00:00:00.000Z");

const g = (amount: number): Quantity => ({ amount, unit: "g" });

type PublishedEvent = { readonly name: EventName; readonly payload: unknown };

/**
 * インメモリの UnitOfWork。
 *
 * publish したイベントを配列に溜めるだけ。実装では同じ tx に乗るので、
 * 「業務データは書けたがイベントが出ていない」はここでは再現しない
 * (それを保証するのは infra/unit-of-work.ts の役目)。
 */
function createFake(): {
  deps: PurchasingDeps;
  uow: UnitOfWork;
  published: PublishedEvent[];
  suggestions: PurchaseSuggestion[];
} {
  let sequence = 0;
  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${prefix}-${String(sequence).padStart(4, "0")}`;
  };

  const suppliers = new Map<string, Supplier>();
  const orders = new Map<string, NewPurchaseOrder & { id: string; status: PurchaseOrderStatus }>();
  const receipts = new Map<string, NewGoodsReceipt & { id: string; acceptedAt: Date | null }>();
  const suggestions: PurchaseSuggestion[] = [];
  const published: PublishedEvent[] = [];

  const repo: PurchasingRepository = {
    async insertSupplier(supplier) {
      const supplierId = nextId("supplier");
      suppliers.set(supplierId, { supplierId, ...supplier });
      return supplierId;
    },
    async findSupplier(supplierId) {
      return suppliers.get(supplierId) ?? null;
    },
    async insertPurchaseOrder(order) {
      const id = nextId("order");
      orders.set(id, { ...order, id, status: "placed" });
      return id;
    },
    async findPurchaseOrder(purchaseOrderId) {
      const stored = orders.get(purchaseOrderId);
      if (stored === undefined) return null;
      return {
        purchaseOrderId: stored.id,
        supplierId: stored.supplierId,
        status: stored.status,
        orderedAt: stored.orderedAt.toISOString(),
        lines: stored.lines,
      };
    },
    async updatePurchaseOrderStatus(purchaseOrderId, status) {
      const stored = orders.get(purchaseOrderId);
      if (stored !== undefined) orders.set(purchaseOrderId, { ...stored, status });
    },
    async insertGoodsReceipt(receipt) {
      const id = nextId("receipt");
      receipts.set(id, { ...receipt, id, acceptedAt: null });
      return id;
    },
    async findGoodsReceipt(goodsReceiptId) {
      const stored = receipts.get(goodsReceiptId);
      if (stored === undefined) return null;
      return {
        goodsReceiptId: stored.id,
        purchaseOrderId: stored.purchaseOrderId,
        receivedAt: stored.receivedAt.toISOString(),
        acceptedAt: stored.acceptedAt === null ? null : stored.acceptedAt.toISOString(),
        lines: stored.lines,
      };
    },
    async markGoodsReceiptAccepted(goodsReceiptId, acceptedAt) {
      const stored = receipts.get(goodsReceiptId);
      if (stored !== undefined) receipts.set(goodsReceiptId, { ...stored, acceptedAt });
    },
    // 本物は部分ユニークインデックスに任せる。ここでは同じ判定を手で書く。
    async insertSuggestionIfNoneOpen(suggestion: NewSuggestion) {
      const duplicate = suggestions.some(
        (existing) =>
          existing.ingredientId === suggestion.ingredientId && existing.status === "open",
      );
      if (duplicate) return null;

      const suggestionId = nextId("suggestion");
      suggestions.push({
        suggestionId,
        ingredientId: suggestion.ingredientId,
        suggestedQuantity: suggestion.suggestedQuantity,
        onHandAtDetection: suggestion.onHandAtDetection,
        status: "open",
        createdAt: suggestion.createdAt.toISOString(),
        purchaseOrderId: null,
      });
      return suggestionId;
    },
    async listSuggestions(status: SuggestionStatus) {
      return suggestions.filter((suggestion) => suggestion.status === status);
    },
    async markSuggestionsOrdered(ingredientIds, purchaseOrderId) {
      let updated = 0;
      for (const [index, suggestion] of suggestions.entries()) {
        if (suggestion.status !== "open") continue;
        if (!ingredientIds.includes(suggestion.ingredientId)) continue;
        suggestions[index] = { ...suggestion, status: "ordered", purchaseOrderId };
        updated += 1;
      }
      return updated;
    },
  };

  const uow: UnitOfWork = {
    repo,
    publish: async <N extends EventName>(name: N, payload: EventPayload<N>) => {
      published.push({ name, payload });
    },
  };

  return {
    deps: { transaction: (run) => run(uow), now: () => NOW },
    uow,
    published,
    suggestions,
  };
}

/** 仕入先 → 発注 まで作る。以降のテストの下ごしらえ。 */
async function placedOrder(deps: PurchasingDeps): Promise<string> {
  const supplierId = await registerSupplier(deps, { name: "山田製粉", leadTimeDays: 2 });
  return placePurchaseOrder(deps, {
    supplierId,
    lines: [
      { ingredientId: FLOUR, quantity: g(10_000) },
      { ingredientId: BUTTER, quantity: g(2_000) },
    ],
  });
}

describe("registerSupplier", () => {
  it("仕入先を登録する", async () => {
    const { deps } = createFake();
    await expect(registerSupplier(deps, { name: "山田製粉", leadTimeDays: 2 })).resolves.toMatch(
      /^supplier-/,
    );
  });

  it("名前が空なら弾く", async () => {
    const { deps } = createFake();
    await expect(registerSupplier(deps, { name: "   ", leadTimeDays: 2 })).rejects.toThrow(
      "名前は必須",
    );
  });

  it("リードタイムが負なら弾く", async () => {
    const { deps } = createFake();
    await expect(registerSupplier(deps, { name: "山田製粉", leadTimeDays: -1 })).rejects.toThrow(
      "0 以上の整数",
    );
  });
});

describe("placePurchaseOrder", () => {
  it("存在しない仕入先には発注できない", async () => {
    const { deps } = createFake();
    await expect(
      placePurchaseOrder(deps, {
        supplierId: "supplier-9999",
        lines: [{ ingredientId: FLOUR, quantity: g(1_000) }],
      }),
    ).rejects.toThrow("仕入先が見つかりません");
  });

  it("発注ではイベントを出さない", async () => {
    // inventory が知りたいのは実際に入ってきた量。在庫が動くのは検収のときだけ。
    const { deps, published } = createFake();
    await placedOrder(deps);
    expect(published).toHaveLength(0);
  });

  it("発注した原材料の未対応提案を発注済みにする", async () => {
    const { deps, uow, suggestions } = createFake();
    await suggestOrderOnReorderPoint(uow, breached(FLOUR));
    expect(suggestions[0]?.status).toBe("open");

    const purchaseOrderId = await placedOrder(deps);

    expect(suggestions[0]?.status).toBe("ordered");
    expect(suggestions[0]?.purchaseOrderId).toBe(purchaseOrderId);
    // 一覧からは消える
    await expect(listPurchaseSuggestions(deps)).resolves.toHaveLength(0);
  });
});

describe("receiveGoods", () => {
  it("入荷ではイベントを出さない (在庫になるのは検収後)", async () => {
    const { deps, published } = createFake();
    const purchaseOrderId = await placedOrder(deps);

    await receiveGoods(deps, {
      purchaseOrderId,
      receivedAt: "2026-09-11T01:00:00.000Z",
      lines: [
        { ingredientId: FLOUR, quantity: g(9_800), lotCode: "LOT-A", bestBefore: "2026-12-31" },
      ],
    });

    expect(published).toHaveLength(0);
  });

  it("入荷すると発注は received になる", async () => {
    const { deps } = createFake();
    const purchaseOrderId = await placedOrder(deps);
    await receiveOnce(deps, purchaseOrderId);

    const order = await deps.transaction((uow) => uow.repo.findPurchaseOrder(purchaseOrderId));
    expect(order?.status).toBe("received");
  });

  it("同じ発注に2回入荷できない", async () => {
    const { deps } = createFake();
    const purchaseOrderId = await placedOrder(deps);
    await receiveOnce(deps, purchaseOrderId);

    await expect(receiveOnce(deps, purchaseOrderId)).rejects.toThrow("既に received");
  });

  it("存在しない発注には入荷できない", async () => {
    const { deps } = createFake();
    await expect(receiveOnce(deps, "order-9999")).rejects.toThrow("発注が見つかりません");
  });
});

describe("acceptGoodsReceipt", () => {
  it("検収したときだけイベントを出す", async () => {
    const { deps, published } = createFake();
    const purchaseOrderId = await placedOrder(deps);
    const goodsReceiptId = await receiveOnce(deps, purchaseOrderId);
    expect(published).toHaveLength(0);

    await acceptGoodsReceipt(deps, {
      goodsReceiptId,
      acceptedAt: "2026-09-11T02:00:00.000Z",
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.name).toBe("purchasing.GoodsReceiptAccepted");
  });

  it("イベントには検収した実数が載る (発注数量ではない)", async () => {
    const { deps, published } = createFake();
    const purchaseOrderId = await placedOrder(deps);
    // 10kg 頼んで 9.8kg 届いた
    const goodsReceiptId = await receiveOnce(deps, purchaseOrderId);

    await acceptGoodsReceipt(deps, { goodsReceiptId, acceptedAt: "2026-09-11T02:00:00.000Z" });

    const payload = published[0]?.payload as EventPayload<"purchasing.GoodsReceiptAccepted">;
    expect(payload.lines).toEqual([
      {
        ingredientId: FLOUR,
        quantity: g(9_800),
        lotCode: "LOT-A",
        bestBefore: "2026-12-31",
      },
    ]);
    expect(payload.purchaseOrderId).toBe(purchaseOrderId);
    expect(payload.acceptedAt).toBe("2026-09-11T02:00:00.000Z");
  });

  it("差異のあった原材料を返す", async () => {
    const { deps } = createFake();
    const purchaseOrderId = await placedOrder(deps);
    const goodsReceiptId = await receiveOnce(deps, purchaseOrderId);

    const result = await acceptGoodsReceipt(deps, {
      goodsReceiptId,
      acceptedAt: "2026-09-11T02:00:00.000Z",
    });

    // 強力粉は 200g 不足、バターは丸ごと欠品。
    expect(result.variances).toEqual([FLOUR, BUTTER]);
  });

  it("二重検収はできない (inventory が2回入庫しないため)", async () => {
    const { deps, published } = createFake();
    const purchaseOrderId = await placedOrder(deps);
    const goodsReceiptId = await receiveOnce(deps, purchaseOrderId);
    await acceptGoodsReceipt(deps, { goodsReceiptId, acceptedAt: "2026-09-11T02:00:00.000Z" });

    await expect(
      acceptGoodsReceipt(deps, { goodsReceiptId, acceptedAt: "2026-09-11T03:00:00.000Z" }),
    ).rejects.toThrow("既に");

    expect(published).toHaveLength(1);
  });

  it("検収すると発注は accepted になる", async () => {
    const { deps } = createFake();
    const purchaseOrderId = await placedOrder(deps);
    const goodsReceiptId = await receiveOnce(deps, purchaseOrderId);
    await acceptGoodsReceipt(deps, { goodsReceiptId, acceptedAt: "2026-09-11T02:00:00.000Z" });

    const order = await deps.transaction((uow) => uow.repo.findPurchaseOrder(purchaseOrderId));
    expect(order?.status).toBe("accepted");
  });

  it("存在しない入荷は検収できない", async () => {
    const { deps } = createFake();
    await expect(
      acceptGoodsReceipt(deps, {
        goodsReceiptId: "receipt-9999",
        acceptedAt: "2026-09-11T02:00:00.000Z",
      }),
    ).rejects.toThrow("入荷が見つかりません");
  });
});

describe("suggestOrderOnReorderPoint", () => {
  it("発注点割れから提案を作る", async () => {
    const { deps, uow } = createFake();
    await suggestOrderOnReorderPoint(uow, breached(FLOUR));

    const suggestions = await listPurchaseSuggestions(deps);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      ingredientId: FLOUR,
      suggestedQuantity: g(25_000),
      onHandAtDetection: g(1_200),
    });
  });

  it("自動発注はしない (提案が増えるだけで発注は増えない)", async () => {
    const { deps, uow, published } = createFake();
    await suggestOrderOnReorderPoint(uow, breached(FLOUR));

    expect(published).toHaveLength(0);
    const suggestions = await listPurchaseSuggestions(deps);
    expect(suggestions[0]?.suggestionId).toBeDefined();
  });

  it("未対応の提案が既にあれば重複して作らない", async () => {
    // イベントは at-least-once。業務的にも在庫が発注点付近を行き来すれば何度も飛ぶ。
    const { deps, uow } = createFake();
    await suggestOrderOnReorderPoint(uow, breached(FLOUR));
    const second = await suggestOrderOnReorderPoint(uow, breached(FLOUR));

    expect(second).toBeNull();
    await expect(listPurchaseSuggestions(deps)).resolves.toHaveLength(1);
  });

  it("発注済みになった後なら同じ原材料でもう一度提案できる", async () => {
    const { deps, uow, suggestions } = createFake();
    await suggestOrderOnReorderPoint(uow, breached(FLOUR));
    await placedOrder(deps);
    expect(suggestions[0]?.status).toBe("ordered");

    const again = await suggestOrderOnReorderPoint(uow, breached(FLOUR));

    expect(again).not.toBeNull();
    await expect(listPurchaseSuggestions(deps)).resolves.toHaveLength(1);
  });

  it("別の原材料の提案は独立して作られる", async () => {
    const { deps, uow } = createFake();
    await suggestOrderOnReorderPoint(uow, breached(FLOUR));
    await suggestOrderOnReorderPoint(uow, breached(BUTTER));

    await expect(listPurchaseSuggestions(deps)).resolves.toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

function breached(ingredientId: string): EventPayload<"inventory.ReorderPointBreached"> {
  return {
    ingredientId,
    onHand: g(1_200),
    reorderPoint: g(2_000),
    suggestedOrderQuantity: g(25_000),
    detectedAt: "2026-09-11T00:00:00.000Z",
  };
}

/** 強力粉だけ 9.8kg 入荷する (バターは欠品)。差異を持つ入荷。 */
function receiveOnce(deps: PurchasingDeps, purchaseOrderId: string): Promise<string> {
  return receiveGoods(deps, {
    purchaseOrderId,
    receivedAt: "2026-09-11T01:00:00.000Z",
    lines: [
      { ingredientId: FLOUR, quantity: g(9_800), lotCode: "LOT-A", bestBefore: "2026-12-31" },
    ],
  });
}
