# 手で動かす: パン屋の1日

5つのコンテキストを `curl` で横断する手順。自動テストは `tests/integration/end-to-end.test.ts` が同じ流れを見ている。

ここで確かめるのは次の3点。

1. 入口 (`api.bakery.localhost`) 経由で全モジュールの API に届くこと
2. コンテキストをまたぐ状態変化が **worker のイベント配信で** 伝わること（同期呼び出しではない）
3. 配信前は届いていないこと（結果整合であること）

## 準備

```bash
make up          # edge → プロダクト
make migrate     # スキーマ・ロール・マイグレーション
curl -s http://api.bakery.localhost/health    # {"status":"ok"}
```

worker のポーリング間隔は 1 秒（`OUTBOX_POLL_INTERVAL_MS`）。以下の手順で `sleep 3` を挟んでいるのはそのため。

```bash
API=http://api.bakery.localhost
post() { curl -s -X POST "$API$1" -H 'content-type: application/json' -d "$2"; }
get()  { curl -s "$API$1"; }
pick() { python3 -c "import sys,json;print(json.load(sys.stdin)['$1'])"; }
```

## 1. マスタを作る

```bash
PRODUCT=$(post /catalog/products \
  '{"name":"パンオショコラ","priceJpy":320,"allergens":["wheat","milk","egg"]}' | pick productId)

FLOUR=$(post /inventory/ingredients \
  '{"name":"強力粉","unit":"g","reorderPoint":{"amount":5000,"unit":"g"}}' | pick ingredientId)

SUP=$(post /purchasing/suppliers '{"name":"製粉所B","leadTimeDays":2}' | pick supplierId)

# 20個取りのレシピ。1バッチに強力粉 2000g。
RECIPE=$(post /production/recipes \
  "{\"productId\":\"$PRODUCT\",\"yieldQuantity\":{\"amount\":20,\"unit\":\"piece\"},
    \"lines\":[{\"ingredientId\":\"$FLOUR\",\"quantity\":{\"amount\":2000,\"unit\":\"g\"}}]}" | pick recipeId)
```

`productId` は catalog が、`ingredientId` は inventory が採番する。他のモジュールはこれを**識別子としてだけ**持つ。

## 2. 購買: 発注 → 入荷 → 検収

```bash
PO=$(post /purchasing/orders \
  "{\"supplierId\":\"$SUP\",\"lines\":[{\"ingredientId\":\"$FLOUR\",\"quantity\":{\"amount\":25000,\"unit\":\"g\"}}]}" \
  | pick purchaseOrderId)

GR=$(post "/purchasing/orders/$PO/receipts" \
  "{\"receivedAt\":\"2026-09-11T06:00:00+09:00\",
    \"lines\":[{\"ingredientId\":\"$FLOUR\",\"quantity\":{\"amount\":25000,\"unit\":\"g\"},
                \"lotCode\":\"F-900\",\"bestBefore\":\"2026-10-11\"}]}" | pick goodsReceiptId)

# ★ 入荷しただけでは在庫にならない
get "/inventory/ingredients/$FLOUR"      # onHand = 0g
```

**入荷と検収は別のこと。** 「モノが届いた」と「数量と品質を確認して受け入れた」を分けている。イベントが出るのは検収時だけ。

```bash
curl -s -X POST "$API/purchasing/receipts/$GR/accept" \
  -H 'content-type: application/json' -d '{"acceptedAt":"2026-09-11T06:30:00+09:00"}'   # 204

get "/inventory/ingredients/$FLOUR"      # ★ まだ 0g。worker が配る前なので届いていない
sleep 3
get "/inventory/ingredients/$FLOUR"      # onHand = 25000g
```

`purchasing.GoodsReceiptAccepted` → inventory。purchasing が inventory のユースケースを直接呼ぶことはない。

## 3. 製造: 計画 → 焼き上がり

