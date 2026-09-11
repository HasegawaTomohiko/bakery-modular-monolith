/**
 * Phase 5: 参照モデル (readmodel) の統合テスト。
 *
 * コンテキストをまたぐ画面は JOIN では作れない。したがってここで確かめるのは
 * **4つのコンテキストが発行した本物のイベントだけから、1つの画面が組み上がること**。
 * ダミーのイベントを積むのではなく、各モジュールの公開 API (index.ts) を呼んで
 * outbox に積み、worker と同じ購読表で relay する。
 *
 * 投影が壊れても HTTP は 200 を返す (空の集計が返るだけ) ので、壊れたことに
 * 気づけるのはこのテストだけ。固定するのは6点:
 *   1. 製造数 / 販売数 / 売れ残り / 売上金額 / 廃棄率が正しく組み上がる
 *   2. 原材料の入庫と消費の当日集計
 *   3. inventory.ReorderPointBreached を受けて発注点割れの印が付く
 *   4. catalog.ProductDelisted を受けて該当商品に印が付く
 *   5. 同じイベントが2回届いても数字が二重に足されない (inbox の冪等性)
 *   6. 営業日 (JST の暦日) の境界が集計に効いている
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { catalog, catalogSubscriptions } from "../../src/modules/catalog/index.ts";
import { inventory, inventorySubscriptions } from "../../src/modules/inventory/index.ts";
import { production, productionSubscriptions } from "../../src/modules/production/index.ts";
import { purchasing, purchasingSubscriptions } from "../../src/modules/purchasing/index.ts";
import { sales, salesSubscriptions } from "../../src/modules/sales/index.ts";
import { getDailyDashboard, readmodelSubscriptions } from "../../src/readmodel/index.ts";
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
    ...readmodelSubscriptions,
  ],
  moduleDb,
);

/** worker を回す。溜まったイベントが無くなるまで。 */
async function runWorker(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    if ((await relayOnce(bus, moduleDb)) === 0) return;
  }
  throw new Error("worker が 10 周しても落ち着きませんでした (イベントの循環?)");
}

/**
 * readmodel スキーマを空にする。
 *
 * tests/helpers/db.ts の truncateAll() はモジュール5つしか回らない
 * (readmodel はモジュールではないため)。ヘルパーを直さずここで面倒を見る。
 * テーブル一覧は information_schema から引く。参照モデルのロールで引く限り
 * 他スキーマのテーブルは出てこないので、境界を破らずに掃除できる。
 */
