/**
 * ユースケースの単体テスト。DB は使わない。
 *
 * ports を偽物に差し替えて、「今日何を何個焼くか」と「何をどれだけ消費したか」の
 * 判断だけを固定する。SQL を通すと、落ちたときにドメインの誤りなのか
 * クエリの誤りなのかが分からなくなるため、ここでは分けている
 * (DB を含む経路は tests/integration/production.test.ts で見る)。
 */
import { describe, expect, it } from "vitest";
import type { EventEnvelope, EventPayload, Quantity } from "../../../shared/events.ts";
import type { Executor } from "../../../shared/tables.ts";
import type { ProductionPlan } from "../domain/production-plan.ts";
import type { ProductionRun } from "../domain/production-run.ts";
import type { Recipe } from "../domain/recipe.ts";
import type { DelistedProduct, ProductionDeps, SalesResultEntry } from "./ports.ts";
import { createProductionService } from "./production-service.ts";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const OTHER_PRODUCT = "22222222-2222-4222-8222-222222222222";
const FLOUR = "33333333-3333-4333-8333-333333333333";
const BUTTER = "44444444-4444-4444-8444-444444444444";
const PLAN_ID = "55555555-5555-4555-8555-555555555555";

const pieces = (amount: number): Quantity => ({ amount, unit: "piece" });
const grams = (amount: number): Quantity => ({ amount, unit: "g" });

/** fake は tx を使わないのでダミーを渡す。 */
const noTx = {} as Executor;

type Fake = {
  readonly deps: ProductionDeps;
  readonly recipes: Map<string, Recipe>;
  readonly plans: Map<string, ProductionPlan>;
  readonly runs: ProductionRun[];
  readonly published: EventPayload<"production.ProductionCompleted">[];
  readonly salesResults: SalesResultEntry[];
  readonly delisted: Map<string, DelistedProduct>;
  readonly ids: string[];
};

function createFake(): Fake {
  const recipes = new Map<string, Recipe>();
  const plans = new Map<string, ProductionPlan>();
  const runs: ProductionRun[] = [];
  const published: EventPayload<"production.ProductionCompleted">[] = [];
  const salesResults: SalesResultEntry[] = [];
  const delisted = new Map<string, DelistedProduct>();
  const ids: string[] = [];
  let counter = 0;
  let insideTransaction = false;

  const deps: ProductionDeps = {
    async runInTransaction(run) {
      insideTransaction = true;
      try {
        return await run(noTx);
      } finally {
        insideTransaction = false;
      }
    },
    async publishProductionCompleted(_tx, payload) {
      // 発行が業務データと同じトランザクションの中で起きていること。
      // ここが外れると「焼いたのに通知が出ていない」が起こりうる。
      expect(insideTransaction).toBe(true);
      published.push(payload);
    },
    recipes: {
      async nextVersion(_tx, productId) {
        const versions = [...recipes.values()]
          .filter((recipe) => recipe.productId === productId)
          .map((recipe) => recipe.version);
        return Math.max(0, ...versions) + 1;
      },
      async insert(_tx, recipe) {
        recipes.set(recipe.recipeId, recipe);
      },
      async findById(_tx, recipeId) {
        return recipes.get(recipeId) ?? null;
      },
    },
    plans: {
      async findById(_tx, planId) {
        return plans.get(planId) ?? null;
      },
      async findByBusinessDate(_tx, businessDate) {
        return [...plans.values()].find((plan) => plan.businessDate === businessDate) ?? null;
      },
      async save(_tx, plan) {
        plans.set(plan.productionPlanId, plan);
      },
      async removeProductFrom(_tx, productId, fromBusinessDate) {
        let removed = 0;
        for (const [id, plan] of plans) {
          if (plan.businessDate < fromBusinessDate) continue;
          const items = plan.items.filter((item) => item.productId !== productId);
          removed += plan.items.length - items.length;
          plans.set(id, { ...plan, items });
        }
        return removed;
      },
    },
    runs: {
      async insert(_tx, run) {
        runs.push(run);
      },
    },
    salesResults: {
      async add(_tx, entry) {
        salesResults.push(entry);
      },
      async listDailySales(_tx, productId, from, to) {
        const byDate = new Map<string, number>();
        for (const entry of salesResults) {
          if (entry.productId !== productId) continue;
          if (entry.businessDate < from || entry.businessDate > to) continue;
          byDate.set(
            entry.businessDate,
            (byDate.get(entry.businessDate) ?? 0) + entry.soldQuantity,
          );
        }
        return [...byDate].map(([businessDate, soldQuantity]) => ({
          businessDate,
          soldQuantity,
        }));
      },
      async reservedQuantity(_tx, productId, businessDate) {
        return salesResults
          .filter(
            (entry) =>
              entry.productId === productId &&
              entry.businessDate === businessDate &&
              entry.channel === "reservation",
          )
          .reduce((sum, entry) => sum + entry.soldQuantity, 0);
      },
    },
    delistedProducts: {
      async markDelisted(_tx, product) {
        delisted.set(product.productId, product);
      },
      async filterDelisted(_tx, productIds) {
        return new Set(productIds.filter((id) => delisted.has(id)));
      },
    },
    newId: () => {
      counter += 1;
      const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      ids.push(id);
      return id;
    },
    now: () => new Date("2026-09-11T00:00:00Z"),
  };

  return { deps, recipes, plans, runs, published, salesResults, delisted, ids };
}

