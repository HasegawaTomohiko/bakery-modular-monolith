import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { catalogContext } from "../application/context.ts";
import * as useCases from "../application/use-cases.ts";
import { ALLERGENS } from "../domain/allergen.ts";
import { type CatalogError, isCatalogError } from "../domain/errors.ts";

/**
 * catalog モジュールの HTTP ルーター。
 *
 * スキーマ先行: レスポンスの形を zod で先に決め、createRoute のレスポンス定義に
 * 渡すことで、OpenAPI ドキュメントとハンドラの戻り値の型が同じ1つの定義から出る。
 * ハンドラ側でスキーマとずれた JSON を返すと型エラーになる。
 *
 * 業務のルールはここに書かない。application/ のユースケースを呼ぶだけにする。
 * 同じ操作を他モジュールが index.ts 経由で呼んだときと挙動を揃えるため。
 */

// ---------------------------------------------------------------------------
// スキーマ
// ---------------------------------------------------------------------------

const AllergenSchema = z.enum(ALLERGENS).openapi("Allergen", {
  description: "特定原材料。表示義務があるので商品登録時に必須。",
});

/** 販売停止の理由。shared/events.ts の契約と同じ値。 */
const DelistReasonSchema = z
  .enum(["discontinued", "seasonal", "supply_shortage", "other"])
  .openapi("DelistReason");

const ProductIdParamSchema = z.object({
  productId: z.uuid().openapi({
    param: { name: "productId", in: "path" },
    example: "3f6b2b1e-3b8a-4a9a-9c2b-2f0f5d6a1b2c",
  }),
});

const ProductSchema = z
  .object({
    productId: z.uuid(),
    name: z.string(),
    /** 現在の定価。過去の定価は priceHistory を見る。 */
    priceJpy: z.number().int(),
    allergens: z.array(AllergenSchema),
    sellable: z.boolean(),
  })
  .openapi("Product");

const PriceRecordSchema = z
  .object({
    priceJpy: z.number().int(),
    effectiveFrom: z.iso.datetime({ offset: true }),
  })
  .openapi("PriceRecord");

/**
 * 詳細には価格履歴を付ける。
 *
 * 現在価格だけ返すと、過去の売上を照合したい画面が catalog に問い合わせても
 * 答えが得られない。履歴を持っている意味がここで初めて表に出る。
 */
const ProductDetailSchema = ProductSchema.extend({
  priceHistory: z.array(PriceRecordSchema),
}).openapi("ProductDetail");

const RegisterProductSchema = z
  .object({
    name: z.string().min(1).max(100),
    priceJpy: z.number().int().positive(),
    // optional にしない。省略を「該当なし」として通すと表示漏れになる。
    allergens: z.array(AllergenSchema),
  })
  .openapi("RegisterProductRequest");

const ChangePriceSchema = z
  .object({ priceJpy: z.number().int().positive() })
  .openapi("ChangePriceRequest");

const DelistProductSchema = z
  .object({ reason: DelistReasonSchema })
  .openapi("DelistProductRequest");

const ErrorSchema = z
  .object({
    code: z.enum(["product_not_found", "product_not_sellable", "invalid_product"]),
    message: z.string(),
  })
  .openapi("CatalogError");

const errorResponse = (description: string) =>
  ({ description, content: { "application/json": { schema: ErrorSchema } } }) as const;

// ---------------------------------------------------------------------------
// ルート定義
// ---------------------------------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["catalog"],
  summary: "販売中の商品一覧",
  description: "販売停止した商品は含まない。停止済みを引くときは商品 ID を指定する。",
  responses: {
    200: {
      description: "販売可の商品",
      content: { "application/json": { schema: z.object({ products: z.array(ProductSchema) }) } },
    },
  },
});

