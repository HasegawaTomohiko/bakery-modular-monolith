/**
 * スキーマ・ロールの作成と、モジュールごとのマイグレーション。
 *
 *   1. admin 接続で db/bootstrap/*.sql を順に流す (冪等)
 *   2. モジュールごとに、そのモジュールのロールで接続してマイグレーションを流す
 *
 * 2 が肝。自スキーマ外に触れるマイグレーションはここで権限エラーになって落ちる。
 * 境界を CI のレビューではなく DB の権限で守るということ。
 *
 * 適用記録は drizzle と同じ形式 (hash / created_at) で <module>.__drizzle_migrations に持つ。
 * drizzle 本体の migrator を使わないのは、あれが migrationsSchema に対して必ず
 * `CREATE SCHEMA IF NOT EXISTS` を投げるため。PostgreSQL はスキーマが既にあっても
 * データベースへの CREATE 権限を先に検査するので、モジュールのロールでは通らない。
 * 権限を緩めるのは本末転倒なので、drizzle の適用アルゴリズムだけをここに写している。
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";
import { adminDatabaseUrl, SCHEMA_OWNERS, type SchemaOwner } from "../src/shared/config.ts";
import { closeDbPools, moduleDb } from "../src/shared/db.ts";

const MIGRATIONS_TABLE = "__drizzle_migrations";

const bootstrapDir = fileURLToPath(new URL("../db/bootstrap/", import.meta.url));

function migrationsDir(owner: SchemaOwner): string {
  // 参照モデルはモジュールではないので modules/ の下に置かない。
  const path =
    owner === "readmodel"
      ? "../src/readmodel/db/migrations/"
      : `../src/modules/${owner}/infra/db/migrations/`;
  return fileURLToPath(new URL(path, import.meta.url));
}

/** admin 接続で bootstrap SQL を順に流す。中身は何度流しても同じ結果になる。 */
async function runBootstrap(): Promise<void> {
  const files = (await readdir(bootstrapDir)).filter((name) => name.endsWith(".sql")).sort();
  const client = new pg.Client({ connectionString: adminDatabaseUrl() });
  await client.connect();
  try {
    for (const file of files) {
      console.log(`[bootstrap] ${file}`);
      await client.query(await readFile(`${bootstrapDir}${file}`, "utf8"));
    }
  } finally {
    await client.end();
  }
}

/**
 * モジュールごとの排他ロック。
 *
 * 開発中は複数のエージェント/ターミナルが同時に `make migrate` を叩きうる。
 * 同じモジュールを2本が同時に適用すると同じ SQL が二重に流れるので、
 * アドバイザリロックで直列化する。モジュールごとなので、別モジュールは待たない。
 */
function lockKeyOf(module: SchemaOwner): number {
  // 安定した小さい整数であればよい。モジュール名から決める。
  let hash = 0;
  for (const char of module) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return hash;
}

/** モジュール専用ロールで接続してマイグレーションを適用する。 */
async function migrateModule(module: SchemaOwner): Promise<void> {
  const migrations = readMigrationFiles({
    migrationsFolder: migrationsDir(module),
    migrationsTable: MIGRATIONS_TABLE,
    migrationsSchema: module,
  });
  const db = moduleDb(module);
  const table = sql`${sql.identifier(module)}.${sql.identifier(MIGRATIONS_TABLE)}`;

  // セッション単位のロック。接続はプールで使い回されるので必ず解放する。
  await db.execute(sql`select pg_advisory_lock(${lockKeyOf(module)})`);
  try {
    await applyMigrations();
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${lockKeyOf(module)})`);
  }

  async function applyMigrations(): Promise<void> {
    await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ${table} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

    const last = await db.execute<{ created_at: string | null }>(
      sql`select created_at from ${table} order by created_at desc limit 1`,
    );
    const lastAppliedAt = Number(last.rows[0]?.created_at ?? 0);

    const pending = migrations.filter((migration) => migration.folderMillis > lastAppliedAt);
    if (pending.length === 0) {
      console.log(`[${module}] 適用済み (${migrations.length} 件)`);
      return;
    }

    await db.transaction(async (tx) => {
      for (const migration of pending) {
        for (const statement of migration.sql) {
          await tx.execute(sql.raw(statement));
        }
        await tx.execute(
          sql`insert into ${table} ("hash", "created_at") values (${migration.hash}, ${migration.folderMillis})`,
        );
      }
    });
    console.log(`[${module}] ${pending.length} 件適用`);
  }
}

async function main(): Promise<void> {
  await runBootstrap();
  for (const owner of SCHEMA_OWNERS) {
    await migrateModule(owner);
  }
}

try {
  await main();
} finally {
  await closeDbPools();
}
