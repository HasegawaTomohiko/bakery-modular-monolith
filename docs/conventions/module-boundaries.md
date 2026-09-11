# モジュール境界

## なぜ境界を強制するのか

同じ「クロワッサン」でも、コンテキストごとに意味が違う。

| コンテキスト | 「クロワッサン」とは何か |
|---|---|
| 商品 (`catalog`) | 名前・価格・アレルゲン表示を持つ**販売物**。「税込 280 円、小麦・乳・卵を含む」 |
| 製造 (`production`) | 原材料と分量を持つ**レシピ**。「強力粉 60g、バター 30g、発酵 12 時間、1 天板 24 個取り」 |
| 在庫 (`inventory`) | 「今朝 6 時に焼いた 24 個」という**ロット**。当日限りで、売れ残りは廃棄になる |
| 販売 (`sales`) | レシートの 1 行。「7:42 に 2 個、560 円」 |

これらを 1 つの `Croissant` テーブル・1 つのクラスに押し込むと、次の日から破綻が始まる。価格改定のたびに製造計画が壊れ、レシピを直すとレシートの過去の金額が変わる。「商品」に賞味期限カラムが生え、「在庫」に価格カラムが生え、どのカラムがどの文脈で有効なのかを誰も説明できなくなる。

境界は、放っておくと必ず溶ける。「急いでいるから今日だけ `production` から `catalog.items` を JOIN する」が 1 回通れば、それが前例になる。だから**人に期待せず、仕組みで守らせる**。3 層すべてで強制し、違反したら CI が落ちる。

## モジュール一覧

| コンテキスト | モジュール | DB スキーマ | DB ロール | 分類 |
|---|---|---|---|---|
| 商品 | `catalog` | `catalog` | `bakery_catalog` | 支援 |
| 製造 | `production` | `production` | `bakery_production` | コア |
| 在庫 | `inventory` | `inventory` | `bakery_inventory` | 支援 |
| 購買 | `purchasing` | `purchasing` | `bakery_purchasing` | 支援 |
| 販売 | `sales` | `sales` | `bakery_sales` | 支援 |

## 境界の強制 (3 層)

| 層 | 強制する手段 | CI コマンド |
|---|---|---|
| 1. コード | dependency-cruiser (`.dependency-cruiser.cjs`) | `pnpm check:boundaries` |
| 2. DB | PostgreSQL のスキーマ + ロール権限 (実行時) と SQL の静的検査 | `pnpm check:migrations` |
| 3. 通信 | 公開ユースケースと transactional outbox (層 1 の帰結として強制される) | `pnpm check:boundaries` |

### 1. コード

**モジュールの公開面は `index.ts` と `http/routes.ts` の 2 つだけ。**

```
src/modules/catalog/
  domain/        # 非公開
  application/   # 非公開
  infra/         # 非公開
  http/routes.ts # 公開 (エントリポイントが束ねるためだけ)
  index.ts       # 公開 (他モジュールが見てよい唯一の面)
```

- `index.ts` — 公開ユースケースとイベント型。他モジュールはここしか import できない
- `http/routes.ts` — `src/entrypoints/api.ts` が `app.route('/catalog', catalogRoutes)` で束ねるための面。**他モジュールから import してはいけない**

`.dependency-cruiser.cjs` の 5 つのルールがこれを機械可読にしている。

| ルール | 禁止すること |
|---|---|
| `no-cross-module-internals` | 他モジュールの `domain` / `application` / `infra` / `http` への直接 import |
| `no-module-to-entrypoint` | モジュールが `src/entrypoints/` を知ること (依存の向きは entrypoints → modules) |
| `no-shared-to-module` | `src/shared/` が個別モジュールに依存すること |
| `no-module-internals-from-outside` | モジュール外から `index.ts` / `http/routes.ts` 以外に入ること |
| `no-circular` | 循環依存 |

### 2. DB

**スキーマをまたぐ JOIN と外部キーは、書けても通らない。**

`db/bootstrap/001_schemas_and_roles.sql` が admin 接続でスキーマとロールを作る。

- スキーマの所有者はそのモジュールのロール
- 他モジュールのスキーマには `USAGE` すら与えない。他スキーマのテーブルを参照した瞬間に権限エラーになる
- `search_path` は接続文字列ではなくロール側に持たせる (`ALTER ROLE bakery_catalog SET search_path = catalog`)
- `public` スキーマは閉じる。誰でも書ける置き場があると境界の抜け道になる

