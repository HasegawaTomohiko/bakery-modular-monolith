/**
 * 境界の強制 (2/3): DB — 静的検査。
 *
 * 規約本文: docs/conventions/module-boundaries.md
 *
 * 実行時は DB ロールが自スキーマ以外を拒否するが、それはマイグレーションを流して初めて分かる。
 * ここでは `src/modules/<m>/infra/db/migrations/**\/*.sql` と
 * `src/readmodel/db/migrations/**\/*.sql` を読んで、実行前に落とす。
 *
 * 検査するもの:
 *   1. 他モジュールのスキーマ名を `<schema>.` の形で参照していないこと
 *   2. スキーマ/ロールそのものを操作していないこと (db/bootstrap/ の admin 用 SQL の責務)
 *
 * SQL コメントと文字列リテラルは検査対象から外す (誤検出を防ぐため)。違反があれば exit 1。
 */
import { existsSync, globSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** モジュール = スキーマ。docs/conventions/module-boundaries.md の一覧と一致させること。 */
const MODULES = ["catalog", "production", "inventory", "purchasing", "sales"] as const;

/**
 * 参照モデルはモジュールではないが、自分のスキーマとロールを持つので同じ検査にかける。
 * 「自分のスキーマ以外に触れない」という条件は readmodel にも等しく効く。
 */
const READMODEL = "readmodel";

/** スキーマの持ち主と、そのマイグレーションの置き場。 */
const TARGET_DIRS: readonly { owner: string; dir: string }[] = [
  ...MODULES.map((moduleName) => ({
    owner: moduleName,
    dir: join("src", "modules", moduleName, "infra", "db", "migrations"),
  })),
  { owner: READMODEL, dir: join("src", "readmodel", "db", "migrations") },
];

/** 自分以外のスキーマ名。ここに出てきたら境界違反。 */
function foreignSchemasOf(owner: string): string[] {
  return [...MODULES, READMODEL].filter((name) => name !== owner);
}

/** マイグレーションでは書けない、スキーマ/ロールそのものへの操作。 */
const FORBIDDEN_STATEMENTS: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  {
    pattern: /\bCREATE\s+SCHEMA\b/gi,
    reason: "スキーマの作成は db/bootstrap/ の admin 用 SQL の責務です。",
  },
  {
    pattern: /\bSET\s+(?:LOCAL\s+|SESSION\s+)?search_path\b/gi,
    reason:
      "search_path をマイグレーションで動かしてはいけません。自スキーマはロール既定の search_path で決まります。",
  },
  {
    pattern: /\bCREATE\s+ROLE\b/gi,
    reason: "ロールの作成は db/bootstrap/ の admin 用 SQL の責務です。",
  },
  {
    pattern: /\bALTER\s+ROLE\b/gi,
    reason: "ロールの変更は db/bootstrap/ の admin 用 SQL の責務です。",
  },
  {
    pattern: /\bGRANT\b/gi,
    reason:
      "権限の付与は db/bootstrap/ の admin 用 SQL の責務です。モジュールが自分に権限を足せてしまうと境界が意味を失います。",
  },
];

type Violation = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
  readonly message: string;
};

const violations: Violation[] = [];

/**
 * SQL コメント (`--` と `/* *\/`) を空白に置き換える。
 *
 * - 文字列リテラル / 引用識別子 / ドル引用符の中にある `--` はコメントではないので残す
 * - ブロックコメントは PostgreSQL の仕様どおり入れ子を許す
 * - 位置がずれないよう、除去した分は空白で埋め、改行はそのまま残す
 */
function stripComments(sql: string): string {
  const out = [...sql];
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);

    // 行コメント
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    // ブロックコメント (入れ子あり)
    if (rest.startsWith("/*")) {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith("/*", j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith("*/", j)) {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }

    // ドル引用符 ($$ ... $$ / $tag$ ... $tag$)
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      continue;
    }

    // 文字列リテラル / 引用識別子 ('' と "" によるエスケープを含む)
    if (rest.startsWith("'") || rest.startsWith('"')) {
      const quote = rest[0];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }

    i += 1;
  }

  return out.join("");
}

function positionOf(sql: string, index: number): { line: number; column: number } {
  const before = sql.slice(0, index);
  const line = before.split("\n").length;
  const lastBreak = before.lastIndexOf("\n");
  return { line, column: index - lastBreak };
}

function lineAt(sql: string, index: number): string {
  const start = sql.lastIndexOf("\n", index - 1) + 1;
  const end = sql.indexOf("\n", index);
  return sql.slice(start, end === -1 ? sql.length : end).trim();
}

function checkFile(file: string, moduleName: string): void {
  const raw = readFileSync(join(repoRoot, file), "utf8");
  const sql = stripComments(raw);

  const foreign = foreignSchemasOf(moduleName);
  if (foreign.length > 0) {
    // `catalog.` / `"catalog".` の形だけを見る。bakery_catalog のような
    // 識別子の一部にたまたま含まれる場合は拾わない。
    const pattern = new RegExp(`(?<![A-Za-z0-9_])(")?(${foreign.join("|")})\\1?\\s*\\.`, "gi");
    for (const match of sql.matchAll(pattern)) {
      const index = match.index;
      const { line, column } = positionOf(raw, index);
      violations.push({
        file,
        line,
        column,
        excerpt: lineAt(raw, index),
        message:
          `\`${moduleName}\` のマイグレーションが他のスキーマ \`${match[2]}\` に触れています。` +
          " スキーマをまたぐ参照は DB ロールでも拒否されます。必要な情報はイベントか公開ユースケース経由で受け取ってください。",
      });
    }
  }

  for (const { pattern, reason } of FORBIDDEN_STATEMENTS) {
    pattern.lastIndex = 0;
    for (const match of sql.matchAll(pattern)) {
      const index = match.index;
      const { line, column } = positionOf(raw, index);
      violations.push({
        file,
        line,
        column,
        excerpt: lineAt(raw, index),
        message: `\`${match[0].replace(/\s+/g, " ")}\` はマイグレーションに書けません。${reason}`,
      });
    }
  }
}

// --- 実行 -----------------------------------------------------------------------------

const targets: { file: string; moduleName: string }[] = [];
for (const { owner, dir } of TARGET_DIRS) {
  // まだ作られていない置き場は黙って飛ばす。
  if (!existsSync(join(repoRoot, dir))) continue;
  for (const found of globSync("**/*.sql", { cwd: join(repoRoot, dir) })) {
    targets.push({ file: [dir, found].join("/").split(sep).join("/"), moduleName: owner });
  }
}
targets.sort((a, b) => a.file.localeCompare(b.file));

if (targets.length === 0) {
  console.log(
    "マイグレーション検査: 対象なし (src/modules/<m>/infra/db/migrations/ と src/readmodel/db/migrations/)",
  );
  process.exit(0);
}

for (const { file, moduleName } of targets) checkFile(file, moduleName);

if (violations.length === 0) {
  console.log(`マイグレーション検査 OK (${targets.length} ファイル)`);
  process.exit(0);
}

console.error(`マイグレーションの境界違反が ${violations.length} 件あります。\n`);
for (const v of violations) {
  console.error(`  ✖ ${v.file}:${v.line}:${v.column}`);
  console.error(`      ${v.excerpt}`);
  console.error(`      ${v.message}`);
  console.error("");
}
console.error("規約: docs/conventions/module-boundaries.md");
process.exit(1);
