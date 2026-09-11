/**
 * inventory の統合テスト。
 *
 * inventory は5イベント中3つを購読する、購読が最も多いモジュール。したがって
 * ここで見たいのは「自分のテーブルに書けるか」ではなく、**他モジュールが実際に
 * 発行したイベントを受けて在庫が動くか**。他の4モジュールは実装済みなので、
 * ダミーのイベントを積むのではなく公開ユースケース (index.ts) を呼んで
 * 本物のイベントを outbox に積み、relayOnce で自分に届かせる。
 *
 * 確認するのは6点:
 *   1. 検収済   → 原材料が入庫される
 *   2. 製造完了 → 原材料が消費され、製品ロットが入庫される
 *   3. 販売確定 → 製品が出庫される
 *   4. 在庫がマイナスになってもハンドラが失敗せず、アラートとして出る
 *   5. 発注点割れが outbox に載り、purchasing に届いて発注提案ができる
 *   6. 同じイベントが2回届いても2回処理しない (inbox の冪等性)
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { catalog } from "../../src/modules/catalog/index.ts";
import { inventory, inventorySubscriptions } from "../../src/modules/inventory/index.ts";
import { production } from "../../src/modules/production/index.ts";
import { purchasing, purchasingSubscriptions } from "../../src/modules/purchasing/index.ts";
import { sales } from "../../src/modules/sales/index.ts";
import { moduleDb } from "../../src/shared/db.ts";
import { createEventBus, type EventBus, relayOnce } from "../../src/shared/event-bus.ts";
import type { Quantity } from "../../src/shared/events.ts";
import { withCleanDb } from "../helpers/db.ts";

const BUSINESS_DATE = "2026-09-11";
const g = (amount: number): Quantity => ({ amount, unit: "g" });
const pieces = (amount: number): Quantity => ({ amount, unit: "piece" });

/**
 * 購読は inventory と purchasing だけを載せる。
 *
 * worker は5モジュール分を束ねるが、ここで見たいのは inventory を中心にした経路
 * (3本の購読と、発注点割れが purchasing に届くこと)。他モジュール同士の経路は
 * そちらのテストの責務なので、巻き込まない。
 */
function createBus(): EventBus {
  return createEventBus([...inventorySubscriptions, ...purchasingSubscriptions], moduleDb);
}

/**
 * 配るものが無くなるまでリレーする。
 * inventory の購読ハンドラが自分の outbox に積んだイベント (発注点割れ) は、
 * 次の周回で purchasing に届くため1周では終わらない。
 */
async function drain(bus: EventBus): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    if ((await relayOnce(bus, moduleDb)) === 0) return;
  }
  throw new Error("イベントが収束しませんでした (無限に再送されている可能性)");
}

/** 原材料を登録し、発注 → 入荷 → 検収まで通して入庫イベントを積む。 */
async function acceptGoods(params: {
  readonly ingredientId: string;
  readonly quantity: Quantity;
  readonly lotCode: string;
  readonly bestBefore: string;
}): Promise<void> {
  const supplierId = await purchasing.registerSupplier({
    name: `製粉所 ${params.lotCode}`,
    leadTimeDays: 2,
  });
  const purchaseOrderId = await purchasing.placePurchaseOrder({
    supplierId,
    lines: [{ ingredientId: params.ingredientId, quantity: params.quantity }],
  });
  const goodsReceiptId = await purchasing.receiveGoods({
    purchaseOrderId,
    receivedAt: `${BUSINESS_DATE}T05:00:00.000Z`,
    lines: [
      {
        ingredientId: params.ingredientId,
        quantity: params.quantity,
        lotCode: params.lotCode,
        bestBefore: params.bestBefore,
      },
    ],
  });
  await purchasing.acceptGoodsReceipt({
    goodsReceiptId,
    acceptedAt: `${BUSINESS_DATE}T05:30:00.000Z`,
  });
}

/** レシピと製造計画を用意して焼き上げる。製造完了イベントが積まれる。 */
async function bake(params: {
  readonly productId: string;
  readonly ingredientId: string;
  readonly perBatch: Quantity;
  readonly produced: Quantity;
  readonly lotCode: string;
}): Promise<void> {
  const recipeId = await production.registerRecipe({
    productId: params.productId,
    yieldQuantity: pieces(24),
    lines: [{ ingredientId: params.ingredientId, quantity: params.perBatch }],
  });
  const productionPlanId = await production.planProduction({
    businessDate: BUSINESS_DATE,
    items: [
      {
        productId: params.productId,
        recipeId,
        plannedQuantity: params.produced,
        basis: "manual",
      },
    ],
  });
  await production.completeProductionRun({
    productionPlanId,
    productId: params.productId,
    recipeId,
    producedQuantity: params.produced,
    lotCode: params.lotCode,
    bestBefore: BUSINESS_DATE,
    completedAt: `${BUSINESS_DATE}T06:00:00.000Z`,
  });
}

