import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { isPurchasingError, type PurchasingErrorKind } from "../domain/errors.ts";
import { purchasing } from "../index.ts";

/**
 * purchasing モジュールの HTTP ルーター。
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
  .openapi("PurchasingError");

const errorResponse = (description: string) =>
  ({
    description,
    content: { "application/json": { schema: ErrorSchema } },
  }) as const;

/**
 * ドメインエラーの種類を HTTP に写す。
 *
 *   not_found — 対象が無い
 *   conflict  — 状態が合わない (二重検収など)。再送すれば通るものではないので 409
 *   invalid   — 業務ルール違反。zod を通ったが中身が業務的に成り立たない
 */
const STATUS_BY_KIND: Record<PurchasingErrorKind, 404 | 409 | 422> = {
  not_found: 404,
  conflict: 409,
  invalid: 422,
};

const PurchaseOrderSchema = z
  .object({
    purchaseOrderId: z.uuid(),
    supplierId: z.uuid(),
    status: z.enum(["placed", "received", "accepted", "cancelled"]),
    orderedAt: z.iso.datetime({ offset: true }),
    lines: z.array(z.object({ ingredientId: z.uuid(), quantity: QuantitySchema })),
  })
  .openapi("PurchaseOrder");

const SuggestionSchema = z
  .object({
    ingredientId: z.uuid(),
    suggestedQuantity: QuantitySchema,
    onHandAtDetection: QuantitySchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .openapi("PurchaseSuggestion");

const PurchaseOrderIdParam = z.object({
  purchaseOrderId: z.uuid().openapi({ param: { name: "purchaseOrderId", in: "path" } }),
});

const GoodsReceiptIdParam = z.object({
  goodsReceiptId: z.uuid().openapi({ param: { name: "goodsReceiptId", in: "path" } }),
});

// ---------------------------------------------------------------------------
// ルート定義
// ---------------------------------------------------------------------------

const PurchasingStatusSchema = z
  .object({
    module: z.literal("purchasing"),
    status: z.literal("ok"),
  })
  .openapi("PurchasingStatus");

const statusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["purchasing"],
  summary: "purchasing モジュールの疎通確認",
  description: "仕入先、発注、入荷・検収。",
  responses: {
    200: {
      description: "モジュールが応答している",
      content: { "application/json": { schema: PurchasingStatusSchema } },
    },
  },
});

const registerSupplierRoute = createRoute({
  method: "post",
  path: "/suppliers",
  tags: ["purchasing"],
  summary: "仕入先を登録する",
  description: "リードタイムは発注提案を人が判断するときの材料になる。",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            leadTimeDays: z.number().int().min(0),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "登録した",
      content: { "application/json": { schema: z.object({ supplierId: z.uuid() }) } },
    },
    422: errorResponse("業務ルールに反する入力"),
  },
});

const placeOrderRoute = createRoute({
  method: "post",
  path: "/orders",
  tags: ["purchasing"],
  summary: "発注する",
  description:
    "発注時点ではイベントを出さない。inventory が知りたいのは実際に入ってきた量であり、" +
    "在庫が動くのは検収のときだけ。",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            supplierId: z.uuid(),
            lines: z.array(z.object({ ingredientId: z.uuid(), quantity: QuantitySchema })).min(1),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "発注した",
      content: { "application/json": { schema: z.object({ purchaseOrderId: z.uuid() }) } },
    },
    404: errorResponse("仕入先が無い"),
    422: errorResponse("業務ルールに反する入力"),
  },
});

const getOrderRoute = createRoute({
  method: "get",
  path: "/orders/{purchaseOrderId}",
  tags: ["purchasing"],
  summary: "発注を1件取得する",
  request: { params: PurchaseOrderIdParam },
  responses: {
    200: {
      description: "発注",
      content: { "application/json": { schema: PurchaseOrderSchema } },
    },
    404: errorResponse("発注が無い"),
  },
});

const receiveGoodsRoute = createRoute({
  method: "post",
  path: "/orders/{purchaseOrderId}/receipts",
  tags: ["purchasing"],
  summary: "入荷を登録する",
  description:
    "モノが届いた記録。まだ検収していないのでイベントは出ず、在庫にもならない。" +
    "数量が発注と違っていても弾かない (10kg 頼んで 9.8kg は日常)。",
  request: {
    params: PurchaseOrderIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            receivedAt: z.iso.datetime({ offset: true }),
            lines: z
              .array(
                z.object({
                  ingredientId: z.uuid(),
                  quantity: QuantitySchema,
                  lotCode: z.string().min(1),
                  bestBefore: z.iso.date(),
                }),
              )
              .min(1),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "入荷を登録した",
      content: { "application/json": { schema: z.object({ goodsReceiptId: z.uuid() }) } },
    },
    404: errorResponse("発注が無い"),
    409: errorResponse("発注の状態が入荷を受け付けられない"),
    422: errorResponse("業務ルールに反する入力"),
  },
});

