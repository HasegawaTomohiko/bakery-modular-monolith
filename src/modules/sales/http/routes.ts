import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { cancelReservation } from "../application/cancel-reservation.ts";
import { salesContext } from "../application/context.ts";
import { fulfillReservation } from "../application/fulfill-reservation.ts";
import { placeReservation } from "../application/place-reservation.ts";
import { getDailySales, listReservations } from "../application/queries.ts";
import { recordSale } from "../application/record-sale.ts";
import { SalesError, type SalesErrorCode } from "../domain/errors.ts";

/**
 * sales モジュールの HTTP ルーター。
 *
 * スキーマ先行: レスポンスの形を zod で先に決め、createRoute のレスポンス定義に
 * 渡すことで、OpenAPI ドキュメントとハンドラの戻り値の型が同じ1つの定義から出る。
 * ハンドラ側でスキーマとずれた JSON を返すと型エラーになる。
 *
 * ここは入口の変換だけを持つ。業務のルールは application/ と domain/ にあり、
 * HTTP のステータスコードへの対応付け (ドメインエラー → 404/409/422) だけがこの層の仕事。
 */

// ---------------------------------------------------------------------------
// スキーマ
// ---------------------------------------------------------------------------

/**
 * 数量。契約 (shared/events.ts) と同じ形にしておき、単位が piece でないことは
 * ドメインが弾く。HTTP で先に狭めてしまうと、契約とズレたときに気づけない。
 */
const QuantitySchema = z
  .object({
    amount: z.number().finite().openapi({ example: 2 }),
    unit: z.enum(["g", "ml", "piece"]).openapi({ example: "piece" }),
  })
  .openapi("Quantity");

const SaleLineSchema = z
  .object({
    productId: z.uuid(),
    /** inventory のロット識別子。sales は残数を知らない。 */
    lotCode: z.string().min(1).openapi({ example: "CRO-20260911-01" }),
    quantity: QuantitySchema,
  })
  .openapi("SaleLineInput");

const RecordSaleSchema = z
  .object({
    soldAt: z.iso.datetime({ offset: true }).openapi({ example: "2026-09-11T07:42:00+09:00" }),
    lines: z.array(SaleLineSchema).min(1),
  })
  .openapi("RecordSaleInput");

const SaleCreatedSchema = z.object({ saleId: z.uuid() }).openapi("SaleCreated");

const DailySalesSchema = z
  .object({
    businessDate: z.iso.date(),
    totalJpy: z.number().int(),
    byProduct: z.array(
      z.object({
        productId: z.uuid(),
        soldQuantity: QuantitySchema,
        subtotalJpy: z.number().int(),
      }),
    ),
  })
  .openapi("DailySales");

const PlaceReservationSchema = z
  .object({
    customerName: z.string().min(1).openapi({ example: "山田" }),
    pickupDate: z.iso.date().openapi({ example: "2026-09-12" }),
    lines: z.array(z.object({ productId: z.uuid(), quantity: QuantitySchema })).min(1),
  })
  .openapi("PlaceReservationInput");

const ReservationCreatedSchema = z
  .object({ reservationId: z.uuid() })
  .openapi("ReservationCreated");

const ReservationSchema = z
  .object({
    reservationId: z.uuid(),
    customerName: z.string(),
    pickupDate: z.iso.date(),
    status: z.enum(["placed", "fulfilled", "cancelled"]),
  })
  .openapi("Reservation");

const ReservationListSchema = z
  .object({ reservations: z.array(ReservationSchema) })
  .openapi("ReservationList");

const FulfillReservationSchema = z
  .object({
    fulfilledAt: z.iso.datetime({ offset: true }),
    /** ロットは引き渡しの瞬間に決まるので、ここで初めて指定する。 */
    lines: z.array(SaleLineSchema).min(1),
  })
  .openapi("FulfillReservationInput");

const CancelledSchema = z
  .object({ reservationId: z.uuid(), status: z.literal("cancelled") })
  .openapi("ReservationCancelled");

