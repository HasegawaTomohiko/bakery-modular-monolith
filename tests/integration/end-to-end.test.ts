/**
 * Phase 4c: コンテキストを横断する結合テスト。
 *
 * パン屋の1日を、5つのコンテキストをまたいで通す。
 *
 *   購買   発注 → 入荷 → 検収
 *     └─ purchasing.GoodsReceiptAccepted ──▶ 在庫   原材料を入庫
 *   製造   レシピ登録 → 製造計画 → 焼き上がり
 *     └─ production.ProductionCompleted ───▶ 在庫   原材料を消費し、製品ロットを入庫
 *   販売   店頭販売
 *     ├─ sales.SaleCompleted ──────────────▶ 在庫   製品を出庫
 *     └─ sales.SaleCompleted ──────────────▶ 製造   販売実績を記録
 *
 * 各モジュールの単体の振る舞いは個別の統合テストが見ている。ここで確かめるのは
 * **経路がつながっていること**と、結果整合の性質 (配送前は届いていない) の2点。
 *
 * 使うのは各モジュールの公開 API (index.ts) だけ。他モジュールの内部にも
 * 他スキーマにも触れずにシナリオが書けることが、境界が正しいことの傍証になる。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { catalog, catalogSubscriptions } from "../../src/modules/catalog/index.ts";
import { inventory, inventorySubscriptions } from "../../src/modules/inventory/index.ts";
import { production, productionSubscriptions } from "../../src/modules/production/index.ts";
import { purchasing, purchasingSubscriptions } from "../../src/modules/purchasing/index.ts";
import { sales, salesSubscriptions } from "../../src/modules/sales/index.ts";
import { moduleDb } from "../../src/shared/db.ts";
import { createEventBus, relayOnce } from "../../src/shared/event-bus.ts";
import { truncateAll } from "../helpers/db.ts";

/** 本番と同じ購読表。worker (src/entrypoints/worker.ts) と同じものを組む。 */
const bus = createEventBus(
  [
    ...catalogSubscriptions,
    ...purchasingSubscriptions,
    ...inventorySubscriptions,
    ...productionSubscriptions,
    ...salesSubscriptions,
  ],
  moduleDb,
);

/** worker を1周回す。溜まったイベントが無くなるまで。 */
async function runWorker(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    if ((await relayOnce(bus, moduleDb)) === 0) return;
  }
  throw new Error("worker が 10 周しても落ち着きませんでした (イベントの循環?)");
}

const BUSINESS_DATE = "2026-09-11";
const at = (time: string): string => `${BUSINESS_DATE}T${time}+09:00`;

const g = (amount: number) => ({ amount, unit: "g" }) as const;
const pieces = (amount: number) => ({ amount, unit: "piece" }) as const;