function saleCompleted(
  payload: EventPayload<"sales.SaleCompleted">,
): EventEnvelope<"sales.SaleCompleted"> {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    name: "sales.SaleCompleted",
    payload,
    occurredAt: new Date(payload.soldAt),
  };
}

function productDelisted(
  payload: EventPayload<"catalog.ProductDelisted">,
): EventEnvelope<"catalog.ProductDelisted"> {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    name: "catalog.ProductDelisted",
    payload,
    occurredAt: new Date(payload.delistedAt),
  };
}

/** 1 バッチ 20 個取り、強力粉 1200g とバター 600g のレシピ。 */
async function registerCroissantRecipe(service: ReturnType<typeof createProductionService>) {
  return service.registerRecipe({
    productId: PRODUCT,
    yieldQuantity: pieces(20),
    lines: [
      { ingredientId: FLOUR, quantity: grams(1200) },
      { ingredientId: BUTTER, quantity: grams(600) },
    ],
  });
}

describe("registerRecipe", () => {
  it("配合を変えると版が増え、前の版は残る", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);

    const first = await registerCroissantRecipe(service);
    const second = await service.registerRecipe({
      productId: PRODUCT,
      yieldQuantity: pieces(20),
      // バターを増やした新しい配合。
      lines: [
        { ingredientId: FLOUR, quantity: grams(1200) },
        { ingredientId: BUTTER, quantity: grams(700) },
      ],
    });

    expect(first).not.toBe(second);
    expect((await service.getRecipe(first))?.version).toBe(1);
    expect((await service.getRecipe(second))?.version).toBe(2);
    // 過去の実績から辿れるよう、古い版の配合はそのまま残っている。
    expect((await service.getRecipe(first))?.lines).toContainEqual({
      ingredientId: BUTTER,
      quantity: grams(600),
    });
  });

  it("原材料が空のレシピは登録できない", async () => {
    const service = createProductionService(createFake().deps);
    await expect(
      service.registerRecipe({ productId: PRODUCT, yieldQuantity: pieces(20), lines: [] }),
    ).rejects.toThrow("原材料が 1 つ以上必要");
  });

  it("焼ける個数は整数の個数でなければならない", async () => {
    const service = createProductionService(createFake().deps);
    await expect(
      service.registerRecipe({
        productId: PRODUCT,
        yieldQuantity: grams(20),
        lines: [{ ingredientId: FLOUR, quantity: grams(1200) }],
      }),
    ).rejects.toThrow("個数 (piece) で指定");
  });
});

