/**
 * env から設定を読む。
 *
 * 「devcontainer はホストPCをコンテナに入れたもの」という整理により、接続情報は
 * サービス側 (compose.yaml) が env で渡す。コードは既定値を持たない。
 *
 * 読み取りは遅延させる。drizzle-kit generate のようにモジュール1つ分の env しか
 * 要らない用途で、無関係な変数まで要求しないため。
 */
import { z } from "zod";

export const MODULES = ["catalog", "production", "inventory", "purchasing", "sales"] as const;

export type ModuleName = (typeof MODULES)[number];

/**
 * 参照モデル。モジュール (境界づけられたコンテキスト) ではない。
 *
 * コンテキストをまたぐ画面は JOIN では作れない (スキーマをまたぐ権限が無い)。
 * 代わりにイベントから組み立てた参照用モデルをここに持つ。
 * 自分のスキーマとロールを持ち、**購読しかしない** (outbox は持たない)。
 */
export const READMODEL = "readmodel" as const;
export type ReadModelName = typeof READMODEL;

/** 自分のスキーマとロールを持つもの。モジュール5つ + 参照モデル。 */
export type SchemaOwner = ModuleName | ReadModelName;

export const SCHEMA_OWNERS = [...MODULES, READMODEL] as const;

export function isModuleName(value: string): value is ModuleName {
  return (MODULES as readonly string[]).includes(value);
}

const databaseUrlSchema = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: "postgres:// で始まる接続 URL であること",
  });

function readDatabaseUrl(key: string): string {
  const parsed = databaseUrlSchema.safeParse(process.env[key]);
  if (!parsed.success) {
    throw new Error(
      `環境変数 ${key} が不正: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  return parsed.data;
}

function envKeyFor(owner: SchemaOwner): string {
  return `DATABASE_URL_${owner.toUpperCase()}`;
}

/** 専用ロールの接続 URL。自スキーマの権限しか持たない。 */
export function moduleDatabaseUrl(owner: SchemaOwner): string {
  return readDatabaseUrl(envKeyFor(owner));
}

/**
 * ブラウザからの呼び出しを許可するオリジン (カンマ区切り)。
 *
 * フロントエンドと API はホスト名が違うので、ブラウザから見ると cross-origin になる。
 * これは edge 固有の事情ではなく、本番でも同じ構成になりうる本物の関心事なので、
 * アプリケーション側で CORS を扱う。
 *
 * 許可リストを env から受け取るのは、入口のホスト名をコードに書かないため
 * (docs/conventions/local-environment.md「本番との線引き」)。
 * 未設定なら空 = ブラウザからの cross-origin 呼び出しを一切許可しない。
 */
export function allowedWebOrigins(): readonly string[] {
  return (process.env.WEB_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** スキーマとロールを作るための管理接続。アプリケーションからは使わない。 */
export function adminDatabaseUrl(): string {
  return readDatabaseUrl("DATABASE_URL_ADMIN");
}