const acceptReceiptRoute = createRoute({
  method: "post",
  path: "/receipts/{goodsReceiptId}/accept",
  tags: ["purchasing"],
  summary: "検収する",
  description:
    "数量と品質を確認して受け入れる。ここで初めて purchasing.GoodsReceiptAccepted が出て、" +
    "inventory が原材料を入庫する。イベントには検収した実数が載る。",
  request: { params: GoodsReceiptIdParam },
  responses: {
    204: { description: "検収した。イベントを発行済み" },
    404: errorResponse("入荷が無い"),
    409: errorResponse("既に検収済み"),
    422: errorResponse("業務ルールに反する入力"),
  },
});

const listSuggestionsRoute = createRoute({
  method: "get",
  path: "/suggestions",
  tags: ["purchasing"],
  summary: "発注提案の一覧",
  description:
    "inventory の発注点割れから作られた未対応の提案。自動発注はしない。" +
    "仕入先ごとのリードタイムと最小ロットが絡むため、確定は人の判断に残す。",
  responses: {
    200: {
      description: "未対応の提案",
      content: { "application/json": { schema: z.array(SuggestionSchema) } },
    },
  },
});

// ---------------------------------------------------------------------------
// ルーター
// ---------------------------------------------------------------------------

// strict: false — 末尾スラッシュの有無で挙動を変えない (`/purchasing` と `/purchasing/` を同じに扱う)。
export const purchasingRoutes = new OpenAPIHono({ strict: false })
  .openapi(statusRoute, (c) => c.json({ module: "purchasing", status: "ok" } as const, 200))

  .openapi(registerSupplierRoute, async (c) => {
    const body = c.req.valid("json");
    const supplierId = await purchasing.registerSupplier(body);
    return c.json({ supplierId }, 201);
  })

  .openapi(placeOrderRoute, async (c) => {
    const body = c.req.valid("json");
    const purchaseOrderId = await purchasing.placePurchaseOrder(body);
    return c.json({ purchaseOrderId }, 201);
  })

  .openapi(getOrderRoute, async (c) => {
    const { purchaseOrderId } = c.req.valid("param");
    const order = await purchasing.getPurchaseOrder(purchaseOrderId);
    if (order === null) {
      return c.json(
        { error: "not_found", message: `発注が見つかりません: ${purchaseOrderId}` },
        404,
      );
    }
    // 公開面の型は readonly。レスポンススキーマは可変配列を要求するので詰め替える。
    return c.json({ ...order, lines: order.lines.map((line) => ({ ...line })) }, 200);
  })

  .openapi(receiveGoodsRoute, async (c) => {
    const { purchaseOrderId } = c.req.valid("param");
    const body = c.req.valid("json");
    const goodsReceiptId = await purchasing.receiveGoods({ purchaseOrderId, ...body });
    return c.json({ goodsReceiptId }, 201);
  })

  .openapi(acceptReceiptRoute, async (c) => {
    const { goodsReceiptId } = c.req.valid("param");
    // 検収時刻はサーバ側で採る。クライアントに渡させると、遡って検収済みにできてしまう。
    await purchasing.acceptGoodsReceipt({ goodsReceiptId, acceptedAt: new Date().toISOString() });
    return c.body(null, 204);
  })

  .openapi(listSuggestionsRoute, async (c) => {
    const suggestions = await purchasing.listPurchaseSuggestions();
    return c.json([...suggestions], 200);
  })

  /**
   * ドメインエラーを HTTP に写す。
   *
   * 各ハンドラで try/catch を書くと同じ対応表が6箇所に散るので、1箇所に集める。
   * ドメインのエラーでないものは握り潰さずそのまま投げ、Hono の 500 に任せる。
   */
  .onError((error, c) => {
    if (isPurchasingError(error)) {
      return c.json({ error: error.kind, message: error.message }, STATUS_BY_KIND[error.kind]);
    }
    throw error;
  });

/** hc の RPC クライアント用。api.ts の型に取り込まれる。 */
export type PurchasingRoutes = typeof purchasingRoutes;
