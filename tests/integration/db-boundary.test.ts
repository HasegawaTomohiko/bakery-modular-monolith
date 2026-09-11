/**
 * 境界の強制 (2/3): DB — 回帰テスト。
 *
 * 規約本文: docs/conventions/module-boundaries.md
 *
 * `db/bootstrap/001_schemas_and_roles.sql` が作るスキーマとロールの権限が、
 * 意図どおり「自スキーマだけ」に閉じていることを固定する。
 *
 * `pnpm check:migrations` は SQL の静的検査なので、書かれた SQL しか見られない。
 * こちらは実際に PostgreSQL に投げて、**権限が本当に効いているか**を確かめる。
 * bootstrap SQL を書き換えて境界が緩んだら、このテストが落ちる。
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { moduleDb } from "../../src/shared/db.ts";
import { listModuleTables, truncateModule, withCleanDb } from "../helpers/db.ts";

/** 権限エラーの SQLSTATE。PostgreSQL の insufficient_privilege。 */
const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * 投げられたエラーから SQLSTATE とメッセージを取り出す。
 *
 * drizzle は pg の DatabaseError を DrizzleQueryError で包み、元のエラーを `cause` に入れる。
 * SQLSTATE を持っているのは内側なので、cause を辿って探す。
 */
function pgErrorOf(error: unknown): { code: string | undefined; message: string } {
  if (!(error instanceof Error)) {
    throw new Error(`Error ではない値が投げられました: ${String(error)}`);
  }

  const messages: string[] = [];
  let current: Error | undefined = error;
  let code: string | undefined;
  while (current !== undefined) {
    messages.push(current.message);
    if (code === undefined && "code" in current && typeof current.code === "string") {
      code = current.code;
    }
    current = current.cause instanceof Error ? current.cause : undefined;
  }

  return { code, message: messages.join("\n") };
}

/** クエリが権限エラーで失敗することを確かめる。成功したら境界が壊れている。 */
async function expectPermissionDenied(
  run: () => Promise<unknown>,
  deniedSchema: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }

  expect(
    thrown,
    `境界が壊れています: 他モジュールのスキーマ ${deniedSchema} に触れる SQL が成功しました`,
  ).toBeDefined();

  const { code, message } = pgErrorOf(thrown);
  expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  expect(message).toContain(`permission denied for schema ${deniedSchema}`);
}

describe("境界の強制 (2/3): DB のロール権限", () => {
  withCleanDb(["catalog"]);

  it("自スキーマは読める", async () => {
    const result = await moduleDb("catalog").execute<{ count: string }>(
      sql`select count(*)::text as count from catalog.outbox`,
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("自スキーマには書ける", async () => {
    const db = moduleDb("catalog");
    await db.execute(sql`
      insert into catalog.outbox (event_name, payload)
      values ('test.boundary', ${JSON.stringify({ probe: true })}::jsonb)
    `);

    const after = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from catalog.outbox`,
    );
    expect(after.rows[0]?.count).toBe("1");
  });

  it("他モジュールのスキーマは読めない", async () => {
    await expectPermissionDenied(
      () => moduleDb("catalog").execute(sql`select count(*) from production.outbox`),
      "production",
    );
  });

  it("スキーマをまたぐ JOIN は書けない", async () => {
    await expectPermissionDenied(
      () =>
        moduleDb("catalog").execute(sql`
          select count(*)
            from catalog.outbox as c
            join production.outbox as p on c.id = p.id
        `),
      "production",
    );
  });

  it("他スキーマへの外部キーは張れない", async () => {
    await expectPermissionDenied(
      () =>
        moduleDb("catalog").execute(sql`
          create table catalog.fk_boundary_probe (
            id uuid primary key,
            outbox_id uuid references production.outbox (id)
          )
        `),
      "production",
    );

    // 失敗した CREATE TABLE は何も残さないはずだが、境界が壊れたときに
    // 次のテストへ影響しないよう念のため落としておく。
    await moduleDb("catalog").execute(sql`drop table if exists catalog.fk_boundary_probe`);
  });

  it("逆向きも同じ (production から catalog は見えない)", async () => {
    await expectPermissionDenied(
      () => moduleDb("production").execute(sql`select count(*) from catalog.outbox`),
      "catalog",
    );
  });
});

describe("テストヘルパー", () => {
  it("information_schema には自スキーマのテーブルしか出てこない", async () => {
    // 権限の無いテーブルは information_schema からも見えない。
    // truncateModule がこれに依存しているので、前提として固定しておく。
    const tables = await listModuleTables("catalog");
    expect(tables).toContain("outbox");
    expect(tables).not.toContain("__drizzle_migrations");
  });

  it("truncateModule は自スキーマを空にする", async () => {
    const db = moduleDb("catalog");
    await db.execute(sql`
      insert into catalog.outbox (event_name, payload) values ('test.truncate', '{}'::jsonb)
    `);

    await truncateModule("catalog");

    const after = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from catalog.outbox`,
    );
    expect(after.rows[0]?.count).toBe("0");
  });

  it("truncateModule はマイグレーション履歴を消さない", async () => {
    await truncateModule("catalog");

    const result = await moduleDb("catalog").execute<{ count: string }>(
      sql`select count(*)::text as count from catalog.__drizzle_migrations`,
    );
    expect(Number(result.rows[0]?.count)).toBeGreaterThan(0);
  });
});