async function truncateReadModel(): Promise<void> {
  const db = moduleDb("readmodel");
  const tables = await db.execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = 'readmodel'
       and table_type = 'BASE TABLE'
       and table_name <> '__drizzle_migrations'
  `);
  if (tables.rows.length === 0) return;
  const targets = sql.join(
    tables.rows.map((row) => sql`readmodel.${sql.identifier(row.table_name)}`),
    sql`, `,
  );
  await db.execute(sql`truncate table ${targets} restart identity cascade`);
}

const BUSINESS_DATE = "2026-09-11";
/** 時刻は JST で書く。営業日は JST の暦日 (src/readmodel/business-date.ts)。 */
const at = (time: string, date: string = BUSINESS_DATE): string => `${date}T${time}+09:00`;

const g = (amount: number) => ({ amount, unit: "g" }) as const;
const pieces = (amount: number) => ({ amount, unit: "piece" }) as const;

/** 原材料を登録して検収まで通す。入庫イベントが積まれる。 */
async function stockIngredient(params: {
  readonly name: string;
  readonly reorderPoint: number;
  readonly received: number;
}): Promise<string> {
  const ingredientId = await inventory.registerIngredient({
    name: params.name,
    unit: "g",
    reorderPoint: g(params.reorderPoint),
  });
  const supplierId = await purchasing.registerSupplier({
    name: `製粉所 ${params.name}`,
    leadTimeDays: 2,
  });
  const purchaseOrderId = await purchasing.placePurchaseOrder({
    supplierId,
    lines: [{ ingredientId, quantity: g(params.received) }],
  });
  const goodsReceiptId = await purchasing.receiveGoods({
    purchaseOrderId,
    receivedAt: at("06:00:00"),
    lines: [
      {
        ingredientId,
        quantity: g(params.received),
        lotCode: `LOT-${params.name}`,
        bestBefore: "2026-10-11",
      },
    ],
  });
  await purchasing.acceptGoodsReceipt({ goodsReceiptId, acceptedAt: at("06:30:00") });

  // 焼く前に入庫を届けておく。relayOnce はモジュール順 (catalog → production →
  // inventory → purchasing → sales) に配るので、同じ周回に溜めると製造完了の方が
  // 先に届き、在庫がマイナスに振れて発注点割れが立つ。それ自体は結果整合として
  // 正しい挙動 (inventory のテストが見ている) だが、ここで見たいのは投影なので
  // 「検収してから焼く」という実際の順序に合わせる。
  await runWorker();
  return ingredientId;
}

/** レシピと計画を用意して焼く。1バッチ = 20個。 */
async function bake(params: {
  readonly productId: string;
  readonly ingredientId: string;
  readonly producedPieces: number;
  readonly lotCode: string;
  readonly completedAt: string;
  readonly bestBefore?: string;
}): Promise<void> {
  const recipeId = await production.registerRecipe({
    productId: params.productId,
    yieldQuantity: pieces(20),
    lines: [{ ingredientId: params.ingredientId, quantity: g(2_000) }],
  });
  const productionPlanId = await production.planProduction({
    businessDate: params.bestBefore ?? BUSINESS_DATE,
    items: [
      {
        productId: params.productId,
        recipeId,
        plannedQuantity: pieces(params.producedPieces),
        basis: "manual",
      },
    ],
  });
  await production.completeProductionRun({
    productionPlanId,
    productId: params.productId,
    recipeId,
    producedQuantity: pieces(params.producedPieces),
    lotCode: params.lotCode,
    bestBefore: params.bestBefore ?? BUSINESS_DATE,
    completedAt: params.completedAt,
  });
}

describe("参照モデル: 今日の在庫と販売状況", () => {
  beforeEach(async () => {
    await truncateAll();
    await truncateReadModel();
  });

  it("4コンテキストのイベントから、売上と廃棄ロスが1つの画面に組み上がる", async () => {
    const productId = await catalog.registerProduct({
      name: "クロワッサン",
      priceJpy: 280,
      allergens: ["wheat", "milk"],
    });
    const flourId = await stockIngredient({
      name: "強力粉",
      reorderPoint: 5_000,
      received: 25_000,
    });

    await bake({
      productId,
      ingredientId: flourId,
      producedPieces: 20,
      lotCode: "CR-20260911",
      completedAt: at("07:30:00"),
    });
    await sales.recordSale({
      soldAt: at("10:00:00"),
      lines: [{ productId, lotCode: "CR-20260911", quantity: pieces(14) }],
    });

    // 配る前は何も無い (結果整合)。参照モデルはイベントが届いて初めて埋まる。
    expect((await getDailyDashboard(BUSINESS_DATE)).products).toEqual([]);

    await runWorker();

    const dashboard = await getDailyDashboard(BUSINESS_DATE);

    // 20個焼いて14個売れた = 6個が売れ残り。製品は当日限りなのでそのまま廃棄ロス。
    expect(dashboard.totals).toEqual({
      producedPieces: 20,
      soldPieces: 14,
      leftoverPieces: 6,
      salesJpy: 280 * 14,
      wasteRatePercent: 30,
    });

    expect(dashboard.products).toEqual([
      {
        productId,
        producedPieces: 20,
        soldPieces: 14,
        leftoverPieces: 6,
        salesJpy: 3_920,
        delisted: false,
        delistReason: null,
      },
    ]);

    // 廃棄はロット単位で起きる。どのロットが余ったかまで見える。
    expect(dashboard.lots).toEqual([
      {
        lotCode: "CR-20260911",
        productId,
        bestBefore: BUSINESS_DATE,
        producedPieces: 20,
        soldPieces: 14,
        leftoverPieces: 6,
        salesJpy: 3_920,
      },
    ]);

    // 原材料: 検収で 25,000g 入り、1バッチ (20個取り) で 2,000g 消費。
    // 消費量は production がレシピ×数量から算出してイベントに載せたもの。
    expect(dashboard.ingredients).toEqual([
      {
        ingredientId: flourId,
        received: g(25_000),
        consumed: g(2_000),
        reorderBreach: null,
      },
    ]);
  });

  it("発注点割れを受けて印が付く", async () => {
    const flourId = await stockIngredient({ name: "強力粉", reorderPoint: 5_000, received: 6_000 });
    await runWorker();
    expect((await getDailyDashboard(BUSINESS_DATE)).ingredients[0]?.reorderBreach).toBeNull();

    // 棚卸で発注点 (5,000g) を下回らせる。inventory が発注点割れを発行する。
    await inventory.recordStocktake({
      countedAt: at("20:00:00"),
      ingredients: [{ ingredientId: flourId, counted: g(300) }],
      productLots: [],
    });
    await runWorker();

    expect((await getDailyDashboard(BUSINESS_DATE)).ingredients[0]?.reorderBreach).toEqual({
      onHand: g(300),
      reorderPoint: g(5_000),
      // 発注点の2倍まで戻す提案 (inventory の判断)。参照モデルは写すだけ。
      suggestedOrderQuantity: g(9_700),
      detectedAt: new Date(at("20:00:00")).toISOString(),
    });
  });

  it("販売停止を受けて該当商品に印が付く", async () => {
    const productId = await catalog.registerProduct({
      name: "季節のデニッシュ",
      priceJpy: 320,
      allergens: ["wheat"],
    });
    const flourId = await stockIngredient({
      name: "強力粉",
      reorderPoint: 1_000,
      received: 10_000,
    });
    await bake({
      productId,
      ingredientId: flourId,
      producedPieces: 20,
      lotCode: "DA-20260911",
      completedAt: at("07:30:00"),
    });
    await sales.recordSale({
      soldAt: at("10:00:00"),
      lines: [{ productId, lotCode: "DA-20260911", quantity: pieces(5) }],
    });
    await catalog.delistProduct({ productId, reason: "seasonal" });
    await runWorker();

    // 実績は消えない。印が付くだけ (過去の売上と製造実績は残す)。
    expect((await getDailyDashboard(BUSINESS_DATE)).products[0]).toMatchObject({
      productId,
      producedPieces: 20,
      soldPieces: 5,
      delisted: true,
      delistReason: "seasonal",
    });
  });

  it("同じイベントが2回届いても数字が二重に足されない", async () => {
    const productId = await catalog.registerProduct({
      name: "クロワッサン",
      priceJpy: 280,
      allergens: ["wheat", "milk"],
    });
    const flourId = await stockIngredient({
      name: "強力粉",
      reorderPoint: 1_000,
      received: 25_000,
    });
    await bake({
      productId,
      ingredientId: flourId,
      producedPieces: 20,
      lotCode: "CR-20260911",
      completedAt: at("07:30:00"),
    });
    await sales.recordSale({
      soldAt: at("10:00:00"),
      lines: [{ productId, lotCode: "CR-20260911", quantity: pieces(14) }],
    });
    await runWorker();

    const before = await getDailyDashboard(BUSINESS_DATE);

    // worker が published 印を付ける前に落ちた状況を作り、同じ行をもう一度配らせる。
    // 配送は at-least-once なので、これは異常ではなく起こりうる経路。
    for (const module of ["purchasing", "production", "sales"] as const) {
      await moduleDb(module).execute(
        sql`update ${sql.identifier(module)}.outbox set published_at = null`,
      );
    }
    await runWorker();

    // 投影は「足し込み」なので、2回処理すると数字が倍になる。
    // それを防いでいるのは inbox (処理済みの記録と投影が同じトランザクション)。
    expect(await getDailyDashboard(BUSINESS_DATE)).toEqual(before);

    const inboxRows = await moduleDb("readmodel").execute<{ handler: string; count: string }>(sql`
      select handler, count(*)::text as count
        from readmodel.inbox
       group by handler
       order by handler
    `);
    expect(inboxRows.rows).toEqual([
      { handler: "project-goods-receipt", count: "1" },
      { handler: "project-production-completed", count: "1" },
      { handler: "project-sale-completed", count: "1" },
    ]);
  });

  it("営業日は JST の暦日で切る (発行側が UTC で書いていても)", async () => {
    const productId = await catalog.registerProduct({
      name: "クロワッサン",
      priceJpy: 280,
      allergens: ["wheat", "milk"],
    });
    const flourId = await stockIngredient({
      name: "強力粉",
      reorderPoint: 1_000,
      received: 25_000,
    });
    await bake({
      productId,
      ingredientId: flourId,
      producedPieces: 20,
      lotCode: "CR-20260911",
      completedAt: at("07:30:00"),
    });

    // 閉店間際の販売 (JST 9/11 23:30 = 14:30Z) と、翌朝の販売 (JST 9/12 07:00 = 22:00Z)。
    // どちらも UTC では 9/11 なので、文字列の日付部分で切ると同じ日に混ざってしまう。
    await sales.recordSale({
      soldAt: at("23:30:00"),
      lines: [{ productId, lotCode: "CR-20260911", quantity: pieces(3) }],
    });
    await sales.recordSale({
      soldAt: at("07:00:00", "2026-09-12"),
      lines: [{ productId, lotCode: "CR-20260911", quantity: pieces(2) }],
    });
    await runWorker();

    // 9/11 は製造20・販売3。
    expect((await getDailyDashboard(BUSINESS_DATE)).totals).toMatchObject({
      producedPieces: 20,
      soldPieces: 3,
      salesJpy: 280 * 3,
    });

    // 翌朝の分は 9/12 に立つ。製造は無いので売れ残りはマイナス
    // (前日のロットが売れた形)。丸めずそのまま出し、数字が合わないことを見せる。
    expect((await getDailyDashboard("2026-09-12")).totals).toMatchObject({
      producedPieces: 0,
      soldPieces: 2,
      leftoverPieces: -2,
      salesJpy: 280 * 2,
      wasteRatePercent: 0,
    });
  });

  it("イベントが1件も無い日は空の集計を返す", async () => {
    // 画面が 404 とエラー表示を分けなくて済むように、空でも形は返す。
    expect(await getDailyDashboard("2026-01-01")).toEqual({
      businessDate: "2026-01-01",
      totals: {
        producedPieces: 0,
        soldPieces: 0,
        leftoverPieces: 0,
        salesJpy: 0,
        wasteRatePercent: 0,
      },
      products: [],
      lots: [],
      ingredients: [],
    });
  });
});