async function registerCroissant(): Promise<string> {
  return catalog.registerProduct({
    name: "クロワッサン",
    priceJpy: 280,
    allergens: ["wheat", "milk"],
  });
}

async function countInboxRows(handler: string): Promise<number> {
  const result = await moduleDb("inventory").execute<{ count: string }>(
    sql`select count(*)::text as count from inventory.inbox where handler = ${handler}`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function countUnpublished(module: "inventory"): Promise<number> {
  const result = await moduleDb(module).execute<{ count: string }>(
    sql`select count(*)::text as count from inventory.outbox where published_at is null`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("inventory は他モジュールのイベントを受けて在庫を動かす", () => {
  withCleanDb();

  let bus: EventBus;
  beforeEach(() => {
    bus = createBus();
  });

  it("purchasing の検収済を受けて原材料を入庫する", async () => {
    const ingredientId = await inventory.registerIngredient({
      name: "強力粉",
      unit: "g",
      reorderPoint: g(5_000),
    });

    await acceptGoods({
      ingredientId,
      quantity: g(10_000),
      lotCode: "FLOUR-A",
      bestBefore: "2026-10-01",
    });
    await drain(bus);

    expect(await inventory.getIngredientStock(ingredientId)).toEqual({
      ingredientId,
      name: "強力粉",
      onHand: g(10_000),
      reorderPoint: g(5_000),
      // 仕入先のロットに付いてきた賞味期限。製品と違って日〜週単位で持つ。
      nearestBestBefore: "2026-10-01",
    });
  });

  it("production の製造完了を受けて原材料を消費し、製品ロットを入庫する", async () => {
    const ingredientId = await inventory.registerIngredient({
      name: "強力粉",
      unit: "g",
      reorderPoint: g(1_000),
    });
    const productId = await registerCroissant();

    await acceptGoods({
      ingredientId,
      quantity: g(10_000),
      lotCode: "FLOUR-A",
      bestBefore: "2026-10-01",
    });
    await drain(bus);

    await bake({
      productId,
      ingredientId,
      perBatch: g(1_440),
      produced: pieces(24),
      lotCode: "CR-20260911-01",
    });
    await drain(bus);

    // レシピは production の持ち物。inventory はイベントの consumedIngredients を
    // そのまま信じて消費する (レシピを引くと境界違反)。
    expect((await inventory.getIngredientStock(ingredientId))?.onHand).toEqual(g(8_560));
    expect(await inventory.listProductLots()).toEqual([
      {
        lotCode: "CR-20260911-01",
        productId,
        // 「今朝焼いた24個」というロット。個数で数え、当日限り。
        onHand: pieces(24),
        bestBefore: BUSINESS_DATE,
        producedAt: new Date(`${BUSINESS_DATE}T06:00:00.000Z`).toISOString(),
      },
    ]);
  });

  it("sales の販売確定を受けて製品を出庫する", async () => {
    const ingredientId = await inventory.registerIngredient({
      name: "強力粉",
      unit: "g",
      reorderPoint: g(1_000),
    });
    const productId = await registerCroissant();
    await acceptGoods({
      ingredientId,
      quantity: g(10_000),
      lotCode: "FLOUR-A",
      bestBefore: "2026-10-01",
    });
    await bake({
      productId,
      ingredientId,
      perBatch: g(1_440),
      produced: pieces(24),
      lotCode: "CR-20260911-01",
    });
    await drain(bus);

    await sales.recordSale({
      soldAt: `${BUSINESS_DATE}T07:42:00.000Z`,
      lines: [{ productId, lotCode: "CR-20260911-01", quantity: pieces(2) }],
    });
    await drain(bus);

    expect((await inventory.listProductLots())[0]?.onHand).toEqual(pieces(22));
  });

  it("販売確定が製造完了より先に届いても失敗せず、マイナスをアラートとして出す", async () => {
    // 結果整合なので現実に起きる順序。例外にして止めると同じイベントが
    // 永久に再送され、worker が詰まる。
    const productId = await registerCroissant();

    await sales.recordSale({
      soldAt: `${BUSINESS_DATE}T07:42:00.000Z`,
      lines: [{ productId, lotCode: "CR-20260911-02", quantity: pieces(2) }],
    });
    await drain(bus);

    expect(await inventory.listStockAlerts()).toContainEqual({
      kind: "negative_product_stock",
      lotCode: "CR-20260911-02",
      onHand: pieces(-2),
    });

    // 後から製造完了が届けば辻褄が合う (仮ロットが本物の値で上書きされる)。
    const ingredientId = await inventory.registerIngredient({
      name: "強力粉",
      unit: "g",
      reorderPoint: g(0),
    });
    await bake({
      productId,
      ingredientId,
      perBatch: g(1_440),
      produced: pieces(24),
      lotCode: "CR-20260911-02",
    });
    await drain(bus);

    expect((await inventory.listProductLots())[0]?.onHand).toEqual(pieces(22));
    expect(await inventory.listStockAlerts()).toEqual([
      // 原材料の方は入荷検収がまだなのでマイナスのまま。これもアラート。
      { kind: "negative_ingredient_stock", ingredientId, onHand: g(-1_440) },
    ]);
  });

  it("発注点を下回ると outbox に載り、purchasing に届いて発注提案ができる", async () => {
    const ingredientId = await inventory.registerIngredient({
      name: "強力粉",
      unit: "g",
      reorderPoint: g(5_000),
    });
    const productId = await registerCroissant();
    await acceptGoods({
      ingredientId,
      quantity: g(6_000),
      lotCode: "FLOUR-A",
      bestBefore: "2026-10-01",
    });
    await drain(bus);
    expect(await purchasing.listPurchaseSuggestions()).toEqual([]);

    // 6,000g → 4,560g。発注点 5,000g を下回る。
    await bake({
      productId,
      ingredientId,
      perBatch: g(1_440),
      produced: pieces(24),
      lotCode: "CR-20260911-01",
    });
    await relayOnce(bus, moduleDb);

    // まず自分の outbox に載る (業務データと同じトランザクションで積まれている)。
    const stagedOrDelivered = await moduleDb("inventory").execute<{ count: string }>(
      sql`select count(*)::text as count from inventory.outbox
           where event_name = 'inventory.ReorderPointBreached'`,
    );
    expect(Number(stagedOrDelivered.rows[0]?.count ?? "0")).toBe(1);

    await drain(bus);
    expect(await countUnpublished("inventory")).toBe(0);

    // purchasing に届いて提案になる。発注そのものは人が確定させる。
    expect(await purchasing.listPurchaseSuggestions()).toEqual([
      {
        ingredientId,
        // 発注点の2倍まで戻す提案 (10,000 - 4,560)。
        suggestedQuantity: g(5_440),
        onHandAtDetection: g(4_560),
        createdAt: expect.any(String),
      },
    ]);

    // 下回っている間ずっとは発行しない。もう一度焼いても提案は増えない。
    await bake({
      productId,
      ingredientId,
      perBatch: g(1_440),
      produced: pieces(24),
      lotCode: "CR-20260911-02",
    });
    await drain(bus);

    expect(await purchasing.listPurchaseSuggestions()).toHaveLength(1);
  });

  it("同じイベントが2回届いても2回処理しない", async () => {
    const ingredientId = await inventory.registerIngredient({
      name: "強力粉",
      unit: "g",
      reorderPoint: g(1_000),
    });
    await acceptGoods({
      ingredientId,
      quantity: g(10_000),
      lotCode: "FLOUR-A",
      bestBefore: "2026-10-01",
    });
    await drain(bus);

    expect((await inventory.getIngredientStock(ingredientId))?.onHand).toEqual(g(10_000));
    expect(await countInboxRows("receive-accepted-goods")).toBe(1);

    // worker が published 印を付ける前に落ちた状況を作り、同じ行をもう一度配らせる。
    await moduleDb("purchasing").execute(sql`update purchasing.outbox set published_at = null`);
    await drain(bus);

    // inbox が弾くので在庫は動かず、ロットも増えない。
    expect((await inventory.getIngredientStock(ingredientId))?.onHand).toEqual(g(10_000));
    expect(await countInboxRows("receive-accepted-goods")).toBe(1);
  });

  it("棚卸で帳簿在庫を実地の数に補正できる", async () => {
    const ingredientId = await inventory.registerIngredient({
      name: "強力粉",
      unit: "g",
      reorderPoint: g(1_000),
    });
    await acceptGoods({
      ingredientId,
      quantity: g(10_000),
      lotCode: "FLOUR-A",
      bestBefore: "2026-10-01",
    });
    await drain(bus);

    // こぼれた分・試作に使った分は誰も記録していない。実地の数が正。
    await inventory.recordStocktake({
      countedAt: `${BUSINESS_DATE}T20:00:00.000Z`,
      ingredients: [{ ingredientId, counted: g(9_800) }],
      productLots: [],
    });

    expect((await inventory.getIngredientStock(ingredientId))?.onHand).toEqual(g(9_800));

    // 差分は明細に残る (ズレが常態化していることに後から気づけるように)。
    const diffs = await moduleDb("inventory").execute<{ diff_amount: string }>(
      sql`select diff_amount from inventory.stocktake_lines`,
    );
    expect(diffs.rows).toEqual([{ diff_amount: "-200.000" }]);
  });
});
