import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ProductionNotFoundError, ProductionValidationError } from "../domain/errors.ts";
import { productionService } from "../infra/module.ts";

/**
 * production モジュールの HTTP ルーター。
 *
 * スキーマ先行: レスポンスの形を zod で先に決め、createRoute のレスポンス定義に
 * 渡すことで、OpenAPI ドキュメントとハンドラの戻り値の型が同じ1つの定義から出る。
 * ハンドラ側でスキーマとずれた JSON を返すと型エラーになる。
 *
 * 業務のルールはここに書かない。application/ のユースケースを呼ぶだけにする。
 * 他モジュールが index.ts 経由で呼んだときと挙動を揃えるため。
 */

// ---------------------------------------------------------------------------
// スキーマ
// ---------------------------------------------------------------------------

/**
 * 数量。契約の正本は shared/events.ts の quantitySchema で、これはその HTTP 面の写し。
 * OpenAPI のメタデータを付けるために @hono/zod-openapi の z で組み直している。
 * 値の検証はドメイン側でもう一度行う (HTTP を通らない呼び出しがあるため)。
 */
const QuantitySchema = z
  .object({
    amount: z.number().finite(),
    unit: z.enum(["g", "ml", "piece"]),
  })
  .openapi("Quantity");

const BusinessDateSchema = z.iso.date().openapi({ example: "2026-09-12" });

const RecipeLineSchema = z
  .object({
    ingredientId: z.uuid(),
    /** 1 バッチあたりの分量。 */
    quantity: QuantitySchema,
  })
  .openapi("RecipeLine");

const RecipeSchema = z
  .object({
    recipeId: z.uuid(),
    productId: z.uuid(),
    /** 版。配合を変えると増える。製造実績はこの版を指す。 */
    version: z.number().int().positive(),
    yieldQuantity: QuantitySchema,
    lines: z.array(RecipeLineSchema),
    registeredAt: z.iso.datetime({ offset: true }),
  })
  .openapi("Recipe");

const RegisterRecipeSchema = z
  .object({
    productId: z.uuid(),
    /** 1 バッチで焼ける個数。 */
    yieldQuantity: QuantitySchema,
    lines: z.array(RecipeLineSchema).min(1),
  })
  .openapi("RegisterRecipeRequest");

/** なぜその数にしたか。数量と同じくらい重要なので、必須にして省略させない。 */
const PlanBasisSchema = z.enum(["forecast", "reservation", "manual"]).openapi("PlanBasis");

const PlanItemSchema = z
  .object({
    productId: z.uuid(),
    recipeId: z.uuid(),
    plannedQuantity: QuantitySchema,
    basis: PlanBasisSchema,
  })
  .openapi("ProductionPlanItem");

const PlanSchema = z
  .object({
    productionPlanId: z.uuid(),
    businessDate: BusinessDateSchema,
    items: z.array(PlanItemSchema),
  })
  .openapi("ProductionPlan");

const PlanProductionSchema = z
  .object({
    businessDate: BusinessDateSchema,
    items: z.array(PlanItemSchema),
  })
  .openapi("PlanProductionRequest");

const CompleteRunSchema = z
  .object({
    productionPlanId: z.uuid(),
    productId: z.uuid(),
    recipeId: z.uuid(),
    /** 焼き上がった個数。計画数との差は実績として残る。 */
    producedQuantity: QuantitySchema,
    lotCode: z.string().min(1),
    bestBefore: BusinessDateSchema,
    completedAt: z.iso.datetime({ offset: true }),
  })
  .openapi("CompleteProductionRunRequest");

/** 予測は必ず根拠付きで返す。「なぜ 30 個なのか」に答えられない予測は直せない。 */
const ForecastSchema = z
  .object({
    productId: z.uuid(),
    businessDate: BusinessDateSchema,
    forecastQuantity: QuantitySchema,
    basis: z.object({
      sampleDays: z.number().int().nonnegative(),
      averageSoldQuantity: QuantitySchema,
      reservedQuantity: QuantitySchema,
    }),
  })
  .openapi("DemandForecast");

const ErrorSchema = z
  .object({
    code: z.enum(["invalid_production", "production_not_found"]),
    message: z.string(),
  })
  .openapi("ProductionError");

