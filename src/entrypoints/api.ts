import { serve } from "@hono/node-server";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { catalogRoutes } from "../modules/catalog/http/routes.ts";
import { inventoryRoutes } from "../modules/inventory/http/routes.ts";
import { productionRoutes } from "../modules/production/http/routes.ts";
import { purchasingRoutes } from "../modules/purchasing/http/routes.ts";
import { salesRoutes } from "../modules/sales/http/routes.ts";
import { readmodelRoutes } from "../readmodel/http/routes.ts";

/**
 * api エントリポイント。
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
const app = new OpenAPIHono({ strict: false })
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
// 必要になったら shared/config.ts のベース URL から与える。
app.doc("/doc", {
  openapi: "3.1.0",
  info: {
    title: "bakery API",
    version: "0.0.0",
    description: "パン屋アプリのモジュラーモノリス API。",
  },
});

/** hc の RPC クライアント用。Phase 5 のフロントエンドがこの型を import する。 */
export type AppType = typeof app;

export default app;

// PORT は compose の環境変数で与える (api は 3000)。
// TODO(Phase 2): shared/config.ts が入ったらそちら経由で読む。
const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on port ${info.port}`);
});

const shutdown = (signal: NodeJS.Signals): void => {
  console.log(`api received ${signal}, shutting down`);
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
