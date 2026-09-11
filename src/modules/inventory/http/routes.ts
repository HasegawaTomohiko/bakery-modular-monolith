import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { type InventoryErrorKind, isInventoryError } from "../domain/errors.ts";
import { inventory } from "../index.ts";

/**
 * inventory モジュールの HTTP ルーター。
 *
 * スキーマ先行: レスポンスの形を zod で先に決め、createRoute のレスポンス定義に
 * 渡すことで、OpenAPI ドキュメントとハンドラの戻り値の型が同じ1つの定義から出る。
 * ハンドラ側でスキーマとずれた JSON を返すと型エラーになる。
 *
 * ここは公開ユースケース (index.ts) を呼ぶだけの薄い層。業務ルールは application/ にある。
 * HTTP のステータスコードはドメインに持ち込まないので、対応付けはこのファイルで行う。
 */

// ---------------------------------------------------------------------------
// 共通スキーマ
// ---------------------------------------------------------------------------

/** 単位は基本単位に正規化して運ぶ (kg ではなく g)。shared/events.ts の契約と同じ。 */
const QuantitySchema = z
  .object({
    amount: z.number().finite(),
    unit: z.enum(["g", "ml", "piece"]),
  })
  .openapi("Quantity");

const ErrorSchema = z
  .object({
    error: z.string(),
    message: z.string(),
  })
  .openapi("InventoryError");

const errorResponse = (description: string) =>
  ({
    description,
    content: { "application/json": { schema: ErrorSchema } },
  }) as const;

/**
 * ドメインエラーの種類を HTTP に写す。
 *
 *   not_found — 対象が無い
 *   conflict  — 状態が合わない
 *   invalid   — 業務ルール違反。zod を通ったが中身が業務的に成り立たない
 */
const STATUS_BY_KIND: Record<InventoryErrorKind, 404 | 409 | 422> = {
  not_found: 404,
  conflict: 409,
  invalid: 422,
};

/** 原材料在庫。質量/体積で数え、賞味期限を持ち、発注点を持つ。 */
const IngredientStockSchema = z
  .object({
    ingredientId: z.uuid(),
    name: z.string(),
    onHand: QuantitySchema,
    reorderPoint: QuantitySchema,
    nearestBestBefore: z.iso.date().nullable(),
  })
  .openapi("IngredientStock");

/** 製品ロット。個数で数え、当日限り。発注点は無い (製造計画が決める)。 */
const ProductLotSchema = z
  .object({
    lotCode: z.string(),
    productId: z.uuid(),
    onHand: QuantitySchema,
    bestBefore: z.iso.date(),
    producedAt: z.iso.datetime({ offset: true }),
  })
  .openapi("ProductLot");

const StockAlertSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("negative_ingredient_stock"),
      ingredientId: z.uuid(),
      onHand: QuantitySchema,
    }),
    z.object({
      kind: z.literal("negative_product_stock"),
      lotCode: z.string(),
      onHand: QuantitySchema,
    }),
    z.object({
      kind: z.literal("expired_ingredient"),
      ingredientId: z.uuid(),
      bestBefore: z.iso.date(),
    }),
  ])
  .openapi("StockAlert");

const IngredientIdParam = z.object({
  ingredientId: z.uuid().openapi({ param: { name: "ingredientId", in: "path" } }),
});

// ---------------------------------------------------------------------------
// ルート定義
// ---------------------------------------------------------------------------

const InventoryStatusSchema = z
  .object({
    module: z.literal("inventory"),
    status: z.literal("ok"),
  })
  .openapi("InventoryStatus");

const statusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["inventory"],
  summary: "inventory モジュールの疎通確認",
  description: "原材料在庫と製品ロット、発注点。",
  responses: {
    200: {
      description: "モジュールが応答している",
      content: { "application/json": { schema: InventoryStatusSchema } },
    },
  },
});

const registerIngredientRoute = createRoute({
  method: "post",
  path: "/ingredients",
  tags: ["inventory"],
  summary: "原材料を登録する",
  description:
    "ingredientId は inventory が採番する。purchasing と production はこの ID を" +
    "識別子としてだけ持つ。",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            unit: z.enum(["g", "ml", "piece"]),
            reorderPoint: QuantitySchema,
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "登録した",
      content: { "application/json": { schema: z.object({ ingredientId: z.uuid() }) } },
    },
    422: errorResponse("業務ルールに反する入力"),
  },
});

const listIngredientsRoute = createRoute({
  method: "get",
  path: "/ingredients",
  tags: ["inventory"],
  summary: "原材料在庫の一覧",
  description: "在庫数は棚卸で補正する近似値。マイナスもそのまま返す (アラートは /alerts)。",
  responses: {
    200: {
      description: "原材料在庫",
      content: { "application/json": { schema: z.array(IngredientStockSchema) } },
    },
  },
});

const getIngredientRoute = createRoute({
  method: "get",
  path: "/ingredients/{ingredientId}",
  tags: ["inventory"],
  summary: "原材料在庫を1件取得する",
  request: { params: IngredientIdParam },
  responses: {
    200: {
      description: "原材料在庫",
      content: { "application/json": { schema: IngredientStockSchema } },
    },
    404: errorResponse("原材料が無い"),
  },
});

