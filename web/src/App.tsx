/**
 * パン屋の「今日のダッシュボード」。
 *
 * 画面の主役は**廃棄ロス**。売上と廃棄ロスを分けるのは「今日何を何個焼くか」という
 * 製造計画で、そこがこのドメインのコアだから (atodekesu.md 3章)。
 *
 * データの出どころは 5 つのコンテキスト + 参照モデルに分かれている。
 * コンテキストをまたぐ数字 (製造 / 販売 / 売れ残り) は参照モデル 1 本から読み、
 * 単一コンテキストの表はそれぞれの公開 API から読む。画面側で 5 つの API を
 * 突き合わせて「またぐ表」を作ることはしない。
 *
 * 呼び出しは全て hc の RPC クライアント経由なので、API 側の型がそのまま効く。
 */
import { useCallback, useMemo, useState } from "react";
import { DailySummary } from "./components/DailySummary.tsx";
import { AlertPanel, IngredientPanel, ProductLotPanel } from "./components/InventoryPanels.tsx";
import { ProductCatalog } from "./components/ProductCatalog.tsx";
import { PurchaseSuggestions } from "./components/PurchaseSuggestions.tsx";
import { todayInJst } from "./format.ts";
import {
  fetchDailyDashboard,
  fetchIngredients,
  fetchProductLots,
  fetchPurchaseSuggestions,
  fetchStockAlerts,
} from "./queries.ts";
import { useAsync } from "./use-async.ts";
import { useProducts } from "./use-products.ts";

/**
 * 自動更新の間隔。
 * イベントの配信は worker のポーリング (既定 1 秒) 越しの結果整合なので、
 * 操作の直後は数字が揃っていないことがある。放っておけば追いつく。
 */
const REFRESH_INTERVAL_MS = 5_000;

export function App() {
  const [businessDate, setBusinessDate] = useState(todayInJst);

  const loadDashboard = useCallback(
    (signal: AbortSignal) => fetchDailyDashboard(businessDate, signal),
    [businessDate],
  );

  const dashboard = useAsync(loadDashboard, REFRESH_INTERVAL_MS);
  const ingredients = useAsync(fetchIngredients, REFRESH_INTERVAL_MS);
  const productLots = useAsync(fetchProductLots, REFRESH_INTERVAL_MS);
  const alerts = useAsync(fetchStockAlerts, REFRESH_INTERVAL_MS);
  const suggestions = useAsync(fetchPurchaseSuggestions, REFRESH_INTERVAL_MS);

  // 他のコンテキストが返すのは productId だけ。名前を出すために集めて catalog に引く。
  const productIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of dashboard.value?.products ?? []) ids.add(row.productId);
    for (const lot of dashboard.value?.lots ?? []) ids.add(lot.productId);
    for (const lot of productLots.value ?? []) ids.add(lot.productId);
    return [...ids];
  }, [dashboard.value, productLots.value]);

  const products = useProducts(productIds, REFRESH_INTERVAL_MS);

  const refreshAll = (): void => {
    dashboard.refresh();
    ingredients.refresh();
    productLots.refresh();
    alerts.refresh();
    suggestions.refresh();
    products.refresh();
  };

  const busy =
    dashboard.loading ||
    ingredients.loading ||
    productLots.loading ||
    alerts.loading ||
    suggestions.loading;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>パン屋ダッシュボード</h1>
          <p className="note">
            当日焼いて当日売り切る商売。焼きすぎれば廃棄ロス、足りなければ機会損失。
          </p>
        </div>
        <div className="controls">
          <label htmlFor="business-date">営業日</label>
          <input
            id="business-date"
            type="date"
            value={businessDate}
            onChange={(event) => setBusinessDate(event.target.value)}
          />
          <button type="button" onClick={refreshAll}>
            更新
          </button>
          <span className="dim" aria-live="polite">
            {busy ? "更新中…" : `${REFRESH_INTERVAL_MS / 1000} 秒ごとに自動更新`}
          </span>
        </div>
      </header>

      <main>
        <DailySummary state={dashboard} products={products.value} />

        <div className="columns">
          <IngredientPanel state={ingredients} />
          <ProductLotPanel state={productLots} products={products.value} />
        </div>

        <AlertPanel state={alerts} />
        <PurchaseSuggestions state={suggestions} ingredients={ingredients.value} />
        <ProductCatalog state={products} />
      </main>

      <footer className="dim">
        コンテキスト間は結果整合。操作の直後は数字が揃っていないことがあるが、worker
        がイベントを配り終えると追いつく。
      </footer>
    </div>
  );
}
