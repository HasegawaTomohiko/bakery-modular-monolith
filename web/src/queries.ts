/**
 * API の呼び出し。
 *
 * 呼び口は hc の RPC クライアントだけにする。型は API 側 (`AppType`) から来るので、
 * ここにレスポンスの形を書き写すことはしない。API のスキーマが変われば、
 * 画面はここではなく **型エラー** で気づく。
 */
import { client } from "./api.ts";

/** 2xx 以外はその場で落とす。画面側は Error のメッセージを出すだけでよくなる。 */
async function expectOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(`${what} の取得に失敗しました (HTTP ${response.status}) ${body}`.trim());
}

/**
 * 今日のサマリ (参照モデル)。
 *
 * この画面だけがコンテキストをまたぐ。製造数は production、販売数と売上は sales、
 * 売れ残りは両者の差で、**JOIN では作らない**。イベントから組み立てた参照モデル
 * (`src/readmodel/`) が返す 1 つのビューを読む
 * (atodekesu.md 4章 / docs/conventions/module-boundaries.md)。
 */
export async function fetchDailyDashboard(businessDate: string, signal: AbortSignal) {
  const response = await client.dashboard.daily[":businessDate"].$get(
    { param: { businessDate } },
    { init: { signal } },
  );
  await expectOk(response, "今日のサマリ");
  return response.json();
}

export async function fetchIngredients(signal: AbortSignal) {
  const response = await client.inventory.ingredients.$get(undefined, { init: { signal } });
  await expectOk(response, "原材料在庫");
  return response.json();
}

export async function fetchProductLots(signal: AbortSignal) {
  const response = await client.inventory["product-lots"].$get(undefined, { init: { signal } });
  await expectOk(response, "製品ロット");
  return response.json();
}

export async function fetchStockAlerts(signal: AbortSignal) {
  const response = await client.inventory.alerts.$get(undefined, { init: { signal } });
  await expectOk(response, "在庫アラート");
  return response.json();
}

export async function fetchPurchaseSuggestions(signal: AbortSignal) {
  const response = await client.purchasing.suggestions.$get(undefined, { init: { signal } });
  await expectOk(response, "発注提案");
  return response.json();
}

/**
 * 商品情報は catalog に**識別子で同期に問い合わせて**引く。
 * 他のコンテキストが返すのは productId だけで、名前や価格はそちらには無い
 * (境界の強制: 他文脈のものは識別子だけを持つ)。
 */
export async function fetchProduct(productId: string, signal: AbortSignal) {
  const response = await client.catalog.products[":productId"].$get(
    { param: { productId } },
    { init: { signal } },
  );
  if (response.status === 404) return null;
  await expectOk(response, "商品");
  return response.json();
}

export type DailyDashboard = Awaited<ReturnType<typeof fetchDailyDashboard>>;
export type DailyProductSummary = DailyDashboard["products"][number];
export type DailyLotSummary = DailyDashboard["lots"][number];
export type IngredientStock = Awaited<ReturnType<typeof fetchIngredients>>[number];
export type ProductLot = Awaited<ReturnType<typeof fetchProductLots>>[number];
export type StockAlert = Awaited<ReturnType<typeof fetchStockAlerts>>[number];
export type PurchaseSuggestion = Awaited<ReturnType<typeof fetchPurchaseSuggestions>>[number];
export type Product = NonNullable<Awaited<ReturnType<typeof fetchProduct>>>;