const setReorderPointRoute = createRoute({
  method: "patch",
  path: "/ingredients/{ingredientId}/reorder-point",
  tags: ["inventory"],
  summary: "発注点を設定する",
  description:
    "在庫がこれを下回った瞬間に inventory.ReorderPointBreached を発行し、" +
    "purchasing が発注提案を作る。下回っている間ずっと発行することはしない。",
  request: {
    params: IngredientIdParam,
    body: {
      content: { "application/json": { schema: z.object({ reorderPoint: QuantitySchema }) } },
    },
  },
  responses: {
    204: { description: "設定した" },
    404: errorResponse("原材料が無い"),
    422: errorResponse("業務ルールに反する入力"),
  },
});

const listProductLotsRoute = createRoute({
  method: "get",
  path: "/product-lots",
  tags: ["inventory"],
  summary: "製品ロットの一覧",
  description:
    "「今朝焼いた24個」というロット。当日限りで、売れ残りは廃棄になる。" +
    "在庫 0 のロット (売り切り) は出さない。",
  responses: {
    200: {
      description: "製品ロット",
      content: { "application/json": { schema: z.array(ProductLotSchema) } },
    },
  },
});

const recordStocktakeRoute = createRoute({
  method: "post",
  path: "/stocktakes",
  tags: ["inventory"],
  summary: "棚卸を記録する",
  description:
    "実地の数がそのまま新しい帳簿在庫になる。在庫は棚卸で補正する近似値であり、" +
    "これが唯一の正攻法の補正手段。帳簿とのズレは明細として残る。",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            countedAt: z.iso.datetime({ offset: true }),
            ingredients: z
              .array(z.object({ ingredientId: z.uuid(), counted: QuantitySchema }))
              .default([]),
            productLots: z
              .array(z.object({ lotCode: z.string().min(1), counted: QuantitySchema }))
              .default([]),
          }),
        },
      },
    },
  },
  responses: {
    204: { description: "記録した" },
    404: errorResponse("原材料または製品ロットが無い"),
    422: errorResponse("業務ルールに反する入力"),
  },
});

const listAlertsRoute = createRoute({
  method: "get",
  path: "/alerts",
  tags: ["inventory"],
  summary: "在庫の異常の一覧",
  description:
    "在庫のマイナスと期限切れ。結果整合なので販売確定が製造完了より先に届けば" +
    "在庫は一時的にマイナスになる。エラーではなくアラートとして扱い、処理は止めない。",
  responses: {
    200: {
      description: "アラート",
      content: { "application/json": { schema: z.array(StockAlertSchema) } },
    },
  },
});

// ---------------------------------------------------------------------------
// ルーター
// ---------------------------------------------------------------------------

// strict: false — 末尾スラッシュの有無で挙動を変えない (`/inventory` と `/inventory/` を同じに扱う)。
export const inventoryRoutes = new OpenAPIHono({ strict: false })
  .openapi(statusRoute, (c) => c.json({ module: "inventory", status: "ok" } as const, 200))

  .openapi(registerIngredientRoute, async (c) => {
    const body = c.req.valid("json");
    const ingredientId = await inventory.registerIngredient(body);
    return c.json({ ingredientId }, 201);
  })

  .openapi(listIngredientsRoute, async (c) => {
    const stocks = await inventory.listIngredientStock();
    return c.json([...stocks], 200);
  })

  .openapi(getIngredientRoute, async (c) => {
    const { ingredientId } = c.req.valid("param");
    const stock = await inventory.getIngredientStock(ingredientId);
    if (stock === null) {
      return c.json(
        { error: "not_found", message: `原材料が見つかりません: ${ingredientId}` },
        404,
      );
    }
    return c.json(stock, 200);
  })

  .openapi(setReorderPointRoute, async (c) => {
    const { ingredientId } = c.req.valid("param");
    const { reorderPoint } = c.req.valid("json");
    await inventory.setReorderPoint({ ingredientId, reorderPoint });
    return c.body(null, 204);
  })

  .openapi(listProductLotsRoute, async (c) => {
    const lots = await inventory.listProductLots();
    return c.json([...lots], 200);
  })

  .openapi(recordStocktakeRoute, async (c) => {
    const body = c.req.valid("json");
    await inventory.recordStocktake(body);
    return c.body(null, 204);
  })

  .openapi(listAlertsRoute, async (c) => {
    const alerts = await inventory.listStockAlerts();
    return c.json([...alerts], 200);
  })

  /**
   * ドメインエラーを HTTP に写す。
   *
   * 各ハンドラで try/catch を書くと同じ対応表が散るので、1箇所に集める。
   * ドメインのエラーでないものは握り潰さずそのまま投げ、Hono の 500 に任せる。
   */
  .onError((error, c) => {
    if (isInventoryError(error)) {
      return c.json({ error: error.kind, message: error.message }, STATUS_BY_KIND[error.kind]);
    }
    throw error;
  });

/** hc の RPC クライアント用。api.ts の型に取り込まれる。 */
export type InventoryRoutes = typeof inventoryRoutes;