const ErrorSchema = z.object({ code: z.string(), message: z.string() }).openapi("SalesError");

const errorContent = { "application/json": { schema: ErrorSchema } };

/** 全ルートで同じエラーの形を返す。呼び出し側が分岐を1つ覚えれば済むようにするため。 */
const commonErrors = {
  400: { description: "リクエストの形が不正", content: errorContent },
  404: { description: "商品または予約が見つからない", content: errorContent },
  409: { description: "販売停止中、または予約の状態が合わない", content: errorContent },
  422: { description: "業務上受け付けられない入力", content: errorContent },
};

// ---------------------------------------------------------------------------
// エラーの対応付け
// ---------------------------------------------------------------------------

/**
 * ドメインエラー → HTTP ステータス。
 * ドメインは HTTP を知らないので、対応付けはこの層だけが持つ。
 */
function statusOf(code: SalesErrorCode): 404 | 409 | 422 {
  switch (code) {
    case "product_not_found":
    case "reservation_not_found":
      return 404;
    case "product_not_sellable":
    case "reservation_not_placed":
    case "fulfillment_mismatch":
      // 状態の衝突。入力の形は正しいので 422 ではなく 409。
      return 409;
    case "invalid_input":
      return 422;
  }
}

type Failure = {
  readonly status: 404 | 409 | 422;
  readonly body: { readonly code: string; readonly message: string };
};

/** 想定外の例外はそのまま投げ直す (500 になる)。握り潰すと原因が消えるため。 */
function toFailure(error: unknown): Failure {
  if (error instanceof SalesError) {
    return { status: statusOf(error.code), body: { code: error.code, message: error.message } };
  }
  throw error;
}

// ---------------------------------------------------------------------------
// ルート
// ---------------------------------------------------------------------------

const statusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["sales"],
  summary: "sales モジュールの疎通確認",
  description: "店頭販売、予約注文、売上。",
  responses: {
    200: {
      description: "モジュールが応答している",
      content: {
        "application/json": {
          schema: z
            .object({ module: z.literal("sales"), status: z.literal("ok") })
            .openapi("SalesStatus"),
        },
      },
    },
  },
});

const recordSaleRoute = createRoute({
  method: "post",
  path: "/sales",
  tags: ["sales"],
  summary: "店頭販売を記録する",
  description:
    "単価は販売時点の catalog の価格を焼き付ける。どのロットを売ったかは sales.SaleCompleted で inventory に伝え、出庫は inventory が行う。",
  request: { body: { content: { "application/json": { schema: RecordSaleSchema } } } },
  responses: {
    201: {
      description: "販売を記録した",
      content: { "application/json": { schema: SaleCreatedSchema } },
    },
    ...commonErrors,
  },
});

const dailySalesRoute = createRoute({
  method: "get",
  path: "/daily/{businessDate}",
  tags: ["sales"],
  summary: "1 日分の売上",
  description: "「1 日」は JST の暦日 (domain/business-date.ts)。引き渡していない予約は含まない。",
  request: { params: z.object({ businessDate: z.iso.date().openapi({ example: "2026-09-11" }) }) },
  responses: {
    200: { description: "日次売上", content: { "application/json": { schema: DailySalesSchema } } },
    ...commonErrors,
  },
});

const placeReservationRoute = createRoute({
  method: "post",
  path: "/reservations",
  tags: ["sales"],
  summary: "予約を受け付ける",
  description: "受付は売上にならない。売上が立つのは引き渡し時。",
  request: { body: { content: { "application/json": { schema: PlaceReservationSchema } } } },
  responses: {
    201: {
      description: "予約を受け付けた",
      content: { "application/json": { schema: ReservationCreatedSchema } },
    },
    ...commonErrors,
  },
});

