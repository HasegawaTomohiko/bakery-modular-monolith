/**
 * ローカル環境の規約を CI で強制する。
 *
 * 規約本文:
 *   - docs/conventions/local-environment.md
 *   - docs/conventions/hostnames.md
 *
 * 検査するもの:
 *   1. ports 禁止   — `ports:` を書いてよいのは edge/compose.yaml だけ
 *   2. ホスト名規約 — Traefik ラベルの Host(`...`) が devtools / bakery 名前空間の規約に従うこと
 *   3. ネットワーク — 入口に出すサービスは edge に参加し、ミドルウェアは参加しないこと
 *
 * 人に期待せず仕組みで守らせるためのもの。違反があれば exit 1。
 */
import { globSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Document,
  isMap,
  isPair,
  isScalar,
  LineCounter,
  type Node,
  type Pair,
  parseDocument,
  visit,
} from "yaml";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** edge compose のディレクトリ。ここだけが ports とホスト名規約の例外になる。 */
const EDGE_DIR = "edge";

/** プロダクトの名前空間。将来マシン共通 Traefik に移行してもそのまま使える。 */
const PRODUCT_DOMAIN_SUFFIX = ".bakery.localhost";

/** 開発者ツールのサブ名前空間。`profiles: [tools]` のサービスだけが使える。 */
const DEVTOOLS_SEGMENT = "devtools";

/** 開発者ツールを分離する profile 名。 */
const TOOLS_PROFILE = "tools";

/** プロダクト compose 内で edge (dev-edge) を指すネットワークキー。 */
const EDGE_NETWORK_KEY = "edge";

/** `<tool>.devtools.bakery.localhost` 形式。 */
const DEVTOOLS_HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.devtools\.bakery\.localhost$/;

type Violation = {
  readonly file: string;
  readonly where: string;
  readonly line: number | undefined;
  readonly rule: string;
  readonly message: string;
};

const violations: Violation[] = [];

function report(v: Violation): void {
  violations.push(v);
}

// --- YAML / compose の読み取りヘルパ -------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** compose の `networks` / `profiles` はリストでもマップでも書けるので両方を受ける。 */
function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  const record = asRecord(value);
  return record ? Object.keys(record) : [];
}

/** `labels` はリスト (`- k=v`) でもマップ (`k: v`) でも書ける。 */
function toLabelMap(value: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") continue;
      const eq = item.indexOf("=");
      if (eq === -1) labels.set(item.trim(), "");
      else labels.set(item.slice(0, eq).trim(), item.slice(eq + 1).trim());
    }
    return labels;
  }
  const record = asRecord(value);
  if (record) {
    for (const [key, raw] of Object.entries(record)) labels.set(key.trim(), String(raw).trim());
  }
  return labels;
}

/** YAML の祖先ノードから `services.api` のような表示用のパスを組み立てる。 */
function pathToLabel(path: readonly unknown[]): string {
  const keys: string[] = [];
  for (const node of path) {
    if (isPair(node) && isScalar(node.key) && typeof node.key.value === "string") {
      keys.push(node.key.value);
    }
  }
  return keys.length > 0 ? keys.join(".") : "(document root)";
}

function lineOf(lineCounter: LineCounter, node: unknown): number | undefined {
  if (!isScalar(node) || !node.range) return undefined;
  return lineCounter.linePos(node.range[0]).line;
}

/** サービス定義が書かれている行。エラーメッセージを追いやすくするためだけに使う。 */
function serviceLine(doc: Document, lineCounter: LineCounter, name: string): number | undefined {
  const services = doc.get("services", true);
  if (!isMap(services)) return undefined;
  for (const item of services.items) {
    if (isScalar(item.key) && item.key.value === name) return lineOf(lineCounter, item.key);
  }
  return undefined;
}

// --- 検査 -----------------------------------------------------------------------------

/**
 * 検査 1: ports 禁止。
 *
 * サービス定義だけでなく `x-app` のような YAML アンカーに書かれた場合も拾いたいので、
 * ドキュメント全体を歩いて `ports` キーを探す。エイリアス (`<<: *app`) は展開されないため、
 * アンカー由来の違反が二重に報告されることはない。
 */
function checkNoPorts(file: string, doc: Document, lineCounter: LineCounter): void {
  visit(doc, {
    Pair(_key: unknown, pair: Pair, path: readonly (Node | Document | Pair)[]) {
      if (!isScalar(pair.key) || pair.key.value !== "ports") return;
      report({
        file,
        where: pathToLabel([...path, pair]),
        line: lineOf(lineCounter, pair.key),
        rule: "ports",
        message:
          "`ports:` を書いてよいのは edge/compose.yaml だけです。入口は Traefik (edge) 経由にしてください。" +
          " 個人用にポートを開けたい場合は gitignore された compose.override.yaml を使ってください。",
      });
    },
  });
}