describe("planProduction", () => {
  it("根拠付きで計画を立て、同じ営業日は立て直しで置き換わる", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);
    const recipeId = await registerCroissantRecipe(service);

    const planId = await service.planProduction({
      businessDate: "2026-09-12",
      items: [{ productId: PRODUCT, recipeId, plannedQuantity: pieces(40), basis: "forecast" }],
    });

    // 朝の立て直し: 予約が入ったので 60 個に増やす。
    const replanned = await service.planProduction({
      businessDate: "2026-09-12",
      items: [{ productId: PRODUCT, recipeId, plannedQuantity: pieces(60), basis: "reservation" }],
    });

    expect(replanned).toBe(planId);
    const plan = await service.getProductionPlan("2026-09-12");
    expect(plan?.items).toEqual([
      { productId: PRODUCT, recipeId, plannedQuantity: pieces(60), basis: "reservation" },
    ]);
  });

  it("販売停止になった商品は計画から外れる (他の商品は残る)", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);
    const recipeId = await registerCroissantRecipe(service);
    const otherRecipeId = await service.registerRecipe({
      productId: OTHER_PRODUCT,
      yieldQuantity: pieces(10),
      lines: [{ ingredientId: FLOUR, quantity: grams(800) }],
    });

    await service.dropDelistedProductFromPlan(
      productDelisted({
        productId: PRODUCT,
        delistedAt: "2026-09-11T09:00:00+09:00",
        reason: "seasonal",
      }),
      noTx,
    );

    await service.planProduction({
      businessDate: "2026-09-12",
      items: [
        { productId: PRODUCT, recipeId, plannedQuantity: pieces(40), basis: "forecast" },
        {
          productId: OTHER_PRODUCT,
          recipeId: otherRecipeId,
          plannedQuantity: pieces(10),
          basis: "manual",
        },
      ],
    });

    const plan = await service.getProductionPlan("2026-09-12");
    expect(plan?.items.map((item) => item.productId)).toEqual([OTHER_PRODUCT]);
  });

  it("別の商品のレシピを指定した計画は立てられない", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);
    const recipeId = await registerCroissantRecipe(service);

    await expect(
      service.planProduction({
        businessDate: "2026-09-12",
        items: [
          {
            productId: OTHER_PRODUCT,
            recipeId,
            plannedQuantity: pieces(10),
            basis: "manual",
          },
        ],
      }),
    ).rejects.toThrow("別の商品");
  });
});

describe("completeProductionRun", () => {
  async function setupPlan(service: ReturnType<typeof createProductionService>) {
    const recipeId = await registerCroissantRecipe(service);
    const planId = await service.planProduction({
      businessDate: "2026-09-12",
      items: [{ productId: PRODUCT, recipeId, plannedQuantity: pieces(40), basis: "forecast" }],
    });
    return { recipeId, planId };
  }

  it("レシピ×バッチ数で消費した原材料を算出してイベントに載せる", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);
    const { recipeId, planId } = await setupPlan(service);

    const runId = await service.completeProductionRun({
      productionPlanId: planId,
      productId: PRODUCT,
      recipeId,
      // 20 個取りのレシピで 24 個。生地は 2 バッチ仕込んでいる。
      producedQuantity: pieces(24),
      lotCode: "CR-20260912-01",
      bestBefore: "2026-09-12",
      completedAt: "2026-09-12T06:30:00+09:00",
    });

    expect(fake.published).toHaveLength(1);
    const event = fake.published[0];
    expect(event?.productionRunId).toBe(runId);
    expect(event?.consumedIngredients).toEqual([
      { ingredientId: FLOUR, quantity: grams(2400) },
      { ingredientId: BUTTER, quantity: grams(1200) },
    ]);
    // inventory がレシピを引かなくても在庫を減らせるだけの情報が載っている。
    expect(event?.producedQuantity).toEqual(pieces(24));
    expect(event?.lotCode).toBe("CR-20260912-01");
  });

  it("計画数と実績数の両方を残す", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);
    const { recipeId, planId } = await setupPlan(service);

    await service.completeProductionRun({
      productionPlanId: planId,
      productId: PRODUCT,
      recipeId,
      producedQuantity: pieces(36),
      lotCode: "CR-20260912-01",
      bestBefore: "2026-09-12",
      completedAt: "2026-09-12T06:30:00+09:00",
    });

    expect(fake.runs[0]).toMatchObject({
      plannedQuantity: pieces(40),
      producedQuantity: pieces(36),
    });
  });

  it("計画に無い商品を焼いたら計画数 0 として残る", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);
    const { planId } = await setupPlan(service);
    const otherRecipeId = await service.registerRecipe({
      productId: OTHER_PRODUCT,
      yieldQuantity: pieces(10),
      lines: [{ ingredientId: FLOUR, quantity: grams(800) }],
    });

    await service.completeProductionRun({
      productionPlanId: planId,
      productId: OTHER_PRODUCT,
      recipeId: otherRecipeId,
      producedQuantity: pieces(10),
      lotCode: "PA-20260912-01",
      bestBefore: "2026-09-12",
      completedAt: "2026-09-12T07:00:00+09:00",
    });

    expect(fake.runs[0]).toMatchObject({
      plannedQuantity: pieces(0),
      producedQuantity: pieces(10),
    });
  });

  it("計画が見つからなければ記録しない", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);
    const recipeId = await registerCroissantRecipe(service);

    await expect(
      service.completeProductionRun({
        productionPlanId: PLAN_ID,
        productId: PRODUCT,
        recipeId,
        producedQuantity: pieces(20),
        lotCode: "CR-20260912-01",
        bestBefore: "2026-09-12",
        completedAt: "2026-09-12T06:30:00+09:00",
      }),
    ).rejects.toThrow("製造計画が見つかりません");
    expect(fake.published).toHaveLength(0);
  });
});