アプリは `DATABASE_URL_<MODULE>` でモジュールごとの接続を使う (`compose.yaml` 参照)。

ただしロールによる強制は**マイグレーションを流して初めて分かる**。CI で DB を起動せずに落とすため、`pnpm check:migrations` が `src/modules/<m>/infra/db/migrations/**/*.sql` を静的に検査する。

| 検出するもの | 理由 |
|---|---|
| 他モジュールのスキーマ名を `<schema>.` の形で参照している | 境界をまたぐ参照。実行時もロールが拒否する |
| `CREATE SCHEMA` / `CREATE ROLE` / `ALTER ROLE` / `GRANT` | スキーマとロールは `db/bootstrap/` の admin 用 SQL の責務 |
| `SET search_path` | 自スキーマはロール既定の `search_path` で決まる。マイグレーションで動かさない |

SQL コメント (`--` と `/* */`、入れ子も含む) は検査対象から外してある。「`production.batches` を参照してはいけない」とコメントに書いても落ちない。逆に、文字列リテラルの中は検査対象に残してある (`EXECUTE 'SELECT ... FROM production.recipes'` のような動的 SQL で抜けられないようにするため)。

`migrations` ディレクトリがまだ無いモジュールは「対象なし」として飛ばす。

### 3. 通信

モジュール間のやり取りは 2 通りしかない。

**同期の問い合わせ — 公開ユースケース経由のみ。**

相手の `index.ts` が export するユースケースを呼ぶ。相手のリポジトリや DB を直接触ることはできない (層 1 と層 2 が塞いでいる)。

**状態変化の通知 — transactional outbox 経由のイベントのみ。**

状態を変えた側は、自スキーマの業務テーブルと outbox テーブルを**同一トランザクション**で書く。`worker` が outbox をリレーし、購読側が受け取る。相手のユースケースを同期で呼んで状態を変えさせてはいけない。

| 発行元 | イベント | 購読先 | 購読側の処理 |
|---|---|---|---|
| purchasing | 検収済 | inventory | 原材料を入庫 |
| inventory | 発注点割れ | purchasing | 発注提案を作成 |
| production | 製造完了 | inventory | レシピ×数量分の原材料を消費し、製品ロットを入庫 |
| sales | 販売確定 | inventory | 製品を出庫 |
| sales | 販売確定 | production | 需要予測の入力として販売実績を記録 |
| catalog | 販売停止 等 | production, sales | 参照している商品情報を更新 |

購読側が知ってよいのは、発行元の `index.ts` が export する**イベントの型**だけ。ペイロードの中身は発行元の内部モデルではなく、契約として設計する。

コンテキストをまたぐ画面 (例: 今日の在庫と販売状況) は JOIN で作らない。イベントから組み立てる参照用モデルとして持つ。

## なぜ結果整合なのか

コンテキスト間の整合性は結果整合とする。「製造完了と原材料消費が同一トランザクションで確定する」必要はない。

現実のパン屋を見れば理由は明らかで、**在庫数は棚卸で補正する近似値**でしかない。粉は袋から出るときにこぼれるし、焼成中に落ちたクロワッサンは誰も記録しない。試作に使った 200g も伝票には残らない。DB のトランザクションをどれだけ厳密にしても、棚にある本当の数とは一致しない。

一致しないものを一致させるために全モジュールを 1 つのトランザクションに縛ると、失うものの方が大きい。販売時に製造モジュールのロックを待つことになり、レジが止まる。

したがって:

- **在庫が一時的にマイナスになることを許容する。** 販売確定イベントが先に届き、製造完了イベントが後から届けば、その瞬間の在庫は負になる
- **マイナスはエラーではなくアラートとして扱う。** 処理は止めない。「イベントの遅延」か「記録漏れ」かは人間が判断する
- **正解は棚卸で決める。** 棚卸が実測値を書き込み、そこが新しい基準になる

## 違反すると CI がどう落ちるか

### 層 1: 他モジュールの内部を import した

```ts
// src/modules/production/application/plan-baking.ts
import { findItem } from "../../catalog/infra/item-repository.ts";
```

