# bakery

パン屋をロールモデルにしたモジュラーモノリス。Hono + TypeScript + PostgreSQL。

このリポジトリの目的は2つある。

1. **ドメイン境界を3層（コード・DB・通信）で強制する。** 規約を人に守らせるのではなく、CI とデータベースの権限で違反をエラーにする
2. **ホスト・WSL・devcontainer のどこからでも同じ URL で届くローカル環境を作る。** hosts ファイルも独自 DNS も使わない

## 動かす

```bash
make up          # edge (Traefik) → プロダクト
make migrate     # スキーマ・ロールの作成とマイグレーション

curl http://api.bakery.localhost/health      # {"status":"ok"}
open http://app.bakery.localhost/            # ダッシュボード
open http://traefik.localhost/dashboard/     # 今ローカルで触れるものの一覧
```

手で一通り動かす手順は [docs/walkthrough.md](docs/walkthrough.md)。出発点になった設計メモは [docs/design.md](docs/design.md)。

```bash
make help                # ターゲット一覧
make tools-up            # CloudBeaver 等の開発者ツール
make check               # CI と同じチェック
make test-integration    # DB を使うテスト
make clean               # volume ごと消す
```

## ドメイン

パン屋は**当日焼いて当日売り切る見込み生産**で、製品の寿命は基本1日。売上と廃棄ロスを分けるのは「今日何を何個焼くか」という製造計画で、そこがコアドメイン。

| コンテキスト | モジュール | 分類 | 責務 |
|---|---|---|---|
| 商品 | `catalog` | 支援 | 販売用の商品定義、価格、販売状態、表示情報 |
| 製造 | `production` | **コア** | 製造計画、レシピ、製造実績 |
| 在庫 | `inventory` | 支援 | 原材料在庫と製品ロット、発注点 |
| 購買 | `purchasing` | 支援 | 仕入先、発注、入荷・検収 |
| 販売 | `sales` | 支援 | 店頭販売、予約注文、売上 |

同じ「クロワッサン」でもコンテキストごとに意味が違う。

- `catalog` では **販売物**（名前・価格・アレルゲン表示を持つ）
- `production` では **レシピ**（原材料と分量を持つ）
- `inventory` では **ロット**（今朝焼いた24個）

1つのモデルに押し込まない。これが境界を引く理由そのもの。

## 境界の強制（3層）

規約は [docs/conventions/module-boundaries.md](docs/conventions/module-boundaries.md)。

### 1. コード

他モジュールへは相手の `index.ts` 経由でのみ依存できる。`domain/` `application/` `infra/` は外から見えない。

```bash
pnpm check:boundaries    # dependency-cruiser
```

### 2. DB

PostgreSQL のスキーマをモジュールごとに分け、モジュールごとの DB ロールに**自スキーマの権限だけ**を与える。

```
$ psql -U bakery_catalog -c 'select * from production.outbox'
ERROR:  permission denied for schema production
```

**スキーマをまたぐ JOIN と外部キーは規約ではなく権限で書けない。** マイグレーションもそのモジュールのロールで実行するので、自スキーマ外に触れるマイグレーションは実行そのものが失敗する。

```bash
pnpm check:migrations    # 静的検査（読み取りも潰す）
```

### 3. 通信

- 同期の問い合わせ → 相手の公開ユースケース経由のみ
- 状態変化の通知 → transactional outbox 経由のイベントのみ

契約は [`src/shared/events.ts`](src/shared/events.ts)、解説は [docs/conventions/events.md](docs/conventions/events.md)。

| 発行元 | イベント | 購読先 |
|---|---|---|
| purchasing | 検収済 | inventory |
| inventory | 発注点割れ | purchasing |
| production | 製造完了 | inventory |
| sales | 販売確定 | inventory, production |
| catalog | 販売停止 | production, sales |

整合性は**結果整合**。在庫は棚卸で補正する近似値であり、一時的にマイナスになり得ることを許容してアラートとして扱う。

