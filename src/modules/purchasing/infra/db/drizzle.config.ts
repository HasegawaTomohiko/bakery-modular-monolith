/**
 * drizzle-kit の設定。モジュールごとに1つ。
 *
 * schemaFilter で purchasing 以外を対象外にし、接続もモジュール専用ロールにしておく。
 * 生成物 (migrations) はモジュールの中に置き、他モジュールから見えないようにする。
 * 生成された 0000 には CREATE SCHEMA が入るので消すこと。スキーマとロールを作るのは
 * db/bootstrap の admin 接続の仕事で、モジュールのロールにはその権限が無い。
 * パスは cwd (リポジトリルート) 起点。
 */
import { defineConfig } from "drizzle-kit";
import { moduleDatabaseUrl } from "../../../../shared/config.ts";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/modules/purchasing/infra/db/schema.ts",
  out: "./src/modules/purchasing/infra/db/migrations",
  schemaFilter: ["purchasing"],
  dbCredentials: { url: moduleDatabaseUrl("purchasing") },
});
