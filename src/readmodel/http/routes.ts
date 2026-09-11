import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getDailyDashboard } from "../queries.ts";

/**
 * 参照モデルの HTTP 面 (ダッシュボード)。
 *
 * スキーマ先行: レスポンスの形を zod で先に決め、createRoute のレスポンス定義に
 * 渡すことで、OpenAPI ドキュメントとハンドラの戻り値の型が同じ1つの定義から出る。
 *
 * ここはモジュールの http/routes.ts と違い、どのコンテキストにも属さない。
 * 業務の操作は一切受けず、投影済みの表を読むだけ。書き込み口を持たないのは、
 * 参照モデルへの入力がイベントだけであるという性質をそのまま形にしたもの。
 */

const QuantitySchema = z
  .object({
    amount: z.number().finite(),
    unit: z.enum(["g", "ml", "piece"]),
  })
  .openapi("Quantity");

/**
 * 商品別の1日。
 *
 * 製造数と販売数を並べ、差 (= 当日限りなのでそのまま廃棄ロス) を出す。
 * 名前を返さないのは、どのイベントにも商品名が載っていないため。
 * 名前を出すには catalog に同期で問い合わせることになるが、それは参照モデルの
 * 役目ではない (画面側が catalog の公開 API を引く)。
 */
const DailyProductSchema = z
  .object({
    productId: z.uuid(),
    producedPieces: z.number().int(),
    soldPieces: z.number().int(),
    leftoverPieces: z.number().int(),
    salesJpy: z.number().int(),
    delisted: z.boolean(),
    delistReason: z.enum(["discontinued", "seasonal", "supply_shortage", "other"]).nullable(),
  })
  .openapi("DailyProductSummary");

const DailyLotSchema = z
  .object({
    lotCode: z.string(),
    productId: z.uuid(),
    bestBefore: z.iso.date().nullable(),
    producedPieces: z.number().int(),
    soldPieces: z.number().int(),
    leftoverPieces: z.number().int(),
    salesJpy: z.number().int(),
  })
  .openapi("DailyLotSummary");

const DailyIngredientSchema = z
  .object({
    ingredientId: z.uuid(),
    received: QuantitySchema,
    consumed: QuantitySchema,
    reorderBreach: z
      .object({
        onHand: QuantitySchema,
        reorderPoint: QuantitySchema,
        suggestedOrderQuantity: QuantitySchema,
        detectedAt: z.iso.datetime({ offset: true }),
      })
      .nullable(),
  })
  .openapi("DailyIngredientFlow");

const DailyDashboardSchema = z
  .object({
    businessDate: z.iso.date(),
    totals: z.object({
      producedPieces: z.number().int(),
      soldPieces: z.number().int(),
      leftoverPieces: z.number().int(),
      salesJpy: z.number().int(),
      wasteRatePercent: z.number(),
    }),
    products: z.array(DailyProductSchema),
    lots: z.array(DailyLotSchema),
    ingredients: z.array(DailyIngredientSchema),
  })
  .openapi("DailyDashboard");

const dailyRoute = createRoute({
  method: "get",
  path: "/daily/{businessDate}",
  tags: ["dashboard"],
  summary: "今日の在庫と販売状況",
  description:
    "コンテキストをまたぐ画面。JOIN ではなくイベントから組み立てた参照モデルを読む。" +
    "製造数 − 販売数 = 売れ残り (当日限りなので廃棄ロス) が一目で分かる。",
  request: {
    params: z.object({
      businessDate: z.iso.date().openapi({
        param: { name: "businessDate", in: "path" },
        example: "2026-09-11",
      }),
    }),
  },
  responses: {
    200: {
      description: "その日のダッシュボード。まだイベントが無い日は空の集計を返す",
      content: { "application/json": { schema: DailyDashboardSchema } },
    },
  },
});

// strict: false — 末尾スラッシュの有無で挙動を変えない。
export const readmodelRoutes = new OpenAPIHono({ strict: false }).openapi(dailyRoute, async (c) => {
  const { businessDate } = c.req.valid("param");
  const dashboard = await getDailyDashboard(businessDate);
  // 公開面の型は readonly。レスポンススキーマは可変配列を要求するので詰め替える。
  return c.json(
    {
      ...dashboard,
      products: [...dashboard.products],
      lots: [...dashboard.lots],
      ingredients: [...dashboard.ingredients],
    },
    200,
  );
});

/** hc の RPC クライアント用。api.ts の型に取り込まれる。 */
export type ReadModelRoutes = typeof readmodelRoutes;
