/**
 * CORS の回帰テスト。
 *
 * フロントエンド (app.*) と API (api.*) はホスト名が違うので、ブラウザから見ると
 * cross-origin になる。CORS ヘッダが欠けるとブラウザは fetch を弾くが、
 * **curl も OpenAPI のドキュメントも 200 を返し続ける**ので気づけない。
 * 実際に一度これで画面が「Failed to fetch」になったので、ここで固定する。
 *
 * DB には触らないので単体テストとして回る (CI は DB 無しで動く)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WEB_ORIGIN = "http://app.example.test";
const OTHER_ORIGIN = "http://evil.example.test";

/**
 * 許可リストは import 時の env で決まるので、env を変えたらモジュールを読み直す。
 * `vi.resetModules` で毎回まっさらにする。
 */
async function loadApp(webOrigins: string | undefined) {
  const { resetModules } = await import("vitest").then((m) => ({
    resetModules: m.vi.resetModules,
  }));
  resetModules();
  if (webOrigins === undefined) {
    process.env.WEB_ORIGINS = undefined as unknown as string;
    delete process.env.WEB_ORIGINS;
  } else {
    process.env.WEB_ORIGINS = webOrigins;
  }
  const module = await import("../../src/entrypoints/api-app.ts");
  return module.default;
}

const original = process.env.WEB_ORIGINS;
beforeEach(() => {
  delete process.env.WEB_ORIGINS;
});
afterEach(() => {
  if (original === undefined) delete process.env.WEB_ORIGINS;
  else process.env.WEB_ORIGINS = original;
});

describe("CORS", () => {
  it("許可したオリジンからの GET に Access-Control-Allow-Origin を返す", async () => {
    const app = await loadApp(WEB_ORIGIN);

    const response = await app.request("/health", { headers: { Origin: WEB_ORIGIN } });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
  });

  it("preflight (OPTIONS) に応答する", async () => {
    const app = await loadApp(WEB_ORIGIN);

    const response = await app.request("/dashboard/daily/2026-09-11", {
      method: "OPTIONS",
      headers: {
        Origin: WEB_ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    // 404 だとブラウザは本リクエストを送らない。ここが今回の不具合そのもの。
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("許可していないオリジンには Access-Control-Allow-Origin を返さない", async () => {
    const app = await loadApp(WEB_ORIGIN);

    const response = await app.request("/health", { headers: { Origin: OTHER_ORIGIN } });

    expect(response.headers.get("access-control-allow-origin")).not.toBe(OTHER_ORIGIN);
  });

  it("WEB_ORIGINS 未設定なら cross-origin を許可しない", async () => {
    const app = await loadApp(undefined);

    const response = await app.request("/health", { headers: { Origin: WEB_ORIGIN } });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("カンマ区切りで複数のオリジンを許可できる", async () => {
    const second = "http://app2.example.test";
    const app = await loadApp(`${WEB_ORIGIN}, ${second}`);

    for (const origin of [WEB_ORIGIN, second]) {
      const response = await app.request("/health", { headers: { Origin: origin } });
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("Origin が無い呼び出し (curl 等) はそのまま通る", async () => {
    const app = await loadApp(WEB_ORIGIN);

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
