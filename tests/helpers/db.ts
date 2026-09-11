/**
 * 統合テスト用の DB ヘルパー。
 *
 * 重要な前提: 後片付けも**そのモジュールのロールで**行う。
 * admin ロールで全部まとめて TRUNCATE すれば楽だが、それをやると
 * 「モジュールは自スキーマにしか触れない」(境界の強制 2/3) がテストの中だけ
 * 破られることになる。他モジュールのテーブルに触れないのが正しい挙動なので、
 * ヘルパーもその制約の中で書く。
 *
 * テーブル一覧は information_schema から動的に引く。Phase 4b で業務テーブルが
 * 増えてもヘルパーを直さなくてよいようにするため。
 */
import { sql } from "drizzle-orm";
import { beforeEach } from "vitest";
import { MODULES, type ModuleName, moduleDatabaseUrl } from "../../src/shared/config.ts";
import { moduleDb } from "../../src/shared/db.ts";

/** drizzle が自分で管理する。テストで消してはいけない。 */
const MIGRATIONS_TABLE = "__drizzle_migrations";

const HOW_TO_RUN = [
  "統合テストは DB に届くコンテナの中で実行してください:",
  "",
  "    make test-integration",
  "",
  "  (中身: docker compose run --rm --no-deps api pnpm test:integration)",
  "",
  "postgres は internal ネットワークにのみ居て ports を開けていないため、",
  "ホストからは届きません (docs/conventions/local-environment.md)。",
  "DB がまだ起動していない場合は `make up` と `make migrate` を先に実行してください。",
].join("\n");

function fail(cause: string): never {
  throw new Error(`統合テストの DB に接続できませんでした。\n\n原因: ${cause}\n\n${HOW_TO_RUN}`);
}

/**
 * エラーの内容を1行にする。
 *
 * drizzle は pg のエラーを DrizzleQueryError で包むので、外側だけ見ると
 * "Failed query: select 1" としか出ず、本当の原因 (ENOTFOUND 等) が見えない。
 * cause を辿って全部つなげる。
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts: string[] = [];
  let current: Error | undefined = error;
  while (current !== undefined) {
    parts.push(current.message.replace(/\s+/g, " ").trim());
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return parts.join(" / ");
}

let reachable: Promise<void> | undefined;

/**
 * DB に届くことを確認する。届かなければ実行方法を案内して落とす。
 * 1プロセスにつき1回だけ実行する。
 */
export function ensureDatabaseReachable(): Promise<void> {
  reachable ??= (async () => {
    // 1. 接続情報が env にあるか (= コンテナの中で走っているか)
    for (const module of MODULES) {
      try {
        moduleDatabaseUrl(module);
      } catch (error) {
        fail(
          `${describeError(error)}\n      ` +
            "接続情報は compose.yaml が env で渡します。ホストで直接実行していませんか?",
        );
      }
    }

    // 2. 実際に繋がるか
    for (const module of MODULES) {
      try {
        await moduleDb(module).execute(sql`select 1`);
      } catch (error) {
        fail(`${module} ロールで接続できません: ${describeError(error)}`);
      }
    }

    // 3. マイグレーションが流れているか
    for (const module of MODULES) {
      const tables = await listModuleTables(module);
      if (tables.length === 0) {
        fail(
          `${module} スキーマにテーブルがありません。` +
            "`make migrate` でマイグレーションを流してください。",
        );
      }
    }
  })();
  return reachable;
}

/**
 * そのモジュールのスキーマにある業務テーブルの一覧。
 *
 * information_schema はロールに権限があるものしか返さないので、
 * 自分のロールで引く限り他モジュールのテーブルは出てこない。
 */
export async function listModuleTables(module: ModuleName): Promise<string[]> {
  const result = await moduleDb(module).execute<{ table_name: string }>(sql`
    select table_name
      from information_schema.tables
     where table_schema = ${module}
       and table_type = 'BASE TABLE'
       and table_name <> ${MIGRATIONS_TABLE}
     order by table_name
  `);
  return result.rows.map((row) => row.table_name);
}

/** そのモジュールのスキーマ内の全テーブルを空にする。他モジュールには触れない。 */
export async function truncateModule(module: ModuleName): Promise<void> {
  const tables = await listModuleTables(module);
  if (tables.length === 0) return;

  const targets = sql.join(
    tables.map((table) => sql`${sql.identifier(module)}.${sql.identifier(table)}`),
    sql`, `,
  );
  // CASCADE はスキーマ内の外部キー用 (Phase 4b)。スキーマをまたぐ外部キーは
  // そもそも作れないので、CASCADE が境界の外に波及することはない。
  await moduleDb(module).execute(sql`truncate table ${targets} restart identity cascade`);
}

/** 全モジュール分。モジュールごとに、そのモジュールのロールで実行される。 */
export async function truncateAll(): Promise<void> {
  for (const module of MODULES) {
    await truncateModule(module);
  }
}

/**
 * 各テストの前に DB を空にする。テストファイルの先頭で1回呼ぶ。
 *
 *   describe("...", () => {
 *     withCleanDb();
 *     it("...", async () => { ... });
 *   });
 *
 * 触るモジュールが分かっているなら渡した方が速い: `withCleanDb(["catalog"])`
 */
export function withCleanDb(modules: readonly ModuleName[] = MODULES): void {
  beforeEach(async () => {
    for (const module of modules) {
      await truncateModule(module);
    }
  });
}