const registerRoute = createRoute({
  method: "post",
  path: "/products",
  tags: ["catalog"],
  summary: "商品を登録する",
  request: {
    body: { content: { "application/json": { schema: RegisterProductSchema } }, required: true },
  },
  responses: {
    201: {
      description: "登録した",
      content: { "application/json": { schema: z.object({ productId: z.uuid() }) } },
    },
    400: errorResponse("入力が商品として成り立たない"),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/products/{productId}",
  tags: ["catalog"],
  summary: "商品を1件取得する",
  description:
    "販売停止した商品も返す。他モジュールが過去の売上・製造実績から参照している " +
    "商品 ID を解決できる必要があるため。販売可かどうかは sellable で判断する。",
  request: { params: ProductIdParamSchema },
  responses: {
    200: {
      description: "商品 (販売停止済みを含む)",
      content: { "application/json": { schema: ProductDetailSchema } },
    },
    404: errorResponse("商品が存在しない"),
  },
});

const changePriceRoute = createRoute({
  method: "patch",
  path: "/products/{productId}/price",
  tags: ["catalog"],
  summary: "価格を改定する",
  description: "上書きではなく履歴への追記。過去の定価は残る。",
  request: {
    params: ProductIdParamSchema,
    body: { content: { "application/json": { schema: ChangePriceSchema } }, required: true },
  },
  responses: {
    200: {
      description: "改定後の商品",
      content: { "application/json": { schema: ProductSchema } },
    },
    400: errorResponse("価格が不正"),
    404: errorResponse("商品が存在しない"),
    409: errorResponse("販売停止済みの商品は改定できない"),
  },
});

const delistRoute = createRoute({
  method: "post",
  path: "/products/{productId}/delist",
  tags: ["catalog"],
  summary: "販売を停止する",
  description:
    "商品は削除せず sellable = false にする。`catalog.ProductDelisted` を " +
    "業務データの更新と同じトランザクションで outbox に積む。",
  request: {
    params: ProductIdParamSchema,
    body: { content: { "application/json": { schema: DelistProductSchema } }, required: true },
  },
  responses: {
    200: {
      description: "停止後の商品",
      content: { "application/json": { schema: ProductSchema } },
    },
    404: errorResponse("商品が存在しない"),
    409: errorResponse("既に販売停止済み"),
  },
});

// ---------------------------------------------------------------------------
// ハンドラ
// ---------------------------------------------------------------------------

/** ドメインエラーの意味を HTTP のステータスに対応付ける。逆向きの依存を作らないため。 */
const STATUS_BY_CODE = {
  product_not_found: 404,
  product_not_sellable: 409,
  invalid_product: 400,
} as const;

type ErrorBody = z.infer<typeof ErrorSchema>;

function errorBody(error: CatalogError): ErrorBody {
  return { code: error.code, message: error.message };
}

/**
 * 販売停止済みの商品を取り出せなかったときのための、起こり得ない事象。
 * 直前に同じトランザクションで書いた行を読み直しているので、
 * ここに落ちるのは catalog 内部の不整合。
 */
function missingAfterWrite(productId: string): never {
  throw new Error(`catalog: 書き込み直後の商品 ${productId} を読み出せませんでした`);
}

// strict: false — 末尾スラッシュの有無で挙動を変えない (`/catalog` と `/catalog/` を同じに扱う)。
export const catalogRoutes = new OpenAPIHono({ strict: false })
  .openapi(listRoute, async (c) => {
    const products = await useCases.listSellableProducts(catalogContext());
    return c.json(
      { products: products.map((product) => ({ ...product, allergens: [...product.allergens] })) },
      200,
    );
  })
  .openapi(registerRoute, async (c) => {
    const body = c.req.valid("json");
    try {
      const productId = await useCases.registerProduct(catalogContext(), body);
      return c.json({ productId }, 201);
    } catch (error) {
      if (isCatalogError(error) && error.code === "invalid_product") {
        return c.json(errorBody(error), 400);
      }
      throw error;
    }
  })
  .openapi(getRoute, async (c) => {
    const { productId } = c.req.valid("param");
    const found = await useCases.getProductWithPrices(catalogContext(), productId);
    if (found === null) {
      return c.json(
        { code: "product_not_found", message: `商品 ${productId} は存在しません` } as const,
        404,
      );
    }
    return c.json(
      {
        ...found.view,
        allergens: [...found.view.allergens],
        priceHistory: found.prices.map((price) => ({
          priceJpy: price.priceJpy,
          effectiveFrom: price.effectiveFrom.toISOString(),
        })),
      },
      200,
    );
  })
  .openapi(changePriceRoute, async (c) => {
    const { productId } = c.req.valid("param");
    const { priceJpy } = c.req.valid("json");
    try {
      await useCases.changePrice(catalogContext(), { productId, priceJpy });
    } catch (error) {
      if (isCatalogError(error)) {
        return c.json(errorBody(error), STATUS_BY_CODE[error.code]);
      }
      throw error;
    }
    const updated = await useCases.getProduct(catalogContext(), productId);
    if (updated === null) missingAfterWrite(productId);
    return c.json({ ...updated, allergens: [...updated.allergens] }, 200);
  })
  .openapi(delistRoute, async (c) => {
    const { productId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    try {
      await useCases.delistProduct(catalogContext(), { productId, reason });
    } catch (error) {
      // 販売停止に入力の検証は無いので invalid_product は出ない。
      // 出たら catalog の想定外なので握らずに 500 にする。
      if (isCatalogError(error) && error.code !== "invalid_product") {
        return c.json(errorBody(error), STATUS_BY_CODE[error.code]);
      }
      throw error;
    }
    const updated = await useCases.getProduct(catalogContext(), productId);
    if (updated === null) missingAfterWrite(productId);
    return c.json({ ...updated, allergens: [...updated.allergens] }, 200);
  });

/** hc の RPC クライアント用。api.ts の型に取り込まれる。 */
export type CatalogRoutes = typeof catalogRoutes;