/** Traefik のルール文字列から Host(`...`) を取り出す。1 ラベルに複数書けるので global で回す。 */
function extractHosts(labelValue: string): string[] {
  const hosts: string[] = [];
  for (const match of labelValue.matchAll(/Host\(`([^`]+)`\)/g)) {
    const host = match[1];
    if (host !== undefined) hosts.push(host);
  }
  return hosts;
}

/**
 * 検査 2: ホスト名規約。
 *
 * edge/compose.yaml は対象外。edge はプロダクトを知らないので `traefik.localhost` を使う。
 */
function checkHostnames(
  file: string,
  serviceName: string,
  labels: Map<string, string>,
  profiles: readonly string[],
  line: number | undefined,
): void {
  const hosts = [...labels.values()].flatMap(extractHosts);
  if (hosts.length === 0) return;

  const isTool = profiles.includes(TOOLS_PROFILE);
  for (const host of hosts) {
    const segments = host.split(".");
    if (isTool) {
      if (!DEVTOOLS_HOST_PATTERN.test(host)) {
        report({
          file,
          where: serviceName,
          line,
          rule: "hostname",
          message:
            `\`profiles: [${TOOLS_PROFILE}]\` のサービスのホスト名は ` +
            `\`<tool>.${DEVTOOLS_SEGMENT}${PRODUCT_DOMAIN_SUFFIX}\` 形式でなければなりません: \`${host}\``,
        });
      }
      continue;
    }
    if (segments.includes(DEVTOOLS_SEGMENT)) {
      report({
        file,
        where: serviceName,
        line,
        rule: "hostname",
        message:
          `\`${DEVTOOLS_SEGMENT}\` 名前空間は \`profiles: [${TOOLS_PROFILE}]\` の開発者ツール専用です。` +
          ` プロダクトのサービスは使えません: \`${host}\``,
      });
    }
    if (!host.endsWith(PRODUCT_DOMAIN_SUFFIX)) {
      report({
        file,
        where: serviceName,
        line,
        rule: "hostname",
        message: `プロダクトのホスト名は \`${PRODUCT_DOMAIN_SUFFIX}\` で終わらなければなりません: \`${host}\``,
      });
    }
  }
}

/**
 * 検査 3: ネットワーク規約。
 *
 * 入口に出すもの (`traefik.enable=true`) は edge に参加する。
 * ミドルウェア (`traefik.enable` を持たないもの) は internal のみで、edge には出さない。
 * edge compose 自身は「プロダクト側の internal/edge の使い分け」の外にあるので対象外。
 */
function checkNetworks(
  file: string,
  serviceName: string,
  labels: Map<string, string>,
  networks: readonly string[],
  line: number | undefined,
): void {
  const exposed = labels.get("traefik.enable") === "true";
  const joinsEdge = networks.includes(EDGE_NETWORK_KEY);

  if (exposed && !joinsEdge) {
    report({
      file,
      where: serviceName,
      line,
      rule: "network",
      message:
        "`traefik.enable=true` のサービスは Traefik から見えるように " +
        `\`${EDGE_NETWORK_KEY}\` ネットワークに参加しなければなりません (現在: [${networks.join(", ")}])。`,
    });
  }
  if (!exposed && joinsEdge) {
    report({
      file,
      where: serviceName,
      line,
      rule: "network",
      message:
        `\`traefik.enable=true\` を持たないサービス (= ミドルウェア) を \`${EDGE_NETWORK_KEY}\` に出してはいけません。` +
        " internal のみに参加させてください。",
    });
  }
}

// --- 実行 -----------------------------------------------------------------------------

function findComposeFiles(): string[] {
  return (
    globSync("**/compose*.{yaml,yml}", {
      cwd: repoRoot,
      exclude: (name: string) => name.split(sep).includes("node_modules"),
    })
      .map((path) => path.split(sep).join("/"))
      // 個人用の override は gitignore してあるので規約の対象外。
      .filter((path) => !/(^|\/)compose\.override\.ya?ml$/.test(path))
      .sort()
  );
}

function isEdgeFile(file: string): boolean {
  return file.startsWith(`${EDGE_DIR}/`);
}

function checkFile(file: string): void {
  const source = readFileSync(join(repoRoot, file), "utf8");
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { merge: true, lineCounter });

  for (const error of doc.errors) {
    report({
      file,
      where: "(parse)",
      line: lineCounter.linePos(error.pos[0]).line,
      rule: "yaml",
      message: error.message,
    });
  }
  if (doc.errors.length > 0) return;

  const edge = isEdgeFile(file);
  if (!edge) checkNoPorts(file, doc, lineCounter);

  const root = asRecord(doc.toJS({ maxAliasCount: -1 }));
  const services = asRecord(root?.services);
  if (!services) return;

  for (const [name, rawService] of Object.entries(services)) {
    const service = asRecord(rawService);
    if (!service) continue;
    const labels = toLabelMap(service.labels);
    const line = serviceLine(doc, lineCounter, name);

    if (!edge) {
      checkHostnames(file, name, labels, toStringList(service.profiles), line);
      checkNetworks(file, name, labels, toStringList(service.networks), line);
    }
  }
}

const files = findComposeFiles();
if (files.length === 0) {
  console.error("compose ファイルが 1 つも見つかりませんでした。検査の設定を確認してください。");
  process.exit(1);
}

for (const file of files) checkFile(file);

if (violations.length === 0) {
  console.log(`compose 規約チェック OK (${files.length} ファイル: ${files.join(", ")})`);
  process.exit(0);
}

console.error(`compose 規約違反が ${violations.length} 件あります。\n`);
for (const file of [...new Set(violations.map((v) => v.file))]) {
  console.error(file);
  for (const v of violations.filter((violation) => violation.file === file)) {
    const at = v.line === undefined ? v.where : `${v.where} (${file}:${v.line})`;
    console.error(`  ✖ [${v.rule}] ${at}`);
    console.error(`      ${v.message}`);
  }
  console.error("");
}
console.error("規約: docs/conventions/local-environment.md / docs/conventions/hostnames.md");
process.exit(1);
