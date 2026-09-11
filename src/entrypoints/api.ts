import { serve } from "@hono/node-server";
import app from "./api-app.ts";

/**
 * api エントリポイント。
 *
 * アプリ本体は api-app.ts。ここは listen と graceful shutdown だけを持つ。
 * 分けてあるのは、テストが副作用なしにアプリを import できるようにするため。
 */

/** hc の RPC クライアント用。フロントエンドはここから型を取る。 */
export type { AppType } from "./api-app.ts";

// PORT は compose の環境変数で与える (api は 3000)。
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
