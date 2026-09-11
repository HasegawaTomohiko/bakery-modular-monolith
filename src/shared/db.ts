/**
 * モジュール専用ロールでの DB 接続。
 *
 * 境界の強制 (2/3): モジュールは自分のロールでしか DB に触れない。
 * 他モジュールのスキーマには USAGE すら無いため、スキーマをまたぐ JOIN と外部キーは
 * 権限エラーになる。接続を1本に共有しないのはこのため。
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { moduleDatabaseUrl, type SchemaOwner } from "./config.ts";

type ModuleConnection = {
  readonly pool: pg.Pool;
  readonly db: NodePgDatabase;
};

const connections = new Map<SchemaOwner, ModuleConnection>();

function connect(module: SchemaOwner): ModuleConnection {
  const pool = new pg.Pool({ connectionString: moduleDatabaseUrl(module) });
  return { pool, db: drizzle(pool) };
}

/** そのモジュール専用ロールで繋ぐ drizzle。プールはモジュールごとに1つ。 */
export function moduleDb(module: SchemaOwner): NodePgDatabase {
  let connection = connections.get(module);
  if (connection === undefined) {
    connection = connect(module);
    connections.set(module, connection);
  }
  return connection.db;
}

/** プロセスを終わらせるときに呼ぶ。 */
export async function closeDbPools(): Promise<void> {
  const opened = [...connections.values()];
  connections.clear();
  await Promise.all(opened.map((connection) => connection.pool.end()));
}