const errorResponse = (description: string) =>
  ({ description, content: { "application/json": { schema: ErrorSchema } } }) as const;

// ---------------------------------------------------------------------------
// ルート定義
// ---------------------------------------------------------------------------

const statusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["production"],
  summary: "production モジュールの疎通確認",
  description: "製造計画、レシピ、製造実績。",
  responses: {
    200: {
      description: "モジュールが応答している",
      content: {
        "application/json": {
          schema: z.object({ module: z.literal("production"), status: z.literal("ok") }),
        },
      },
    },
  },
});

const registerRecipeRoute = createRoute({
  method: "post",
  path: "/recipes",
  tags: ["production"],
  summary: "レシピの版を登録する",
  description:
    "既存のレシピは書き換えない。配合を変えるときも新しい版を作る。" +
    "過去の製造実績から当時の配合を引けなくなるのを防ぐため。",
  request: {
    body: { content: { "application/json": { schema: RegisterRecipeSchema } }, required: true },
  },
  responses: {
    201: {
      description: "登録した版",
      content: { "application/json": { schema: z.object({ recipeId: z.uuid() }) } },
    },
    400: errorResponse("レシピとして成り立たない"),
  },
});

const getRecipeRoute = createRoute({
  method: "get",
  path: "/recipes/{recipeId}",
  tags: ["production"],
  summary: "レシピの版を1件取得する",
  request: {
    params: z.object({ recipeId: z.uuid().openapi({ param: { name: "recipeId", in: "path" } }) }),
  },
  responses: {
    200: { description: "レシピ", content: { "application/json": { schema: RecipeSchema } } },
    404: errorResponse("その版が存在しない"),
  },
});

const planRoute = createRoute({
  method: "post",
  path: "/plans",
  tags: ["production"],
  summary: "製造計画を立てる (コアドメイン)",
  description:
    "今日何を何個焼くか。同じ営業日に何度でも立て直せ、そのつど置き換わる。" +
    "販売停止になった商品は自動で外れる。",
  request: {
    body: { content: { "application/json": { schema: PlanProductionSchema } }, required: true },
  },
  responses: {
    201: {
      description: "立てた計画",
      content: { "application/json": { schema: z.object({ productionPlanId: z.uuid() }) } },
    },
    400: errorResponse("計画として成り立たない"),
    404: errorResponse("指定したレシピが存在しない"),
  },
});

const getPlanRoute = createRoute({
  method: "get",
  path: "/plans/{businessDate}",
  tags: ["production"],
  summary: "営業日の製造計画を取得する",
  request: {
    params: z.object({
      businessDate: BusinessDateSchema.openapi({ param: { name: "businessDate", in: "path" } }),
    }),
  },
  responses: {
    200: { description: "計画", content: { "application/json": { schema: PlanSchema } } },
    400: errorResponse("営業日の形式が不正"),
    404: errorResponse("その営業日の計画が無い"),
  },
});

const completeRunRoute = createRoute({
  method: "post",
  path: "/runs",
  tags: ["production"],
  summary: "製造完了を記録する",
  description:
    "消費した原材料をレシピ×バッチ数から算出し、`production.ProductionCompleted` を " +
    "実績の書き込みと同じトランザクションで outbox に積む。",
  request: {
    body: { content: { "application/json": { schema: CompleteRunSchema } }, required: true },
  },
  responses: {
    201: {
      description: "記録した実績",
      content: { "application/json": { schema: z.object({ productionRunId: z.uuid() }) } },
    },
    400: errorResponse("実績として成り立たない"),
    404: errorResponse("レシピか計画が存在しない"),
  },
});

const forecastRoute = createRoute({
  method: "get",
  path: "/forecast/{productId}",
  tags: ["production"],
  summary: "需要を見積もる",
  description:
    "購読で溜めた販売実績から見積もる。同じ曜日の直近の実績を標本にし、" +
    "確定済みの予約を下限にする。根拠 (basis) を必ず添える。",
  request: {
    params: z.object({
      productId: z.uuid().openapi({ param: { name: "productId", in: "path" } }),
    }),
    query: z.object({
      businessDate: BusinessDateSchema.openapi({ param: { name: "businessDate", in: "query" } }),
    }),
  },
  responses: {
    200: { description: "予測", content: { "application/json": { schema: ForecastSchema } } },
    400: errorResponse("営業日の形式が不正"),
  },
});