```
$ pnpm check:boundaries

  error no-cross-module-internals: src/modules/production/application/plan-baking.ts →
      src/modules/catalog/infra/item-repository.ts
    他モジュールへは index.ts 経由でのみ依存できる。
    domain/application/infra/http を直接 import してはいけない。

✖ 1 dependency violation (1 error, 0 warnings). 42 modules, 118 dependencies cruised.
```

**直し方**: `catalog/index.ts` が export する公開ユースケースを呼ぶ。そこに無いなら、`catalog` 側に公開ユースケースとして足すか、そもそも同期で引くべき情報なのかを疑う。

### 層 2: マイグレーションが他スキーマに触れた

```sql
-- src/modules/catalog/infra/db/migrations/0002_link_recipe.sql
ALTER TABLE catalog.items
  ADD COLUMN recipe_id uuid REFERENCES production.recipes (id);
```

```
$ pnpm check:migrations

マイグレーションの境界違反が 1 件あります。

  ✖ src/modules/catalog/infra/db/migrations/0002_link_recipe.sql:2:33
      ADD COLUMN recipe_id uuid REFERENCES production.recipes (id);
      `catalog` のマイグレーションが他モジュールのスキーマ `production` に触れています。
      スキーマをまたぐ参照は DB ロールでも拒否されます。
      必要な情報はイベントか公開ユースケース経由で受け取ってください。

規約: docs/conventions/module-boundaries.md
```

CI をすり抜けたとしても、`make migrate` が `permission denied for schema production` で落ちる。静的検査は「DB を起動しなくても、書いた直後に分かる」ためのもの。

**直し方**: 外部キーを張らない。`recipe_id` を単なる uuid として持ち、整合性は `production` のイベントで保つ。そもそも `catalog` がレシピを知る必要があるかを疑う。

### 層 3: 相手のユースケースで状態を変えた

```ts
// src/modules/sales/application/confirm-sale.ts
import { inventory } from "../../inventory/index.ts";
await inventory.decreaseStock(itemId, quantity); // 同期で相手の状態を変えている
```

これは層 1 のルールは通る (`index.ts` 経由なので dependency-cruiser は文句を言わない)。**機械では止まらないので、レビューで止める。**

**直し方**: `sales` は「販売確定」イベントを outbox に書くだけにする。在庫を減らすかどうか、どう減らすかは `inventory` が決める。

## ローカルでの確認

```bash
pnpm check          # CI と同じ一式 (make check でも同じ)
pnpm check:boundaries
pnpm check:migrations
```

## 層 2 (DB) の実測結果 (2026-09-11)

`bakery_catalog` ロールで接続し、境界が物理的に成立していることを確認した。

```bash
psqlc() { docker compose exec -T -e PGPASSWORD=devpass postgres psql -U "$1" -d bakery -Atc "$2"; }
```

| # | 実行内容 | 期待 | 結果 |
|---|---|---|---|
| 1 | `select count(*) from catalog.outbox` | 成功 | `0` |
| 2 | `select count(*) from production.outbox` | 失敗 | `permission denied for schema production` |
| 3 | `create table production.x(id int)` | 失敗 | `permission denied for schema production` |
| 4 | `create table catalog.fk_probe(id uuid references production.outbox(id))` | 失敗 | `permission denied for schema production` |
| 5 | `select 1 from catalog.outbox c join sales.outbox s on c.id = s.id` | 失敗 | `permission denied for schema sales` |
| 6 | `create table catalog.own_probe(id int)` | 成功 | `CREATE TABLE` |

**スキーマをまたぐ JOIN と外部キーは、規約ではなく PostgreSQL の権限で書けない。**

### マイグレーションの適用方法についての注記

`scripts/migrate.ts` は drizzle 標準の `migrate()` を使わず、`readMigrationFiles()` と同等の適用ループを自前で持っている。標準の migrator は履歴テーブル用に必ず `CREATE SCHEMA IF NOT EXISTS` を発行し、PostgreSQL はスキーマが既存でもデータベースの `CREATE` 権限を先に検査するため、モジュールのロールでは `permission denied for database bakery` になる。

ここでロール権限を緩めると境界強制そのものが無意味になるので、適用ロジック側を合わせた。同じ理由で、drizzle-kit が生成する `CREATE SCHEMA "<m>";` は生成物から取り除いてある。スキーマの作成は `db/bootstrap/` の admin 接続の責務。
