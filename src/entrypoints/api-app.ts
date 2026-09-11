import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { catalogRoutes } from "../modules/catalog/http/routes.ts";
import { inventoryRoutes } from "../modules/inventory/http/routes.ts";
import { productionRoutes } from "../modules/production/http/routes.ts";
import { purchasingRoutes } from "../modules/purchasing/http/routes.ts";
import { salesRoutes } from "../modules/sales/http/routes.ts";
import { readmodelRoutes } from "../readmodel/http/routes.ts";
import { allowedWebOrigins } from "../shared/config.ts";

/**
 * api の Hono アプリ本体。
 *
 * listen はここでしない。テストから副作用なしに import できるようにするため
 * (`app.request()` でルートやミドルウェアを直接叩ける)。
 * プロセスとして起動するのは api.ts。
 *
 * モジュラーモノリスの HTTP 面。全モジュールのルーターを1つの Hono アプリに束ねる。
 * 依存の向きは entrypoints → modules の一方向で、モジュールはここを知らない。
 * 各モジュールへは公開面 (index.ts と http/routes.ts) 経由でのみ触れる。
 */

const HealthSchema = z
  .object({
    status: z.literal("ok"),
  })
  .openapi("Health");

/** DB には触らない。プロセスが HTTP を受けられることだけを表す。 */
const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["system"],
  summary: "プロセスの生存確認",
  description: "依存 (DB 等) の状態は見ない。コンテナのヘルスチェック用。",
  responses: {
    200: {
      description: "プロセスが応答している",
      content: { "application/json": { schema: HealthSchema } },
    },
  },
});

// strict: false — 末尾スラッシュの有無で 404 を出さない。ルーティングは束ねた側の
// 設定で決まるため、ここで指定する必要がある。
const base = new OpenAPIHono({ strict: false });

// フロントエンドと API はホスト名が違うため、ブラウザから見ると cross-origin。
// 許可するオリジンは env から受け取る (WEB_ORIGINS)。ここにホスト名を書くと、
// アプリケーションがローカルの入口の形に依存してしまう。
// 未設定なら許可リストは空になり、ブラウザからの cross-origin 呼び出しは通らない。
//
// チェーンの途中に挟まないのは、`use` の戻り値が素の Hono になって
// OpenAPIHono の型 (= hc の RPC 型) が落ちるため。
base.use(
  "*",
  cors({
    origin: [...allowedWebOrigins()],
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 600,
  }),
);

const app = base
  .openapi(healthRoute, (c) => c.json({ status: "ok" } as const, 200))
  .route("/catalog", catalogRoutes)
  .route("/production", productionRoutes)
  .route("/inventory", inventoryRoutes)
  .route("/purchasing", purchasingRoutes)
  .route("/sales", salesRoutes)
  // 参照モデル。モジュールではないので /dashboard という画面寄りの名前にする。
  // コンテキストをまたぐ画面は JOIN ではなくイベントからの投影で作る。
  .route("/dashboard", readmodelRoutes);

// OpenAPI ドキュメント。servers は書かない。ベース URL は環境ごとに違い、
// edge (Traefik) 固有のホスト名をコードに持ち込まないため。
app.doc("/doc", {
  openapi: "3.1.0",
  info: {
    title: "bakery API",
    version: "0.0.0",
    description: "パン屋アプリのモジュラーモノリス API。",
  },
});

/** hc の RPC クライアント用。フロントエンドがこの型を import する。 */
export type AppType = typeof app;

export default app;
