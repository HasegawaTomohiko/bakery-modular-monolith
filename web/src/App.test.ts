/**
 * マウントの煙テスト。
 *
 * この画面の壊れ方は HTTP のステータスコードに出ない。index.html は常に 200 で返り、
 * 中身が組み上がらないことに気づけるのはブラウザのコンソールか Vite のログだけ。
 * 実際に「App.tsx が無いのに main.tsx が import している」状態を CI が素通りさせた。
 *
 * そこで react-dom/server で**実際に描画する**。データ取得は useEffect なので走らず、
 * 読み込み中の状態が描かれる。それでも次は全部落とせる:
 *   - import 先が無い / 名前が違う
 *   - コンポーネントが未定義 (undefined を描画しようとする)
 *   - 描画中に例外が出る (不正なフック呼び出しを含む)
 *   - セクションが画面から落ちている
 *
 * 見出しの確認は `<h2>...</h2>` の形で見る。本文中にも同じ語が出てくるので
 * (例: 原材料在庫の説明文に「発注提案」がある)、素の文字列で探すと
 * **セクションを消しても通ってしまう**。実際に消して落ちることを確認してある。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

let markup = "";

beforeAll(async () => {
  // api.ts はベース URL が無いと起動時に落ちる (コードが既定値を持たない設計)。
  // 描画だけなので通信はしないが、モジュールの評価には必要なのでダミーを与える。
  // import は巻き上げられるため、stub した後に動的 import する。
  vi.stubEnv("VITE_API_BASE_URL", "http://api.example.test");
  const { App } = await import("./App.tsx");
  markup = renderToStaticMarkup(createElement(App));
});

describe("App", () => {
  it("例外を投げずに組み上がる", () => {
    // 空を描画して通るテストにしない。中身があることまで見る。
    expect(markup.length).toBeGreaterThan(500);
    expect(markup).toContain("パン屋ダッシュボード");
  });

  it("セクションが揃っている", () => {
    for (const heading of [
      "今日のサマリ",
      "原材料在庫",
      "製品ロット在庫",
      "在庫アラート",
      "発注提案",
      "商品",
    ]) {
      expect(markup).toContain(`<h2>${heading}</h2>`);
    }
  });

  it("どのコンテキストの数字かを画面に出している", () => {
    const source = (name: string): string =>
      `<span class="source" title="この数字の出どころ">${name}</span>`;

    expect(markup).toContain(source("参照モデル (/dashboard)"));
    expect(markup).toContain(source("inventory (g / ml)"));
    expect(markup).toContain(source("inventory (個数)"));
    expect(markup).toContain(source("purchasing"));
    expect(markup).toContain(source("catalog"));
  });

  it("廃棄ロスが主役であることが本文に出ている", () => {
    expect(markup).toContain("売れ残り");
    expect(markup).toContain("廃棄ロス");
  });

  it("取得前は読み込み中として描かれる (useEffect は SSR では走らない)", () => {
    expect(markup).toContain("読み込み中…");
    // 読み込み中でも営業日の入力は使える。
    expect(markup).toMatch(/<input id="business-date" type="date" value="\d{4}-\d{2}-\d{2}"/);
  });
});
