/**
 * production (コアドメイン) の統合テスト。
 *
 * 単体テスト (src/modules/production/**) がドメインの判断を固定しているので、
 * ここで見るのは **DB と outbox を含む経路**だけ:
 *
 *   1. 実績の書き込みと production.ProductionCompleted の発行が同じトランザクション
 *   2. イベントの consumedIngredients が「レシピ × 実際に焼けた数量」
 *   3. relay で購読側に届く (inventory は未実装なのでダミー購読で経路だけ見る)
 *   4. sales.SaleCompleted を購読して販売実績が入り、需要予測の標本になる
 *   5. catalog.ProductDelisted を購読して以降の計画から外れる
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { production, productionSubscriptions } from "../../src/modules/production/index.ts";
import { moduleDb } from "../../src/shared/db.ts";
import {
  createEventBus,
  defineSubscription,
  relayOnce,
  type Subscription,
} from "../../src/shared/event-bus.ts";
import type { EventPayload, Quantity } from "../../src/shared/events.ts";
import { publishEvent } from "../../src/shared/outbox.ts";
import { withCleanDb } from "../helpers/db.ts";

const pieces = (amount: number): Quantity => ({ amount, unit: "piece" });
const grams = (amount: number): Quantity => ({ amount, unit: "g" });

const BUSINESS_DATE = "2026-09-12";

/** 1 バッチ 20 個取り、強力粉 1200g とバター 600g のクロワッサン。 */
async function registerCroissant(productId: string) {
  return production.registerRecipe({
    productId,
    yieldQuantity: pieces(20),
    lines: [
      { ingredientId: FLOUR, quantity: grams(1200) },
      { ingredientId: BUTTER, quantity: grams(600) },
    ],
  });
}

const FLOUR = "33333333-3333-4333-8333-333333333333";
const BUTTER = "44444444-4444-4444-8444-444444444444";

