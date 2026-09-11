/**
 * drizzle-kit の設定。参照モデル用。
 *
 * schemaFilter で readmodel 以外を対象外にし、接続も専用ロールにしておく。
 * 生成された 0000 に CREATE SCHEMA が入っていたら消すこと。スキーマとロールを
 * 作るのは db/bootstrap の admin 接続の仕事で、このロールにはその権限が無い。
 * パスは cwd (リポジトリルート) 起点。
 */
import { defineConfig } from "drizzle-kit";
import { moduleDatabaseUrl } from "../../shared/config.ts";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/readmodel/db/schema.ts",
  out: "./src/readmodel/db/migrations",
  schemaFilter: ["readmodel"],
  dbCredentials: { url: moduleDatabaseUrl("readmodel") },
});
