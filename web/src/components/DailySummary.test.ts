/**
 * 今日のサマリの描画。
 *
 * この画面の肝は「売れ残り (= 廃棄ロス) が一目で分かること」なので、
 * 数字が出ることに加えて**強調の付き方と並び順**を固定する。
 * ここが崩れても例外は出ないため、マウントの煙テスト (App.test.ts) では拾えない。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DailyDashboard, Product } from "../queries.ts";
import type { AsyncState } from "../use-async.ts";
import type { ProductMap } from "../use-products.ts";

const WELL_SOLD = "11111111-1111-4111-8111-111111111111";
const LEFT_OVER = "22222222-2222-4222-8222-222222222222";

const product = (productId: string, name: string): Product => ({
  productId,
  name,
  priceJpy: 320,
  allergens: ["wheat"],
  sellable: true,
  priceHistory: [],
});

const products: ProductMap = new Map([
  [WELL_SOLD, product(WELL_SOLD, "食パン")],
  [LEFT_OVER, product(LEFT_OVER, "パンオショコラ")],
]);

const dashboard: DailyDashboard = {
  businessDate: "2026-09-11",
  totals: {
    producedPieces: 60,
    soldPieces: 50,
    leftoverPieces: 10,
    salesJpy: 9600,
    wasteRatePercent: 16.7,
  },
  products: [
    // 売り切った商品を先に置く。表示は売れ残りの多い順に並べ替わるはず。
    {
      productId: WELL_SOLD,
      producedPieces: 20,
      soldPieces: 20,
      leftoverPieces: 0,
      salesJpy: 0,
      delisted: false,
      delistReason: null,
    },
    {
      productId: LEFT_OVER,
      producedPieces: 40,
      soldPieces: 30,
      leftoverPieces: 10,
      salesJpy: 9600,
      delisted: true,
      delistReason: "seasonal",
    },
  ],
  lots: [
    {
      lotCode: "PC-20260911",
      productId: LEFT_OVER,
      bestBefore: "2026-09-11",
      producedPieces: 40,
      soldPieces: 30,
      leftoverPieces: 10,
      salesJpy: 9600,
    },
  ],
  ingredients: [],
};

const ready = <T>(value: T): AsyncState<T> => ({
  loading: false,
  value,
  error: null,
  refresh: () => {},
});

/** 動的 import なので型は `typeof import(...)` から取る (型だけの参照なので評価されない)。 */
type DailySummaryComponent = typeof import("./DailySummary.tsx")["DailySummary"];

let DailySummary: DailySummaryComponent;

beforeAll(async () => {
  // 描画に通信は要らないが、モジュールの評価には api.ts のベース URL が要る。
  // import は巻き上げられるため、stub した後に動的 import する。
  vi.stubEnv("VITE_API_BASE_URL", "http://api.example.test");
  ({ DailySummary } = await import("./DailySummary.tsx"));
});

const render = (state: AsyncState<DailyDashboard>): string =>
  renderToStaticMarkup(createElement(DailySummary, { state, products }));

describe("DailySummary", () => {
  it("合計を読める形で出す", () => {
    const markup = render(ready(dashboard));

    expect(markup).toContain("¥9,600");
    expect(markup).toContain("廃棄ロス率 16.7%");
    expect(markup).toContain("売れ残り (廃棄ロス)");
  });

  it("売れ残りの多い商品を上に出し、強い色を付ける", () => {
    const markup = render(ready(dashboard));

    // 並び順: 売れ残り 10 個の方が先。
    expect(markup.indexOf("パンオショコラ")).toBeLessThan(markup.indexOf("食パン"));
    // ロス率 25% は「重い」扱い (15% 以上)。
    expect(markup).toContain("waste waste-bad");
    // 売り切った商品は緑。
    expect(markup).toContain("waste waste-none");
    expect(markup).toContain("25%");
  });

  it("商品名は catalog から引いた名前で出す (識別子のままにしない)", () => {
    const markup = render(ready(dashboard));

    expect(markup).toContain("パンオショコラ");
    expect(markup).not.toContain(LEFT_OVER);
  });

  it("販売停止の商品には印を付ける", () => {
    expect(render(ready(dashboard))).toContain("販売停止");
  });

  it("どのロットが余ったかを出す", () => {
    const markup = render(ready(dashboard));

    expect(markup).toContain("PC-20260911");
    expect(markup).toContain("ロット別");
  });

  it("イベントがまだ届いていない日は、空だと分かる形で出す", () => {
    const markup = render(
      ready({
        businessDate: "2026-09-12",
        totals: {
          producedPieces: 0,
          soldPieces: 0,
          leftoverPieces: 0,
          salesJpy: 0,
          wasteRatePercent: 0,
        },
        products: [],
        lots: [],
        ingredients: [],
      }),
    );

    expect(markup).toContain("イベントはまだ届いていません");
    expect(markup).toContain("¥0");
  });

  it("取得に失敗しても画面は壊れず、失敗が分かる", () => {
    const markup = render({
      loading: false,
      value: null,
      error: new Error("HTTP 500"),
      refresh: () => {},
    });

    expect(markup).toContain("取得できませんでした");
    expect(markup).toContain("HTTP 500");
  });

  it("取得中は読み込み中として描かれる", () => {
    const markup = render({ loading: true, value: null, error: null, refresh: () => {} });

    expect(markup).toContain("読み込み中…");
  });
});