// ---------------------------------------------------------------------------
// ハンドラ
// ---------------------------------------------------------------------------

type ErrorBody = z.infer<typeof ErrorSchema>;

const invalid = (message: string): ErrorBody => ({ code: "invalid_production", message });
const notFound = (message: string): ErrorBody => ({ code: "production_not_found", message });

/** ドメインエラーの意味を HTTP のステータスに対応付ける。逆向きの依存を作らないため。 */
function asErrorBody(error: unknown): { body: ErrorBody; status: 400 | 404 } | null {
  if (error instanceof ProductionValidationError) {
    return { body: invalid(error.message), status: 400 };
  }
  if (error instanceof ProductionNotFoundError) {
    return { body: notFound(error.message), status: 404 };
  }
  return null;
}

// strict: false — 末尾スラッシュの有無で挙動を変えない (`/production` と `/production/` を同じに扱う)。
export const productionRoutes = new OpenAPIHono({ strict: false })
  .openapi(statusRoute, (c) => c.json({ module: "production", status: "ok" } as const, 200))
  .openapi(registerRecipeRoute, async (c) => {
    try {
      const recipeId = await productionService().registerRecipe(c.req.valid("json"));
      return c.json({ recipeId }, 201);
    } catch (error) {
      const mapped = asErrorBody(error);
      if (mapped?.status === 400) return c.json(mapped.body, 400);
      throw error;
    }
  })
  .openapi(getRecipeRoute, async (c) => {
    const { recipeId } = c.req.valid("param");
    const recipe = await productionService().getRecipe(recipeId);
    if (recipe === null) {
      return c.json(notFound(`レシピ ${recipeId} は存在しません`), 404);
    }
    return c.json(
      {
        recipeId: recipe.recipeId,
        productId: recipe.productId,
        version: recipe.version,
        yieldQuantity: recipe.yieldQuantity,
        lines: recipe.lines.map((line) => ({ ...line })),
        registeredAt: recipe.registeredAt.toISOString(),
      },
      200,
    );
  })
  .openapi(planRoute, async (c) => {
    try {
      const productionPlanId = await productionService().planProduction(c.req.valid("json"));
      return c.json({ productionPlanId }, 201);
    } catch (error) {
      const mapped = asErrorBody(error);
      if (mapped === null) throw error;
      return mapped.status === 400 ? c.json(mapped.body, 400) : c.json(mapped.body, 404);
    }
  })
  .openapi(getPlanRoute, async (c) => {
    const { businessDate } = c.req.valid("param");
    try {
      const plan = await productionService().getProductionPlan(businessDate);
      if (plan === null) {
        return c.json(notFound(`${businessDate} の製造計画はまだありません`), 404);
      }
      return c.json({ ...plan, items: plan.items.map((item) => ({ ...item })) }, 200);
    } catch (error) {
      const mapped = asErrorBody(error);
      if (mapped?.status === 400) return c.json(mapped.body, 400);
      throw error;
    }
  })
  .openapi(completeRunRoute, async (c) => {
    try {
      const productionRunId = await productionService().completeProductionRun(c.req.valid("json"));
      return c.json({ productionRunId }, 201);
    } catch (error) {
      const mapped = asErrorBody(error);
      if (mapped === null) throw error;
      return mapped.status === 400 ? c.json(mapped.body, 400) : c.json(mapped.body, 404);
    }
  })
  .openapi(forecastRoute, async (c) => {
    const { productId } = c.req.valid("param");
    const { businessDate } = c.req.valid("query");
    try {
      return c.json(await productionService().getDemandForecast(productId, businessDate), 200);
    } catch (error) {
      const mapped = asErrorBody(error);
      if (mapped?.status === 400) return c.json(mapped.body, 400);
      throw error;
    }
  });

/** hc の RPC クライアント用。api.ts の型に取り込まれる。 */
export type ProductionRoutes = typeof productionRoutes;