describe("購読: sales.SaleCompleted", () => {
  it("販売時刻の現地日付を営業日として実績を積む", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);

    await service.recordSalesResult(
      saleCompleted({
        saleId: "77777777-7777-4777-8777-777777777777",
        channel: "storefront",
        // 現地 (+09:00) では 9/12 の朝。UTC に直すと 9/11 になる時刻。
        soldAt: "2026-09-12T07:42:00+09:00",
        lines: [{ productId: PRODUCT, lotCode: "CR-1", quantity: pieces(2), unitPriceJpy: 280 }],
        totalJpy: 560,
      }),
      noTx,
    );

    expect(fake.salesResults).toEqual([
      {
        businessDate: "2026-09-12",
        productId: PRODUCT,
        channel: "storefront",
        soldQuantity: 2,
      },
    ]);
  });

  it("個数以外の行は実績に入れない (予測の標本を壊さない)", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);

    await service.recordSalesResult(
      saleCompleted({
        saleId: "77777777-7777-4777-8777-777777777777",
        channel: "storefront",
        soldAt: "2026-09-12T07:42:00+09:00",
        lines: [{ productId: PRODUCT, lotCode: "CR-1", quantity: grams(300), unitPriceJpy: 280 }],
        totalJpy: 280,
      }),
      noTx,
    );

    expect(fake.salesResults).toHaveLength(0);
  });
});

describe("getDemandForecast", () => {
  async function recordSale(
    service: ReturnType<typeof createProductionService>,
    businessDate: string,
    quantity: number,
    channel: "storefront" | "reservation" = "storefront",
  ) {
    await service.recordSalesResult(
      saleCompleted({
        saleId: "77777777-7777-4777-8777-777777777777",
        channel,
        soldAt: `${businessDate}T12:00:00+09:00`,
        lines: [
          {
            productId: PRODUCT,
            lotCode: "CR-1",
            quantity: pieces(quantity),
            unitPriceJpy: 280,
          },
        ],
        totalJpy: 280 * quantity,
      }),
      noTx,
    );
  }

  it("同じ曜日の実績を標本にし、根拠を添えて返す", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);

    // 土曜 (9/5, 9/12) は多く、平日は少ない。予測対象は土曜の 9/19。
    await recordSale(service, "2026-09-05", 40);
    await recordSale(service, "2026-09-12", 44);
    await recordSale(service, "2026-09-08", 12);
    await recordSale(service, "2026-09-09", 10);

    const forecast = await service.getDemandForecast(PRODUCT, "2026-09-19");

    // 平日を混ぜた平均 (26.5) ではなく、土曜だけの平均 42。
    expect(forecast.basis.sampleDays).toBe(2);
    expect(forecast.basis.averageSoldQuantity).toEqual(pieces(42));
    expect(forecast.forecastQuantity).toEqual(pieces(42));
  });

  it("同じ曜日の標本が足りなければ全曜日で見る", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);

    await recordSale(service, "2026-09-08", 12);
    await recordSale(service, "2026-09-09", 11);

    const forecast = await service.getDemandForecast(PRODUCT, "2026-09-19");

    expect(forecast.basis.sampleDays).toBe(2);
    // 11.5 の切り上げ。欠品より廃棄を選ぶ (domain/demand-forecast.ts 参照)。
    expect(forecast.forecastQuantity).toEqual(pieces(12));
    expect(forecast.basis.averageSoldQuantity).toEqual(pieces(11.5));
  });

  it("確定済みの予約は予測の下限になる", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);

    await recordSale(service, "2026-09-05", 10);
    await recordSale(service, "2026-09-12", 10);
    // 9/19 に 30 個の予約が確定している。
    await recordSale(service, "2026-09-19", 30, "reservation");

    const forecast = await service.getDemandForecast(PRODUCT, "2026-09-19");

    expect(forecast.basis.reservedQuantity).toEqual(pieces(30));
    expect(forecast.forecastQuantity).toEqual(pieces(30));
  });

  it("実績が無ければ 0 個。根拠にも標本 0 日と出る", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);

    const forecast = await service.getDemandForecast(PRODUCT, "2026-09-19");

    expect(forecast.forecastQuantity).toEqual(pieces(0));
    expect(forecast.basis).toEqual({
      sampleDays: 0,
      averageSoldQuantity: pieces(0),
      reservedQuantity: pieces(0),
    });
  });
});