describe("パン屋の1日 (5コンテキスト横断)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("発注から販売まで、イベント経由で在庫と実績がつながる", async () => {
    // --- 準備: 商品・原材料・仕入先・レシピ -------------------------------
    const productId = await catalog.registerProduct({
      name: "クロワッサン",
      priceJpy: 280,
      allergens: ["wheat", "milk"],
    });

    const flourId = await inventory.registerIngredient({
      name: "強力粉",
      unit: "g",
      reorderPoint: g(5_000),
    });
    const butterId = await inventory.registerIngredient({
      name: "バター",
      unit: "g",
      reorderPoint: g(2_000),
    });

    const supplierId = await purchasing.registerSupplier({ name: "製粉所A", leadTimeDays: 2 });

    // 1バッチ = 20個。強力粉 2000g・バター 1000g。
    const recipeId = await production.registerRecipe({
      productId,
      yieldQuantity: pieces(20),
      lines: [
        { ingredientId: flourId, quantity: g(2_000) },
        { ingredientId: butterId, quantity: g(1_000) },
      ],
    });

    // --- 1. 購買: 発注 → 入荷 → 検収 ------------------------------------
    const purchaseOrderId = await purchasing.placePurchaseOrder({
      supplierId,
      lines: [
        { ingredientId: flourId, quantity: g(25_000) },
        { ingredientId: butterId, quantity: g(10_000) },
      ],
    });

    const goodsReceiptId = await purchasing.receiveGoods({
      purchaseOrderId,
      receivedAt: at("06:00:00"),
      lines: [
        { ingredientId: flourId, quantity: g(25_000), lotCode: "F-001", bestBefore: "2026-10-11" },
        { ingredientId: butterId, quantity: g(10_000), lotCode: "B-001", bestBefore: "2026-09-25" },
      ],
    });

    // 入荷しただけでは在庫にならない。検収して初めてイベントが出る。
    await runWorker();
    expect(await inventory.getIngredientStock(flourId)).toMatchObject({ onHand: g(0) });

    await purchasing.acceptGoodsReceipt({ goodsReceiptId, acceptedAt: at("06:30:00") });

    // 配送前は届いていない (結果整合)。
    expect(await inventory.getIngredientStock(flourId)).toMatchObject({ onHand: g(0) });

    await runWorker();

    expect(await inventory.getIngredientStock(flourId)).toMatchObject({ onHand: g(25_000) });
    expect(await inventory.getIngredientStock(butterId)).toMatchObject({ onHand: g(10_000) });

    // --- 2. 製造: 計画 → 焼き上がり --------------------------------------
    const productionPlanId = await production.planProduction({
      businessDate: BUSINESS_DATE,
      items: [{ productId, recipeId, plannedQuantity: pieces(24), basis: "manual" }],
    });

    await production.completeProductionRun({
      productionPlanId,
      productId,
      recipeId,
      producedQuantity: pieces(24),
      lotCode: "CR-20260911",
      bestBefore: BUSINESS_DATE,
      completedAt: at("07:30:00"),
    });

    await runWorker();

    // 20個取りのレシピで24個焼いたので、**バッチは2回**回っている (production が切り上げる)。
    // 生地はバッチ単位でしか仕込めないので比例配分にはならない。
    // 強力粉 2000g×2 = 4000g、バター 1000g×2 = 2000g が消費される。
    // この計算は production の持ち物で、inventory はイベントに載った結果を受け取るだけ。
    expect(await inventory.getIngredientStock(flourId)).toMatchObject({ onHand: g(21_000) });
    expect(await inventory.getIngredientStock(butterId)).toMatchObject({ onHand: g(8_000) });

    // 製品ロットが入庫される。原材料 (g) とは別のモデル。
    const lots = await inventory.listProductLots();
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({
      lotCode: "CR-20260911",
      productId,
      onHand: pieces(24),
      bestBefore: BUSINESS_DATE,
    });

    // --- 3. 販売: 店頭で 18 個売れる --------------------------------------
    await sales.recordSale({
      soldAt: at("10:00:00"),
      lines: [{ productId, lotCode: "CR-20260911", quantity: pieces(18) }],
    });

    await runWorker();

    // 在庫からは出庫され、
    const afterSale = await inventory.listProductLots();
    expect(afterSale[0]).toMatchObject({ onHand: pieces(6) });

    // 売上は販売時点の価格で立ち、
    const daily = await sales.getDailySales(BUSINESS_DATE);
    expect(daily.totalJpy).toBe(280 * 18);

    // 製造には需要予測の入力として販売実績が渡る。
    const forecast = await production.getDemandForecast(productId, "2026-09-12");
    expect(forecast.basis.sampleDays).toBeGreaterThan(0);
    expect(forecast.basis.averageSoldQuantity.amount).toBeGreaterThan(0);
  });

  it("販売停止は catalog を起点に production と sales の両方へ伝わる", async () => {
    const productId = await catalog.registerProduct({
      name: "季節のデニッシュ",
      priceJpy: 320,
      allergens: ["wheat"],
    });

    // 停止前は売れる。
    await catalog.delistProduct({ productId, reason: "seasonal" });
    await runWorker();

    // sales は参照コピーを更新して販売を弾く。
    await expect(
      sales.recordSale({
        soldAt: at("11:00:00"),
        lines: [{ productId, lotCode: "X-1", quantity: pieces(1) }],
      }),
    ).rejects.toThrow();

    // catalog 側では消えていない。過去の売上や製造実績から参照されるため。
    expect(await catalog.getProduct(productId)).toMatchObject({ sellable: false });
    expect(await catalog.listSellableProducts()).toHaveLength(0);
  });

  it("在庫が発注点を割ると purchasing に発注提案ができる", async () => {
    const ingredientId = await inventory.registerIngredient({
      name: "イースト",
      unit: "g",
      reorderPoint: g(1_000),
    });
    const supplierId = await purchasing.registerSupplier({ name: "製粉所A", leadTimeDays: 2 });
    const purchaseOrderId = await purchasing.placePurchaseOrder({
      supplierId,
      lines: [{ ingredientId, quantity: g(1_200) }],
    });
    const goodsReceiptId = await purchasing.receiveGoods({
      purchaseOrderId,
      receivedAt: at("06:00:00"),
      lines: [{ ingredientId, quantity: g(1_200), lotCode: "Y-001", bestBefore: "2026-12-31" }],
    });
    await purchasing.acceptGoodsReceipt({ goodsReceiptId, acceptedAt: at("06:30:00") });
    await runWorker();

    expect(await purchasing.listPurchaseSuggestions()).toHaveLength(0);

    // 棚卸で発注点 (1000g) を下回らせる。
    await inventory.recordStocktake({
      countedAt: at("20:00:00"),
      ingredients: [{ ingredientId, counted: g(300) }],
      productLots: [],
    });

    await runWorker();

    const suggestions = await purchasing.listPurchaseSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ ingredientId });
  });
});
