/**
 * ユースケースと購読ハンドラの単体テスト。DB を使わない。
 *
 * ports.ts の口をインメモリで差し替えるので、トランザクションもイベントも
 * このファイルの中で完結する。ここで見たいのは業務の筋であって、
 * SQL が通るかどうかではない (そちらは tests/integration/inventory.test.ts)。
 */
import { describe, expect, it } from "vitest";
import type { EventName, EventPayload, Quantity } from "../../../shared/events.ts";
import type { Ingredient } from "../domain/ingredient.ts";
import type { IngredientLot } from "../domain/ingredient-lot.ts";
import type { ProductLot } from "../domain/product-lot.ts";
import type { StocktakeDiff } from "../domain/stocktake.ts";
import { consumeAndStockProduction, receiveAcceptedGoods, shipSoldProducts } from "./handlers.ts";
import type { InventoryDeps, InventoryRepository, UnitOfWork } from "./ports.ts";
import {
  getIngredientStock,
  listStockAlerts,
  recordStocktake,
  registerIngredient,
  setReorderPoint,
} from "./use-cases.ts";

const FLOUR = "aaaaaaaa-0000-4000-8000-000000000001";
const BUTTER = "aaaaaaaa-0000-4000-8000-000000000002";
const CROISSANT = "bbbbbbbb-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-11T00:00:00.000Z");

const g = (amount: number): Quantity => ({ amount, unit: "g" });
const pieces = (amount: number): Quantity => ({ amount, unit: "piece" });

type PublishedEvent = { readonly name: EventName; readonly payload: unknown };

type Fake = {
  deps: InventoryDeps;
  uow: UnitOfWork;
  published: PublishedEvent[];
  stocktakes: { countedAt: Date; diffs: readonly StocktakeDiff[] }[];
  ingredients: Map<string, Ingredient>;
  lots: IngredientLot[];
  productLots: Map<string, ProductLot>;
};

