# コンテキスト間のイベント

契約の実体は [`src/shared/events.ts`](../../src/shared/events.ts)。このドキュメントはその読み方。

## 前提

- 状態変化の通知は **transactional outbox 経由のイベントのみ**（境界の強制 3/3）
- 同期の問い合わせは**相手の公開ユースケース経由のみ**（`src/modules/<m>/index.ts`）
- コンテキスト間の整合性は**結果整合**

## 一覧

| 発行元 | イベント | 購読先 | 購読側の処理 |
|---|---|---|---|
| purchasing | `purchasing.GoodsReceiptAccepted` | inventory | 原材料を入庫 |
| inventory | `inventory.ReorderPointBreached` | purchasing | 発注提案を作成 |
| production | `production.ProductionCompleted` | inventory | 原材料を消費し、製品ロットを入庫 |
| sales | `sales.SaleCompleted` | inventory | 製品を出庫 |
| sales | `sales.SaleCompleted` | production | 需要予測の入力として販売実績を記録 |
| catalog | `catalog.ProductDelisted` | production, sales | 参照している商品情報を更新 |

イベント名は `<発行元モジュール>.<イベント>`。発行元がひと目で分かるようにするため。`publishEvent()` は名前と発行元モジュールが食い違うと例外を投げる。

## 設計上の判断

### イベントに何を載せるか

**受け手が境界を越えずに処理を完結できる分だけ**載せる。逆に、載せなくても同期で引けるものは載せない。

- `production.ProductionCompleted` は消費した原材料の内訳 (`consumedIngredients`) を載せる。レシピは production の持ち物なので、inventory がレシピを引くと境界を越える。「レシピ×数量」の計算は発行側で終わらせる
- `catalog.ProductDelisted` は商品 ID と理由だけ。名前・価格・アレルゲン表示は `catalog.getProduct()` に同期で問い合わせる。イベントで運ぶのは「状態が変わった」という事実だけ

### 単位は基本単位に正規化する

`Quantity` は `{ amount, unit: "g" | "ml" | "piece" }`。kg や個装ではなく g で運ぶ。受け手に換算表を持たせない。

### 日付と時刻を分ける

賞味期限・製造日は `isoDate`（日付のみ）、発生時刻は `isoDatetime`（オフセット付き）。賞味期限に時刻を持たせると日跨ぎの解釈が実装ごとに割れる。

### 在庫がマイナスになるのを許容する

現実の在庫数は棚卸で補正する近似値であり、「製造完了と原材料消費が同一トランザクションで確定する」必要はない。マイナスはエラーではなく**アラート**として扱う（`inventory.listStockAlerts()`）。

## 配送の保証

```
発行側の業務トランザクション
  ├ 業務データを書く
  └ outbox に1行書く          ← 同じトランザクション。片方だけ成功しない

worker (別トランザクション)
  ├ outbox から未配信を取る (FOR UPDATE SKIP LOCKED)
  ├ 購読側ごとに handleOnce()
  │    ├ inbox に (event_id, handler) を insert ... on conflict do nothing
  │    ├ 既にあれば何もしない          ← 冪等
  │    └ 無ければハンドラを実行         ← inbox の記録と同じトランザクション
  └ published_at に印を付ける
```

- **at-least-once**。発行と配送が別トランザクションなので、配送は重複しうる
- 重複は購読側の `inbox` で吸収する。ハンドラの実行と処理済み記録が同じトランザクションなので、「処理したが記録できていない」は起きない
- 購読側が失敗すると発行側トランザクションごとロールバックし、`published_at` が付かないので次の周回で再送される。既に成功した別の購読者は `inbox` が弾く
- `FOR UPDATE SKIP LOCKED` は worker を複数本に増やしたときに同じ行を2本が掴まないため

## 購読の登録

`shared` はモジュールを知らない。購読は各モジュールの `index.ts` が `<module>Subscriptions` として公開し、**エントリポイント (`src/entrypoints/worker.ts`) が束ねる**。依存の向きを `entrypoints → modules → shared` の一方向に保つため。

購読側のハンドラは**購読側のロールの接続**で動く。したがってハンドラは相手のスキーマに触れられない。

自分の発行したイベントを自分で購読することは禁止（`createEventBus` が例外を投げる）。同一モジュール内なら直接呼べばよく、outbox を経由すると理由もなく結果整合になるため。

## 契約を変えるとき

`src/shared/events.ts` は全モジュールの共有物。ここが動くと並列に作業している全員が巻き込まれる。変更は発行元と全購読先の合意が要る。

## 動作確認

```bash
make test-integration    # tests/integration/outbox-relay.test.ts
```

配送経路そのものを固定するテストが 5 本ある（正常系 / 冪等 / 再送 / 発行元の検証 / 自己購読の禁止）。