## 参照モデル

コンテキストをまたぐ画面（今日の在庫と販売状況）は JOIN では作れない。スキーマをまたぐ権限が無いのだから当然で、そこを緩めるのは境界を壊すこと。

代わりに `readmodel` スキーマに**イベントから投影した**参照用モデルを持つ。`src/readmodel/` から `src/modules/` への import は CI で禁止している（依存させたら、結局そこが JOIN の代わりになる）。

```
GET /dashboard/daily/2026-09-11
{"totals":{"producedPieces":60,"soldPieces":45,"leftoverPieces":15,
           "wasteRatePercent":25,"salesJpy":13680}, ...}
```

## ローカル環境

規約は [docs/conventions/local-environment.md](docs/conventions/local-environment.md)。

devcontainer は「ホスト PC をコンテナに入れたもの」。ホストと同列で、**サービスネットワークの外にいる**。サービスの設定もミドルウェアの接続情報も一切持たない。

```
        devcontainer ─┐
                      ├─→ edge (dev-edge / Traefik) ─→ api, web, 開発者ツール
   プロダクト compose ─┘                                        │
                                                        internal (postgres)
```

- 入口は `edge/compose.yaml` の Traefik だけ。**プロダクト側 compose に `ports:` は書かない**（`pnpm check:compose` が強制）
- `*.localhost` はブラウザと curl が DNS を引かずにループバックへ解決する。各環境で必要なのは「`127.0.0.1:80` が Traefik に届くこと」だけ
- devcontainer は `127.0.0.1:80 → edge:80` の転送を socat で1本置く

| 対象 | ホスト名 |
|---|---|
| フロントエンド | `app.bakery.localhost` |
| API | `api.bakery.localhost` |
| 開発者ツール | `<tool>.devtools.bakery.localhost` |
| Traefik | `traefik.localhost` |

## 構成

```
edge/compose.yaml        入口。独立した compose プロジェクト。本番に持ち込まない
compose.yaml             プロダクト。本番構造のローカル写像
.devcontainer/           mise と socat だけ。サービス設定を持たない
db/bootstrap/            スキーマとロール（admin 接続で実行）
src/
  modules/<m>/
    domain/              エンティティ・値オブジェクト
    application/         ユースケース（トランザクション境界）
    infra/               リポジトリ・drizzle スキーマ・マイグレーション
    http/routes.ts       Hono のルート（@hono/zod-openapi）
    index.ts             公開API（ここだけが外から見える）
  shared/                events / outbox / inbox / event-bus / db
  readmodel/             イベントからの投影。モジュールではない
  entrypoints/
    api.ts               全モジュールのルーターを束ねる
    worker.ts            outbox リレーと購読の登録
web/                     Vite + React + hc RPC
scripts/check-*.ts       規約の CI チェック
```

`api` と `worker` は同じコードベースで、エントリポイントだけが違う。

## ローカル専用の値について

`compose.yaml` と `db/bootstrap/` に `devpass` というパスワードが平文で入っている。これは**ローカル開発専用**で、意図的にリポジトリに含めてある。

- `postgres` は `internal` ネットワークにのみ居て、`ports:` を公開していない。ホストからも LAN からも届かない
- Traefik は `127.0.0.1:80` にバインドしている。`0.0.0.0` にしないのは、認証の無い開発者ツールの UI を LAN に晒さないため
- 本番では別途ロール管理を行う前提。ここに本番の資格情報を書かないこと

## ツールチェーン

`mise.toml` が唯一の情報源。ホスト・devcontainer・コンテナ・CI が同じ定義を共有する。

| | |
|---|---|
| Node / pnpm | mise で固定 |
| TypeScript | 6.x（dependency-cruiser が 7 未対応のため） |
| ORM | Drizzle（モジュールごとに config とマイグレーション系列を分離） |
| Lint / Format | Biome |
| Test | Vitest（`unit` は DB 不要、`integration` はコンテナ内） |