function createFake(): Fake {
  let sequence = 0;
  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${prefix}-${String(sequence).padStart(4, "0")}`;
  };

  const ingredients = new Map<string, Ingredient>();
  const lots: IngredientLot[] = [];
  const productLots = new Map<string, ProductLot>();
  const stocktakes: { countedAt: Date; diffs: readonly StocktakeDiff[] }[] = [];
  const published: PublishedEvent[] = [];

  const repo: InventoryRepository = {
    async insertIngredient(input) {
      const ingredientId = nextId("ingredient");
      ingredients.set(ingredientId, {
        ingredientId,
        name: input.name,
        unit: input.unit,
        onHand: { amount: 0, unit: input.unit },
        reorderPoint: input.reorderPoint,
        belowReorderPoint: false,
      });
      return ingredientId;
    },
    async ensureIngredient(ingredientId, unit) {
      const existing = ingredients.get(ingredientId);
      if (existing !== undefined) return existing;
      const created: Ingredient = {
        ingredientId,
        name: `未登録原材料 ${ingredientId}`,
        unit,
        onHand: { amount: 0, unit },
        reorderPoint: { amount: 0, unit },
        belowReorderPoint: false,
      };
      ingredients.set(ingredientId, created);
      return created;
    },
    async findIngredient(ingredientId) {
      return ingredients.get(ingredientId) ?? null;
    },
    async listIngredients() {
      return [...ingredients.values()];
    },
    async updateReorderPoint(ingredientId, reorderPoint) {
      const current = ingredients.get(ingredientId);
      if (current !== undefined) ingredients.set(ingredientId, { ...current, reorderPoint });
    },
    async updateIngredientStock(ingredientId, onHand, belowReorderPoint) {
      const current = ingredients.get(ingredientId);
      if (current !== undefined) {
        ingredients.set(ingredientId, { ...current, onHand, belowReorderPoint });
      }
    },
    async insertIngredientLot(lot) {
      lots.push({
        lotId: nextId("lot"),
        ingredientId: lot.ingredientId,
        lotCode: lot.lotCode,
        bestBefore: lot.bestBefore,
        remaining: lot.amount,
        receivedAt: lot.receivedAt.toISOString(),
      });
    },
    async listOpenLots(ingredientId) {
      return lots.filter((lot) => lot.ingredientId === ingredientId && lot.remaining.amount !== 0);
    },
    async listAllOpenLots() {
      return lots.filter((lot) => lot.remaining.amount !== 0);
    },
    async updateLotRemaining(lotId, remaining) {
      const index = lots.findIndex((lot) => lot.lotId === lotId);
      const current = lots[index];
      if (current !== undefined) lots[index] = { ...current, remaining };
    },
    async findProductLot(lotCode) {
      return productLots.get(lotCode) ?? null;
    },
    async listProductLots() {
      return [...productLots.values()].filter((lot) => lot.onHand.amount !== 0);
    },
    async stockProductLot(lot) {
      const current = productLots.get(lot.lotCode);
      productLots.set(lot.lotCode, {
        lotCode: lot.lotCode,
        productId: lot.productId,
        onHand: pieces((current?.onHand.amount ?? 0) + lot.quantity.amount),
        bestBefore: lot.bestBefore,
        producedAt: lot.producedAt,
        provisional: false,
      });
    },
    async ensureProvisionalProductLot(lot) {
      const existing = productLots.get(lot.lotCode);
      if (existing !== undefined) return existing;
      const created: ProductLot = {
        lotCode: lot.lotCode,
        productId: lot.productId,
        onHand: pieces(0),
        bestBefore: lot.bestBefore,
        producedAt: lot.producedAt,
        provisional: true,
      };
      productLots.set(lot.lotCode, created);
      return created;
    },
    async updateProductLotOnHand(lotCode, onHand) {
      const current = productLots.get(lotCode);
      if (current !== undefined) productLots.set(lotCode, { ...current, onHand });
    },
    async insertStocktake(countedAt, diffs) {
      stocktakes.push({ countedAt, diffs });
      return nextId("stocktake");
    },
  };

  const uow: UnitOfWork = {
    repo,
    publish: async (name, payload) => {
      published.push({ name, payload });
    },
  };

  return {
    deps: { transaction: (run) => run(uow), now: () => NOW },
    uow,
    published,
    stocktakes,
    ingredients,
    lots,
    productLots,
  };
}

const goodsReceipt = (
  lines: EventPayload<"purchasing.GoodsReceiptAccepted">["lines"],
): EventPayload<"purchasing.GoodsReceiptAccepted"> => ({
  goodsReceiptId: "cccccccc-0000-4000-8000-000000000001",
  purchaseOrderId: "cccccccc-0000-4000-8000-000000000002",
  supplierId: "cccccccc-0000-4000-8000-000000000003",
  acceptedAt: "2026-09-11T01:00:00.000Z",
  lines,
});

const productionCompleted = (
  consumed: EventPayload<"production.ProductionCompleted">["consumedIngredients"],
  producedQuantity = pieces(24),
): EventPayload<"production.ProductionCompleted"> => ({
  productionRunId: "dddddddd-0000-4000-8000-000000000001",
  productionPlanId: "dddddddd-0000-4000-8000-000000000002",
  productId: CROISSANT,
  recipeId: "dddddddd-0000-4000-8000-000000000003",
  producedQuantity,
  lotCode: "CR-20260911-01",
  bestBefore: "2026-09-11",
  completedAt: "2026-09-11T06:00:00.000Z",
  consumedIngredients: consumed,
});

const saleCompleted = (
  lines: EventPayload<"sales.SaleCompleted">["lines"],
): EventPayload<"sales.SaleCompleted"> => ({
  saleId: "eeeeeeee-0000-4000-8000-000000000001",
  channel: "storefront",
  soldAt: "2026-09-11T07:42:00.000Z",
  lines,
  totalJpy: lines.reduce((sum, line) => sum + line.unitPriceJpy * line.quantity.amount, 0),
});

// ---------------------------------------------------------------------------

describe("registerIngredient", () => {
  it("採番した ingredientId を返す", async () => {
    const fake = createFake();
    const ingredientId = await registerIngredient(fake.deps, {
      name: "強力粉",
      unit: "g",
      reorderPoint: g(5000),
    });
    expect(await getIngredientStock(fake.deps, ingredientId)).toEqual({
      ingredientId,
      name: "強力粉",
      onHand: g(0),
      reorderPoint: g(5000),
      nearestBestBefore: null,
    });
  });

  it("名前が空なら弾く", async () => {
    const fake = createFake();
    await expect(
      registerIngredient(fake.deps, { name: "  ", unit: "g", reorderPoint: g(1) }),
    ).rejects.toThrow("名前は必須");
  });

  it("発注点の単位が原材料と違えば弾く", async () => {
    const fake = createFake();
    await expect(
      registerIngredient(fake.deps, { name: "牛乳", unit: "ml", reorderPoint: g(1000) }),
    ).rejects.toThrow("単位が一致しません");
  });
});

describe("purchasing.GoodsReceiptAccepted → 入庫", () => {
  it("検収済みの原材料がロットごと在庫になる", async () => {
    const fake = createFake();
    await receiveAcceptedGoods(
      fake.uow,
      goodsReceipt([
        { ingredientId: FLOUR, quantity: g(10_000), lotCode: "S-1", bestBefore: "2026-10-01" },
      ]),
    );

    expect(fake.ingredients.get(FLOUR)?.onHand).toEqual(g(10_000));
    expect(fake.lots).toHaveLength(1);
    expect(fake.lots[0]?.lotCode).toBe("S-1");
  });

  it("同じ原材料が2行あっても両方足し込む", async () => {
    const fake = createFake();
    await receiveAcceptedGoods(
      fake.uow,
      goodsReceipt([
        { ingredientId: FLOUR, quantity: g(10_000), lotCode: "S-1", bestBefore: "2026-10-01" },
        { ingredientId: FLOUR, quantity: g(5_000), lotCode: "S-2", bestBefore: "2026-09-20" },
      ]),
    );

    expect(fake.ingredients.get(FLOUR)?.onHand).toEqual(g(15_000));
  });
});

describe("production.ProductionCompleted → 消費と製品入庫", () => {
  it("イベントの消費内訳をそのまま信じて原材料を減らし、製品ロットを入庫する", async () => {
    const fake = createFake();
    await receiveAcceptedGoods(
      fake.uow,
      goodsReceipt([
        { ingredientId: FLOUR, quantity: g(10_000), lotCode: "S-1", bestBefore: "2026-10-01" },
      ]),
    );

    await consumeAndStockProduction(
      fake.uow,
      productionCompleted([{ ingredientId: FLOUR, quantity: g(1_440) }]),
    );

    expect(fake.ingredients.get(FLOUR)?.onHand).toEqual(g(8_560));
    expect(fake.productLots.get("CR-20260911-01")).toMatchObject({
      productId: CROISSANT,
      onHand: pieces(24),
      provisional: false,
    });
  });

  it("FEFO: 賞味期限の早いロットから払い出す", async () => {
    const fake = createFake();
    await receiveAcceptedGoods(
      fake.uow,
      goodsReceipt([
        { ingredientId: FLOUR, quantity: g(1_000), lotCode: "LATE", bestBefore: "2026-10-01" },
        { ingredientId: FLOUR, quantity: g(1_000), lotCode: "SOON", bestBefore: "2026-09-15" },
      ]),
    );

    await consumeAndStockProduction(
      fake.uow,
      productionCompleted([{ ingredientId: FLOUR, quantity: g(1_200) }]),
    );

    const byLotCode = new Map(fake.lots.map((lot) => [lot.lotCode, lot.remaining.amount]));
    expect(byLotCode.get("SOON")).toBe(0);
    expect(byLotCode.get("LATE")).toBe(800);
  });

  it("在庫が足りなくても失敗せず、マイナスをアラートとして出す", async () => {
    // 結果整合。入荷検収がまだ届いていないだけかもしれないので処理は止めない。
    const fake = createFake();

    await expect(
      consumeAndStockProduction(
        fake.uow,
        productionCompleted([{ ingredientId: BUTTER, quantity: g(600) }]),
      ),
    ).resolves.toBeUndefined();

    expect(fake.ingredients.get(BUTTER)?.onHand).toEqual(g(-600));
    expect(await listStockAlerts(fake.deps)).toContainEqual({
      kind: "negative_ingredient_stock",
      ingredientId: BUTTER,
      onHand: g(-600),
    });
  });

  it("マイナスの後に入荷が届いたら、その入荷から不足分が相殺される", async () => {
    const fake = createFake();
    await consumeAndStockProduction(
      fake.uow,
      productionCompleted([{ ingredientId: BUTTER, quantity: g(600) }]),
    );

    await receiveAcceptedGoods(
      fake.uow,
      goodsReceipt([
        { ingredientId: BUTTER, quantity: g(1_000), lotCode: "B-1", bestBefore: "2026-09-30" },
      ]),
    );

    expect(fake.ingredients.get(BUTTER)?.onHand).toEqual(g(400));
    // 帳簿在庫とロット残の辻褄が合っている (裏付けの無い不足が残らない)。
    expect(fake.lots.find((lot) => lot.lotCode === "B-1")?.remaining).toEqual(g(400));
  });
});

describe("sales.SaleCompleted → 出庫", () => {
  it("売れた分だけ製品ロットから出庫する", async () => {
    const fake = createFake();
    await consumeAndStockProduction(
      fake.uow,
      productionCompleted([{ ingredientId: FLOUR, quantity: g(1_440) }]),
    );

    await shipSoldProducts(
      fake.uow,
      saleCompleted([
        { productId: CROISSANT, lotCode: "CR-20260911-01", quantity: pieces(2), unitPriceJpy: 280 },
      ]),
    );

    expect(fake.productLots.get("CR-20260911-01")?.onHand).toEqual(pieces(22));
  });

  it("製造完了より先に届いても失敗せず、仮ロットにマイナスで受ける", async () => {
    const fake = createFake();

    await expect(
      shipSoldProducts(
        fake.uow,
        saleCompleted([
          {
            productId: CROISSANT,
            lotCode: "CR-20260911-01",
            quantity: pieces(2),
            unitPriceJpy: 280,
          },
        ]),
      ),
    ).resolves.toBeUndefined();

    expect(fake.productLots.get("CR-20260911-01")).toMatchObject({
      onHand: pieces(-2),
      provisional: true,
    });
    expect(await listStockAlerts(fake.deps)).toContainEqual({
      kind: "negative_product_stock",
      lotCode: "CR-20260911-01",
      onHand: pieces(-2),
    });
  });

  it("後から製造完了が届けば本物の値に直り、数量も足し込まれる", async () => {
    const fake = createFake();
    await shipSoldProducts(
      fake.uow,
      saleCompleted([
        { productId: CROISSANT, lotCode: "CR-20260911-01", quantity: pieces(2), unitPriceJpy: 280 },
      ]),
    );

    await consumeAndStockProduction(
      fake.uow,
      productionCompleted([{ ingredientId: FLOUR, quantity: g(1_440) }]),
    );

    expect(fake.productLots.get("CR-20260911-01")).toMatchObject({
      onHand: pieces(22),
      bestBefore: "2026-09-11",
      provisional: false,
    });
  });
});

describe("発注点割れの発行", () => {
  const setup = async (): Promise<Fake> => {
    const fake = createFake();
    await fake.uow.repo.ensureIngredient(FLOUR, "g");
    await fake.uow.repo.updateReorderPoint(FLOUR, g(5_000));
    await receiveAcceptedGoods(
      fake.uow,
      goodsReceipt([
        { ingredientId: FLOUR, quantity: g(10_000), lotCode: "S-1", bestBefore: "2026-10-01" },
      ]),
    );
    return fake;
  };

  const breaches = (fake: Fake): PublishedEvent[] =>
    fake.published.filter((event) => event.name === "inventory.ReorderPointBreached");

  it("下回った瞬間に1回だけ発行する", async () => {
    const fake = await setup();

    await consumeAndStockProduction(
      fake.uow,
      productionCompleted([{ ingredientId: FLOUR, quantity: g(6_000) }]),
    );

    expect(breaches(fake)).toHaveLength(1);
    expect(breaches(fake)[0]?.payload).toMatchObject({
      ingredientId: FLOUR,
      onHand: g(4_000),
      reorderPoint: g(5_000),
      // 発注点の2倍まで戻す提案。
      suggestedOrderQuantity: g(6_000),
    });
  });

  it("下回っている間ずっとは発行しない", async () => {
    const fake = await setup();
    await consumeAndStockProduction(
      fake.uow,
      productionCompleted([{ ingredientId: FLOUR, quantity: g(6_000) }]),
    );
    await consumeAndStockProduction(
      fake.uow,
      productionCompleted([{ ingredientId: FLOUR, quantity: g(1_000) }]),
    );

    expect(breaches(fake)).toHaveLength(1);
  });

  it("入荷で上回ってからまた下回れば、もう一度発行する", async () => {
    const fake = await setup();
    await consumeAndStockProduction(
      fake.uow,
      productionCompleted([{ ingredientId: FLOUR, quantity: g(6_000) }]),
    );
    await receiveAcceptedGoods(
      fake.uow,
      goodsReceipt([
        { ingredientId: FLOUR, quantity: g(10_000), lotCode: "S-2", bestBefore: "2026-10-10" },
      ]),
    );
    await consumeAndStockProduction(
      fake.uow,
      productionCompleted([{ ingredientId: FLOUR, quantity: g(12_000) }]),
    );

    expect(breaches(fake)).toHaveLength(2);
  });

  it("発注点を上げて在庫が足りなくなったときも発行する", async () => {
    const fake = await setup();

    await setReorderPoint(fake.deps, { ingredientId: FLOUR, reorderPoint: g(20_000) });

    expect(breaches(fake)).toHaveLength(1);
  });
});

describe("recordStocktake", () => {
  it("実地の数が新しい帳簿在庫になり、差分が記録される", async () => {
    const fake = createFake();
    await receiveAcceptedGoods(
      fake.uow,
      goodsReceipt([
        { ingredientId: FLOUR, quantity: g(10_000), lotCode: "S-1", bestBefore: "2026-10-01" },
      ]),
    );

    await recordStocktake(fake.deps, {
      countedAt: "2026-09-11T20:00:00.000Z",
      ingredients: [{ ingredientId: FLOUR, counted: g(9_800) }],
      productLots: [],
    });

    expect(fake.ingredients.get(FLOUR)?.onHand).toEqual(g(9_800));
    // ズレが常態化していることに後から気づけるよう、差分を残す。
    expect(fake.stocktakes[0]?.diffs[0]).toMatchObject({
      book: g(10_000),
      counted: g(9_800),
      diff: g(-200),
    });
    // 減った分はロットからも FEFO で引かれる。
    expect(fake.lots[0]?.remaining).toEqual(g(9_800));
  });

  it("マイナスの在庫を棚卸で正の実数に戻せる", async () => {
    const fake = createFake();
    await consumeAndStockProduction(
      fake.uow,
      productionCompleted([{ ingredientId: BUTTER, quantity: g(600) }]),
    );

    await recordStocktake(fake.deps, {
      countedAt: "2026-09-11T20:00:00.000Z",
      ingredients: [{ ingredientId: BUTTER, counted: g(2_000) }],
      productLots: [],
    });

    expect(fake.ingredients.get(BUTTER)?.onHand).toEqual(g(2_000));
    expect(await listStockAlerts(fake.deps)).toEqual([]);
  });

  it("知らない原材料は止める (人が直すべき入力ミス)", async () => {
    const fake = createFake();
    await expect(
      recordStocktake(fake.deps, {
        countedAt: "2026-09-11T20:00:00.000Z",
        ingredients: [{ ingredientId: FLOUR, counted: g(1) }],
        productLots: [],
      }),
    ).rejects.toThrow("原材料が見つかりません");
  });

  it("実地在庫がマイナスの入力は弾く (棚に -2kg は置けない)", async () => {
    const fake = createFake();
    await fake.uow.repo.ensureIngredient(FLOUR, "g");
    await expect(
      recordStocktake(fake.deps, {
        countedAt: "2026-09-11T20:00:00.000Z",
        ingredients: [{ ingredientId: FLOUR, counted: g(-1) }],
        productLots: [],
      }),
    ).rejects.toThrow("0 以上");
  });

  it("製品ロットの売れ残りを数えて 0 にできる (当日限りなので日次で廃棄になる)", async () => {
    const fake = createFake();
    await consumeAndStockProduction(
      fake.uow,
      productionCompleted([{ ingredientId: FLOUR, quantity: g(1_440) }]),
    );

    await recordStocktake(fake.deps, {
      countedAt: "2026-09-11T20:00:00.000Z",
      ingredients: [],
      productLots: [{ lotCode: "CR-20260911-01", counted: pieces(0) }],
    });

    expect(fake.productLots.get("CR-20260911-01")?.onHand).toEqual(pieces(0));
    expect(fake.stocktakes[0]?.diffs[0]).toMatchObject({ diff: pieces(-24) });
  });
});

describe("listStockAlerts", () => {
  it("期限切れの残量を知らせる", async () => {
    const fake = createFake();
    await receiveAcceptedGoods(
      fake.uow,
      goodsReceipt([
        { ingredientId: FLOUR, quantity: g(1_000), lotCode: "OLD", bestBefore: "2026-09-01" },
      ]),
    );

    expect(await listStockAlerts(fake.deps)).toContainEqual({
      kind: "expired_ingredient",
      ingredientId: FLOUR,
      bestBefore: "2026-09-01",
    });
  });

  it("異常が無ければ空", async () => {
    const fake = createFake();
    await receiveAcceptedGoods(
      fake.uow,
      goodsReceipt([
        { ingredientId: FLOUR, quantity: g(1_000), lotCode: "OK", bestBefore: "2026-10-01" },
      ]),
    );

    expect(await listStockAlerts(fake.deps)).toEqual([]);
  });
});
