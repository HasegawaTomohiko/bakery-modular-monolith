/**
 * integration プロジェクトの setupFiles。
 *
 * DB に届かない状態で走らせると、本来のテスト内容と無関係な接続エラーが
 * 大量に出て原因が分かりにくい。ここで先に確認し、実行方法を案内して落とす。
 */
import { afterAll, beforeAll } from "vitest";
import { closeDbPools } from "../../src/shared/db.ts";
import { ensureDatabaseReachable } from "./db.ts";

beforeAll(async () => {
  await ensureDatabaseReachable();
});

// プールを閉じないと vitest のワーカーが終わらない。
afterAll(async () => {
  await closeDbPools();
});