async function countRows(table: string): Promise<number> {
  const result = await moduleDb("production").execute<{ count: string }>(
    sql`select count(*)::text as count from ${sql.identifier("production")}.${sql.identifier(table)}`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function outboxPayloads(): Promise<EventPayload<"production.ProductionCompleted">[]> {
  const result = await moduleDb("production").execute<{
    payload: EventPayload<"production.ProductionCompleted">;
  }>(
    sql`select payload from production.outbox where event_name = 'production.ProductionCompleted'`,
  );
  return result.rows.map((row) => row.payload);
}

/** inventory はまだ未実装なので、経路の確認用にダミーの購読を作る。 */
function dummyInventorySubscription(
  received: EventPayload<"production.ProductionCompleted">[],
): Subscription {
  return defineSubscription({
    subscriber: "inventory",
    handler: "test-consume-ingredients",
    eventName: "production.ProductionCompleted",
    handle: async (event) => {
      received.push(event.payload);
    },
  });
}

async function planAndBake(params: {
  productId: string;
  plannedQuantity: number;
  producedQuantity: number;
}) {
  const recipeId = await registerCroissant(params.productId);
  const productionPlanId = await production.planProduction({
    businessDate: BUSINESS_DATE,
    items: [
      {
        productId: params.productId,
        recipeId,
        plannedQuantity: pieces(params.plannedQuantity),
        basis: "forecast",
      },
    ],
  });
  const productionRunId = await production.completeProductionRun({
    productionPlanId,
    productId: params.productId,
    recipeId,
    producedQuantity: pieces(params.producedQuantity),
    lotCode: "CR-20260912-01",
    bestBefore: BUSINESS_DATE,
    completedAt: "2026-09-12T06:30:00+09:00",
  });
  return { recipeId, productionPlanId, productionRunId };
}

describe("製造完了 → outbox → 購読側", () => {
  withCleanDb(["production", "inventory", "sales", "catalog"]);

  it("実績とイベントが同じトランザクションで入る", async () => {
    const productId = randomUUID();
    const { productionRunId } = await planAndBake({
      productId,
      plannedQuantity: 40,
      producedQuantity: 24,
    });

    // 業務データとイベントが両方ある。片方だけの状態は作られない。
    expect(await countRows("production_runs")).toBe(1);
    const payloads = await outboxPayloads();
    expect(payloads).toHaveLength(1);
    // 同じ操作が書いた行であることを ID で確かめる。
    expect(payloads[0]?.productionRunId).toBe(productionRunId);
    expect(payloads[0]?.productId).toBe(productId);
  });

  it("途中で失敗したら実績もイベントも残らない", async () => {
    const productId = randomUUID();
    const recipeId = await registerCroissant(productId);

    // 存在しない計画を指定して落とす。書き込みの前に落ちても後に落ちても、
    // ユースケースが 1 トランザクションである限り両方残らない。
    await expect(
      production.completeProductionRun({
        productionPlanId: randomUUID(),
        productId,
        recipeId,
        producedQuantity: pieces(20),
        lotCode: "CR-20260912-01",
        bestBefore: BUSINESS_DATE,
        completedAt: "2026-09-12T06:30:00+09:00",
      }),
    ).rejects.toThrow("製造計画が見つかりません");

    expect(await countRows("production_runs")).toBe(0);
    expect(await outboxPayloads()).toHaveLength(0);
  });

  it("consumedIngredients がレシピ × 実際に焼けた数量になっている", async () => {
    const productId = randomUUID();
    await planAndBake({ productId, plannedQuantity: 40, producedQuantity: 24 });

    const payload = (await outboxPayloads())[0];

    // 20 個取りのレシピで 24 個 = 2 バッチ。比例配分 (1.2 倍) ではない。
    expect(payload?.consumedIngredients).toEqual([
      { ingredientId: FLOUR, quantity: grams(2400) },
      { ingredientId: BUTTER, quantity: grams(1200) },
    ]);
    // 同じ値を自分の実績としても残している (後から原価と歩留まりを追うため)。
    expect(await countRows("production_run_consumptions")).toBe(2);
  });

  it("relay で購読側に届く", async () => {
    const productId = randomUUID();
    const { productionRunId } = await planAndBake({
      productId,
      plannedQuantity: 40,
      producedQuantity: 24,
    });

    const received: EventPayload<"production.ProductionCompleted">[] = [];
    const bus = createEventBus([dummyInventorySubscription(received)], moduleDb);

    const delivered = await relayOnce(bus, moduleDb, { modules: ["production"] });

    expect(delivered).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.productionRunId).toBe(productionRunId);
    // inventory はレシピを引かずに在庫を減らせる。
    expect(received[0]?.consumedIngredients).toEqual([
      { ingredientId: FLOUR, quantity: grams(2400) },
      { ingredientId: BUTTER, quantity: grams(1200) },
    ]);

    // 発行側は配信済みになる。
    const unpublished = await moduleDb("production").execute<{ count: string }>(
      sql`select count(*)::text as count from production.outbox where published_at is null`,
    );
    expect(Number(unpublished.rows[0]?.count)).toBe(0);
  });

  it("計画数と実績数の両方が残る", async () => {
    const productId = randomUUID();
    await planAndBake({ productId, plannedQuantity: 40, producedQuantity: 24 });

    const rows = await moduleDb("production").execute<{
      planned_amount: string;
      produced_amount: string;
    }>(sql`select planned_amount, produced_amount from production.production_runs`);

    expect(rows.rows[0]).toMatchObject({ planned_amount: "40.000", produced_amount: "24.000" });
  });
});

describe("購読: sales.SaleCompleted", () => {
  withCleanDb(["production", "sales"]);

  /** sales 役として販売確定イベントを 1 件積む (sales は並行実装中なので直接積む)。 */
  async function publishSale(params: {
    productId: string;
    soldAt: string;
    quantity: number;
    channel: "storefront" | "reservation";
  }): Promise<void> {
    await moduleDb("sales").transaction(async (tx) => {
      await publishEvent(tx, "sales", "sales.SaleCompleted", {
        saleId: randomUUID(),
        channel: params.channel,
        soldAt: params.soldAt,
        lines: [
          {
            productId: params.productId,
            lotCode: "CR-20260912-01",
            quantity: pieces(params.quantity),
            unitPriceJpy: 280,
          },
        ],
        totalJpy: 280 * params.quantity,
      });
    });
  }

  it("販売実績が記録され、需要予測の標本になる", async () => {
    const productId = randomUUID();
    const bus = createEventBus([...productionSubscriptions], moduleDb);

    // 土曜 2 日分の実績。予測対象も土曜 (2026-09-19)。
    await publishSale({
      productId,
      soldAt: "2026-09-05T07:42:00+09:00",
      quantity: 40,
      channel: "storefront",
    });
    await publishSale({
      productId,
      soldAt: "2026-09-12T07:42:00+09:00",
      quantity: 44,
      channel: "storefront",
    });

    expect(await relayOnce(bus, moduleDb, { modules: ["sales"] })).toBe(2);

    const forecast = await production.getDemandForecast(productId, "2026-09-19");

    expect(forecast.basis.sampleDays).toBe(2);
    expect(forecast.basis.averageSoldQuantity).toEqual(pieces(42));
    expect(forecast.forecastQuantity).toEqual(pieces(42));
  });

  it("同じイベントを2回配信しても実績は二重に積まれない", async () => {
    const productId = randomUUID();
    const bus = createEventBus([...productionSubscriptions], moduleDb);

    await publishSale({
      productId,
      soldAt: "2026-09-12T07:42:00+09:00",
      quantity: 10,
      channel: "storefront",
    });
    await relayOnce(bus, moduleDb, { modules: ["sales"] });

    // worker が印を付ける前に落ちた状況 (at-least-once) を作る。
    await moduleDb("sales").execute(sql`update sales.outbox set published_at = null`);
    await relayOnce(bus, moduleDb, { modules: ["sales"] });

    const rows = await moduleDb("production").execute<{ sold_amount: string }>(
      sql`select sold_amount from production.sales_results where product_id = ${productId}`,
    );
    expect(rows.rows).toHaveLength(1);
    // 20 個になっていない = inbox が二重処理を弾いている。
    expect(rows.rows[0]?.sold_amount).toBe("10.000");
  });

  it("確定済みの予約は予測の下限になる", async () => {
    const productId = randomUUID();
    const bus = createEventBus([...productionSubscriptions], moduleDb);

    await publishSale({
      productId,
      soldAt: "2026-09-05T07:42:00+09:00",
      quantity: 10,
      channel: "storefront",
    });
    await publishSale({
      productId,
      soldAt: "2026-09-12T07:42:00+09:00",
      quantity: 10,
      channel: "storefront",
    });
    // 9/19 に 30 個の予約が確定している。
    await publishSale({
      productId,
      soldAt: "2026-09-19T10:00:00+09:00",
      quantity: 30,
      channel: "reservation",
    });
    await relayOnce(bus, moduleDb, { modules: ["sales"] });

    const forecast = await production.getDemandForecast(productId, "2026-09-19");

    expect(forecast.basis.reservedQuantity).toEqual(pieces(30));
    expect(forecast.forecastQuantity).toEqual(pieces(30));
  });
});

describe("購読: catalog.ProductDelisted", () => {
  withCleanDb(["production", "catalog"]);

  async function publishDelisted(productId: string, delistedAt: string): Promise<void> {
    await moduleDb("catalog").transaction(async (tx) => {
      await publishEvent(tx, "catalog", "catalog.ProductDelisted", {
        productId,
        delistedAt,
        reason: "seasonal",
      });
    });
  }

  it("以降の計画から外れ、過去の計画は残る", async () => {
    const productId = randomUUID();
    const recipeId = await registerCroissant(productId);
    const bus = createEventBus([...productionSubscriptions], moduleDb);

    for (const businessDate of ["2026-09-10", "2026-09-12"]) {
      await production.planProduction({
        businessDate,
        items: [{ productId, recipeId, plannedQuantity: pieces(40), basis: "forecast" }],
      });
    }

    await publishDelisted(productId, "2026-09-11T09:00:00+09:00");
    expect(await relayOnce(bus, moduleDb, { modules: ["catalog"] })).toBe(1);

    // 過去 (9/10) は「なぜその日それを焼いたか」の記録なので残す。
    expect((await production.getProductionPlan("2026-09-10"))?.items).toHaveLength(1);
    expect((await production.getProductionPlan("2026-09-12"))?.items).toHaveLength(0);
  });

  it("販売停止後に立てた計画にも入らない", async () => {
    const productId = randomUUID();
    const recipeId = await registerCroissant(productId);
    const bus = createEventBus([...productionSubscriptions], moduleDb);

    await publishDelisted(productId, "2026-09-11T09:00:00+09:00");
    await relayOnce(bus, moduleDb, { modules: ["catalog"] });

    await production.planProduction({
      businessDate: "2026-09-13",
      items: [{ productId, recipeId, plannedQuantity: pieces(40), basis: "forecast" }],
    });

    expect((await production.getProductionPlan("2026-09-13"))?.items).toEqual([]);
  });
});