const listReservationsRoute = createRoute({
  method: "get",
  path: "/reservations",
  tags: ["sales"],
  summary: "受渡日の予約一覧",
  request: { query: z.object({ pickupDate: z.iso.date().openapi({ example: "2026-09-12" }) }) },
  responses: {
    200: {
      description: "予約一覧 (キャンセル済みも含む)",
      content: { "application/json": { schema: ReservationListSchema } },
    },
    ...commonErrors,
  },
});

const fulfillReservationRoute = createRoute({
  method: "post",
  path: "/reservations/{reservationId}/fulfill",
  tags: ["sales"],
  summary: "予約を引き渡す",
  description: "ここで販売が確定し、sales.SaleCompleted を発行する。",
  request: {
    params: z.object({ reservationId: z.uuid() }),
    body: { content: { "application/json": { schema: FulfillReservationSchema } } },
  },
  responses: {
    201: {
      description: "引き渡して販売を記録した",
      content: { "application/json": { schema: SaleCreatedSchema } },
    },
    ...commonErrors,
  },
});

const cancelReservationRoute = createRoute({
  method: "post",
  path: "/reservations/{reservationId}/cancel",
  tags: ["sales"],
  summary: "予約をキャンセルする",
  description: "受付済みの予約のみ。受付を売上にしていないので、取り消す売上はない。",
  request: { params: z.object({ reservationId: z.uuid() }) },
  responses: {
    200: {
      description: "キャンセルした",
      content: { "application/json": { schema: CancelledSchema } },
    },
    ...commonErrors,
  },
});

// strict: false — 末尾スラッシュの有無で挙動を変えない (`/sales` と `/sales/` を同じに扱う)。
// defaultHook — zod の検証エラーを他のエラーと同じ形 (code/message) で返す。
export const salesRoutes = new OpenAPIHono({
  strict: false,
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ code: "bad_request", message: z.prettifyError(result.error) }, 400);
    }
  },
})
  .openapi(statusRoute, (c) => c.json({ module: "sales", status: "ok" } as const, 200))

  .openapi(recordSaleRoute, async (c) => {
    try {
      const saleId = await recordSale(salesContext(), c.req.valid("json"));
      return c.json({ saleId }, 201);
    } catch (error) {
      const failure = toFailure(error);
      return c.json(failure.body, failure.status);
    }
  })

  .openapi(dailySalesRoute, async (c) => {
    try {
      const daily = await getDailySales(salesContext(), c.req.valid("param").businessDate);
      // readonly な公開ビューを JSON の形 (可変配列) に均す。
      return c.json({ ...daily, byProduct: [...daily.byProduct] }, 200);
    } catch (error) {
      const failure = toFailure(error);
      return c.json(failure.body, failure.status);
    }
  })

  .openapi(placeReservationRoute, async (c) => {
    try {
      const reservationId = await placeReservation(salesContext(), c.req.valid("json"));
      return c.json({ reservationId }, 201);
    } catch (error) {
      const failure = toFailure(error);
      return c.json(failure.body, failure.status);
    }
  })

  .openapi(listReservationsRoute, async (c) => {
    try {
      const found = await listReservations(salesContext(), c.req.valid("query").pickupDate);
      return c.json({ reservations: [...found] }, 200);
    } catch (error) {
      const failure = toFailure(error);
      return c.json(failure.body, failure.status);
    }
  })

  .openapi(fulfillReservationRoute, async (c) => {
    try {
      const saleId = await fulfillReservation(salesContext(), {
        reservationId: c.req.valid("param").reservationId,
        ...c.req.valid("json"),
      });
      return c.json({ saleId }, 201);
    } catch (error) {
      const failure = toFailure(error);
      return c.json(failure.body, failure.status);
    }
  })

  .openapi(cancelReservationRoute, async (c) => {
    const { reservationId } = c.req.valid("param");
    try {
      await cancelReservation(salesContext(), reservationId);
      return c.json({ reservationId, status: "cancelled" } as const, 200);
    } catch (error) {
      const failure = toFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

/** hc の RPC クライアント用。api.ts の型に取り込まれる。 */
export type SalesRoutes = typeof salesRoutes;