```bash
PLAN=$(post /production/plans \
  "{\"businessDate\":\"2026-09-11\",
    \"items\":[{\"productId\":\"$PRODUCT\",\"recipeId\":\"$RECIPE\",
                \"plannedQuantity\":{\"amount\":40,\"unit\":\"piece\"},\"basis\":\"manual\"}]}" \
  | pick productionPlanId)

post /production/runs \
  "{\"productionPlanId\":\"$PLAN\",\"productId\":\"$PRODUCT\",\"recipeId\":\"$RECIPE\",
    \"producedQuantity\":{\"amount\":40,\"unit\":\"piece\"},\"lotCode\":\"PC-20260911\",
    \"bestBefore\":\"2026-09-11\",\"completedAt\":\"2026-09-11T07:30:00+09:00\"}"

sleep 3
get "/inventory/ingredients/$FLOUR"      # 21000g  (25000 - 2000×2バッチ)
get "/inventory/product-lots"            # PC-20260911 が 40個
```

**消費量 4000g は production が計算してイベントに載せた値。** レシピは production の持ち物なので、inventory がレシピを引くことはない。

20個取りのレシピで 40個 = **2バッチ**。生地はバッチ単位でしか仕込めないので、端数は切り上げる（`src/modules/production/domain/recipe.ts`）。

原材料は g、製品ロットは個数。**モデルが分かれている**ことが `/inventory/ingredients` と `/inventory/product-lots` に現れている。

## 4. 販売

```bash
post /sales/sales \
  "{\"soldAt\":\"2026-09-11T10:00:00+09:00\",
    \"lines\":[{\"productId\":\"$PRODUCT\",\"lotCode\":\"PC-20260911\",
                \"quantity\":{\"amount\":30,\"unit\":\"piece\"}}]}"

sleep 3
get "/inventory/product-lots"            # PC-20260911 が 10個 (出庫された)
get "/sales/daily/2026-09-11"            # totalJpy = 9600 (320 × 30)
get "/production/forecast/$PRODUCT?businessDate=2026-09-12"
```

`sales.SaleCompleted` は**購読先が2つある唯一のイベント**。

- inventory → 製品を出庫（40 → 10）
- production → 需要予測の入力として販売実績を記録

```json
{"forecastQuantity":{"amount":30,"unit":"piece"},
 "basis":{"sampleDays":1,"averageSoldQuantity":{"amount":30,"unit":"piece"},
          "reservedQuantity":{"amount":0,"unit":"piece"}}}
```

sales は在庫を持たない。単価は**販売時点の価格**を焼き付けるので、後から catalog の価格を変えても過去の売上は動かない。

## 5. 販売停止

```bash
curl -s -X POST "$API/catalog/products/$PRODUCT/delist" \
  -H 'content-type: application/json' -d '{"reason":"seasonal"}'
sleep 3

# sales は参照コピーを更新して販売を弾く
post /sales/sales "{\"soldAt\":\"2026-09-11T11:00:00+09:00\",
  \"lines\":[{\"productId\":\"$PRODUCT\",\"lotCode\":\"PC-20260911\",
              \"quantity\":{\"amount\":1,\"unit\":\"piece\"}}]}"   # エラー

# catalog 側では消えない。過去の売上や製造実績から参照されるため
get "/catalog/products/$PRODUCT"         # sellable: false
```

## 6. 発注点割れ

```bash
post /inventory/stocktakes \
  "{\"countedAt\":\"2026-09-11T20:00:00+09:00\",
    \"ingredients\":[{\"ingredientId\":\"$FLOUR\",\"counted\":{\"amount\":300,\"unit\":\"g\"}}],
    \"productLots\":[]}"
sleep 3
get /purchasing/suggestions              # 発注提案ができている
```

棚卸は「在庫は棚卸で補正する近似値」という前提に対する唯一の正攻法の補正手段。発注点を割ると `inventory.ReorderPointBreached` → purchasing で**提案**が作られる。自動発注はしない（リードタイムと最小ロットが絡むので確定は人の判断）。

## 一括で確認する

```bash
make test-integration    # 上記と同じ流れを含む 77 本
```

## 開発者ツールから中を見る

```bash
make tools-up            # http://cloudbeaver.devtools.bakery.localhost/
```

`bakery_catalog` などモジュールのロールで接続すると、**自分のスキーマしか見えない**ことが確認できる。