describe("購読: catalog.ProductDelisted", () => {
  it("以降の計画からは外し、過去の計画は残す", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);
    const recipeId = await registerCroissantRecipe(service);

    await service.planProduction({
      businessDate: "2026-09-10",
      items: [{ productId: PRODUCT, recipeId, plannedQuantity: pieces(40), basis: "forecast" }],
    });
    await service.planProduction({
      businessDate: "2026-09-12",
      items: [{ productId: PRODUCT, recipeId, plannedQuantity: pieces(40), basis: "forecast" }],
    });

    await service.dropDelistedProductFromPlan(
      productDelisted({
        productId: PRODUCT,
        delistedAt: "2026-09-11T09:00:00+09:00",
        reason: "discontinued",
      }),
      noTx,
    );

    // 過去 (9/10) は「なぜその日それを焼いたか」の記録なので消さない。
    expect((await service.getProductionPlan("2026-09-10"))?.items).toHaveLength(1);
    expect((await service.getProductionPlan("2026-09-12"))?.items).toHaveLength(0);
  });
});

describe("レシピの版と製造実績", () => {
  it("配合を変えた後でも、過去の実績からは当時の配合が引ける", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);

    // 版 1 で計画して焼く。
    const v1 = await registerCroissantRecipe(service);
    const planId = await service.planProduction({
      businessDate: "2026-09-12",
      items: [{ productId: PRODUCT, recipeId: v1, plannedQuantity: pieces(40), basis: "forecast" }],
    });
    await service.completeProductionRun({
      productionPlanId: planId,
      productId: PRODUCT,
      recipeId: v1,
      producedQuantity: pieces(40),
      lotCode: "CR-20260912-01",
      bestBefore: "2026-09-12",
      completedAt: "2026-09-12T06:30:00+09:00",
    });

    // 翌日、バターを増やした版 2 に切り替える。
    const v2 = await service.registerRecipe({
      productId: PRODUCT,
      yieldQuantity: pieces(20),
      lines: [
        { ingredientId: FLOUR, quantity: grams(1200) },
        { ingredientId: BUTTER, quantity: grams(900) },
      ],
    });

    const recorded = fake.runs[0];
    expect(recorded?.recipeId).toBe(v1);

    // 実績が指しているのは当時の版。版 2 の配合には引きずられない。
    const asBaked = await service.getRecipe(recorded?.recipeId ?? "");
    expect(asBaked?.version).toBe(1);
    expect(asBaked?.lines).toContainEqual({ ingredientId: BUTTER, quantity: grams(600) });
    expect((await service.getRecipe(v2))?.lines).toContainEqual({
      ingredientId: BUTTER,
      quantity: grams(900),
    });

    // 原価を追えること: 実績に載った消費量は当時の配合 × バッチ数。
    expect(fake.published[0]?.consumedIngredients).toEqual([
      { ingredientId: FLOUR, quantity: grams(2400) },
      { ingredientId: BUTTER, quantity: grams(1200) },
    ]);
  });

  it("版を切り替えても、進行中の計画は指定した版のまま焼ける", async () => {
    const fake = createFake();
    const service = createProductionService(fake.deps);
    const v1 = await registerCroissantRecipe(service);
    await service.planProduction({
      businessDate: "2026-09-12",
      items: [{ productId: PRODUCT, recipeId: v1, plannedQuantity: pieces(20), basis: "manual" }],
    });
    await service.registerRecipe({
      productId: PRODUCT,
      yieldQuantity: pieces(20),
      lines: [{ ingredientId: FLOUR, quantity: grams(1500) }],
    });

    const plan = await service.getProductionPlan("2026-09-12");
    expect(plan?.items[0]?.recipeId).toBe(v1);
  });
});
