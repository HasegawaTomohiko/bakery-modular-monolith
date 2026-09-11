import { hc } from "hono/client";
import type { AppType } from "../../src/entrypoints/api.ts";

/**
 * API クライアント。
 *
 * `AppType` は src/entrypoints/api.ts が export している Hono アプリの型そのもの。
 * hc に渡すことで、パス・パラメータ・レスポンスの型が API 側の定義から直接効く。
 * **型を手で書き写さない**。書き写すと、API が変わったときにフロントが黙って壊れる。
 *
 * ベース URL は設定から受け取る。edge (Traefik) はローカルの都合であって本番には
 * 持ち込まないので、入口のホスト名をコードに書かない。書くと、この画面が
 * ローカルの入口の形に依存してしまう
 * (docs/conventions/local-environment.md「本番との線引き」)。
 */
const baseUrl = import.meta.env.VITE_API_BASE_URL;

if (typeof baseUrl !== "string" || baseUrl.length === 0) {
  throw new Error(
    "VITE_API_BASE_URL が設定されていません。compose.yaml の web サービスが渡します。",
  );
}

export const apiBaseUrl = baseUrl;

export const client = hc<AppType>(baseUrl);
