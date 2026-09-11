# 設計ドキュメント

このリポジトリの出発点になった設計メモ。**実装より前に書かれたもの**で、ここに書かれた意図がコードと CI にどう落ちたかは [README](../README.md) と [docs/conventions/](conventions/) を参照。

実装の過程で変えた判断もある（TypeScript のバージョン固定、drizzle の migrator を使わない理由など）。それらは README の「計画から変えた点」と各規約ドキュメントに記録してある。

---

## 1. 目的

パン屋さんをロールモデルに、Hono で Web アプリを作る。目的は次の2つ。

- ドメイン境界がコード・DB・通信の3層で強制されたモジュラーモノリスを実装すること
- 「devcontainer はホストPCをコンテナに入れたもの」という整理に基づき、ホスト・WSL・devcontainer のどこからでも同じURLでサービスに届くローカル環境を構築すること

## 2. 前提と未決事項

### 前提
- 「購買」は原材料の仕入れ(仕入先への発注・入荷・検収)を指す。お客さんへの販売は「販売」コンテキストとして別に扱う
- 実行環境はコンテナ(Node.js)を前提とする
- DB は PostgreSQL
- ツールチェーンのバージョンは mise で固定し、ホストと devcontainer で共有する

### 未決事項(計画時に確認・提案すること)
- デプロイ先。Cloudflare Workers + D1 にする場合、スキーマとロールによる境界強制ができないため、モジュールごとに D1 を分ける設計に変わる
- 店舗は1店舗か複数店舗か(在庫のロケーションモデルに影響する)
- フロントエンドの技術選定(`web` サービスの中身)
- ORM/マイグレーションツール。スキーマ単位・ロール単位の運用に対応できることを条件に候補を比較して提案すること

---

## 3. ドメイン

### パン屋というドメインの特徴
- 当日焼いて当日売り切る見込み生産。製品の寿命は基本1日
- 売上と廃棄ロスを分けるのは「今日何を何個焼くか」という製造計画。ここがコアドメイン
- 同じ「クロワッサン」でもコンテキストごとに意味が違う。商品では名前・価格・アレルゲン表示を持つ販売物、製造では原材料と分量を持つレシピ、在庫では「今朝焼いた24個」というロット。1つのモデルに押し込まないこと

### コンテキスト

| コンテキスト | モジュール名 | 分類 | 責務 |
|---|---|---|---|
| 商品 | `catalog` | 支援 | 販売用の商品定義、価格、販売状態、表示情報 |
| 製造 | `production` | コア | 製造計画、レシピ、製造実績 |
| 在庫 | `inventory` | 支援 | 原材料在庫と製品ロット、発注点 |
| 購買 | `purchasing` | 支援 | 仕入先、発注、入荷・検収 |
| 販売 | `sales` | 支援 | 店頭販売、予約注文、売上 |

原材料在庫(g/kg 単位、日〜週単位の賞味期限)と製品在庫(個数、当日限り、廃棄あり)は性質が大きく違うため、同じ `inventory` 内でもモデルを分けること。

### コンテキスト間のイベント

| 発行元 | イベント | 購読先 | 購読側の処理 |
|---|---|---|---|
| purchasing | 検収済 | inventory | 原材料を入庫 |
| inventory | 発注点割れ | purchasing | 発注提案を作成 |
| production | 製造完了 | inventory | レシピ×数量分の原材料を消費し、製品ロットを入庫 |
| sales | 販売確定 | inventory | 製品を出庫 |
| sales | 販売確定 | production | 需要予測の入力として販売実績を記録 |
| catalog | 販売停止 等 | production, sales | 参照している商品情報を更新 |

コンテキスト間の整合性は結果整合とする。現実の在庫数は棚卸で補正する近似値であり、「製造完了と原材料消費が同一トランザクションで確定する」必要はない。在庫が一時的にマイナスになり得ることを許容し、アラートとして扱う。

---

## 4. アプリケーションアーキテクチャ

### 構成
Hono の単一アプリケーションに全モジュールを載せるモジュラーモノリス。`api` と `worker` は同じコードベースで、エントリポイントだけが異なる。

```
src/
  modules/
    catalog/ production/ inventory/ purchasing/ sales/
      domain/        # エンティティ・値オブジェクト
      application/   # ユースケース
      infra/         # リポジトリ
      http/          # Hono のルート
      index.ts       # 公開API(ユースケースとイベント型のみ)
  shared/            # outbox・イベント基盤・DB接続
  entrypoints/
    api.ts           # app.route('/sales', salesRoutes) のように束ねる
    worker.ts        # outbox リレーとイベント購読
```

### 境界の強制(3層)
1. **コード**: 他モジュールの `index.ts` 以外からの import を dependency-cruiser または eslint-plugin-boundaries で禁止し、CI でエラーにする
2. **DB**: PostgreSQL のスキーマをモジュールごとに分け(`catalog`, `production`, ...)、モジュールごとの DB ロールに自スキーマの権限のみ与える。スキーマをまたぐ JOIN と外部キーは物理的に書けない状態にする
3. **通信**: 同期の問い合わせは公開ユースケース経由のみ。状態変化の通知は transactional outbox 経由のイベントのみ

### API
- `@hono/zod-openapi` でスキーマ先行にする
- フロントエンドからは `hc` の RPC クライアントで型安全に呼ぶ
- コンテキストをまたぐ画面(例: 今日の在庫と販売状況)は JOIN で作らず、イベントから組み立てる参照用モデルとして持つ

---

## 5. ローカル環境

### 基本方針
- devcontainer は「ホストPCをコンテナに入れたもの」。ホストと同列で、サービスネットワークの外にいる。サービスの設定(env/conf)やミドルウェアの接続情報を一切持たない
- devcontainer の利用は任意。ホストで開発しても devcontainer で開発しても、同じURLで同じサービスに届くこと
- ローカル側の名前解決設定(hosts ファイル、独自 DNS、外部 DNS サービス)を必要とする構成は採用しない

### compose の分割
入口(edge)とプロダクトを別の compose プロジェクトにする。依存の向きは一方向で、edge は何にも依存せず、プロダクト側と devcontainer が edge にのみ依存する。edge はプロダクトを知らず、Docker ラベルからルーティングを発見する。

| compose | 置き場所 | 性格 | 中身 |
|---|---|---|---|
| edge | `edge/compose.yaml`(独立プロジェクト `name: dev-edge`) | ローカルの都合。本番に持ち込まない | Traefik、`dev-edge` ネットワーク |
| プロダクト | `compose.yaml` | 本番構造のローカル写像 | `api`, `worker`, `web`, `postgres`, 開発者ツール |

edge は当面リポジトリ内に置くが、プロジェクト名とライフサイクルを独立させ、将来複数プロダクトで共有する際に別リポジトリへ切り出せるようにする。

### ネットワーク
- `dev-edge`: edge compose が作成・所有する。プロダクト側と devcontainer は `external: true` で参照する
- `internal`: プロダクト側 compose 内のネットワーク。誰からも名前で参照されないため固定名は不要
- ルール: 入口に出すもの(`api`, `web`, 開発者ツール)は `internal` と `dev-edge` の両方に参加する。ミドルウェア(`postgres` 等)は `internal` のみ
- Traefik は `dev-edge` にのみ参加し、`--providers.docker.network=dev-edge` でターゲットを探す

### edge compose の要点
```yaml
name: dev-edge
services:
  traefik:
    image: traefik:v3
    ports: ["127.0.0.1:80:80"]
    command:
      - --entrypoints.web.address=:80
      - --providers.docker.network=dev-edge
      - --providers.docker.exposedbydefault=false
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      edge:
        aliases: [edge]
networks:
  edge:
    name: dev-edge
```
- `127.0.0.1` にバインドする。開発者ツールの UI は認証なしのものが多く、`0.0.0.0` だと LAN に DB の中身を晒すため
- Traefik ダッシュボードを有効にし、「今ローカルで触れるツールのカタログ」として使えるようにする

### プロダクト側 compose の要点
```yaml
networks:
  edge: { external: true, name: dev-edge }
  internal: {}
services:
  api:
    networks: [internal, edge]
    labels:
      - traefik.enable=true
      - traefik.http.routers.bakery-api.rule=Host(`api.bakery.localhost`)
  postgres:
    networks: [internal]
  cloudbeaver:
    profiles: [tools]
    networks: [internal, edge]
    labels:
      - traefik.enable=true
      - traefik.http.routers.bakery-cloudbeaver.rule=Host(`cloudbeaver.devtools.bakery.localhost`)
```
- 設定はサービスごとに compose 定義(または `env_file`)で持つ。本番の ECS タスク定義単位の設定と構造をそろえる意図
- 開発者ツールは `profiles: [tools]` で分離し、必要な時だけ起動する

### ホスト名規約
| 対象 | ホスト名 |
|---|---|
| フロントエンド | `app.bakery.localhost` |
| API | `api.bakery.localhost` |
| 開発者ツール | `<tool>.devtools.bakery.localhost` |

`bakery` はプロダクトの名前空間。将来マシン共通の Traefik に移行してもそのまま使える。

### 名前解決の考え方
- `*.localhost` を採用する理由: Chrome・Edge・Firefox・curl は `*.localhost` を DNS に問い合わせずループバックに解決する。そのため各環境で必要なのは「`127.0.0.1:80` が Traefik に届くこと」だけで、名前解決の設定は不要
- **Mac**: Traefik を `127.0.0.1:80` で公開するだけ。追加処理なし
- **WSL**: Docker Desktop の WSL 統合でも WSL 内に直接入れた Docker Engine でも、公開ポートは WSL 内の `localhost` に届く。Windows 側ブラウザからは WSL の localhost 転送で届く。ネットワーキングモードで挙動が変わるため、動作確認手順に含めること
- **devcontainer**: devcontainer 内の `localhost` は自分自身を指すため、`127.0.0.1:80` から `edge:80` への転送を1本置く。`edge` は Docker 組み込み DNS が解決するのでローカル設定に依存しない

```jsonc
// devcontainer.json
"initializeCommand": "docker compose -f edge/compose.yaml up -d",
"runArgs": [
  "--network=dev-edge",
  "--sysctl", "net.ipv4.ip_unprivileged_port_start=0"
],
"postStartCommand": "nohup .devcontainer/edge-forward.sh >/dev/null 2>&1 &"
```
```sh
# .devcontainer/edge-forward.sh
socat TCP-LISTEN:80,bind=127.0.0.1,fork,reuseaddr TCP:edge:80
```
- 非 root ユーザーで 80 番を listen するため `ip_unprivileged_port_start=0` を設定する
- `nohup` は postStartCommand で起動したバックグラウンドプロセスが終了させられるのを防ぐため
- devcontainer のイメージに socat を入れる

### 起動順
- edge が先に起動している必要がある。devcontainer の `initializeCommand` とプロダクト側の `make up` の両方で `docker compose -f edge/compose.yaml up -d` を先に実行する(冪等)

### 既知の限界とトレードオフ
- ブラウザや curl のような組み込みの `*.localhost` 解決を持たないプログラムは、OS のリゾルバ次第で解決できないことがある。入口を使うのは人間とブラウザ系ツールであり、サービス間通信は `internal` 上のサービス名で行うため実害は小さい。devcontainer で必要になれば glibc の `nss-myhostname` を入れて OS レベルで解決させる
- devcontainer と入口に出したサービスが同じ `dev-edge` に乗るため、devcontainer から Traefik を経由せずサービスへ直接届いてしまう。ネットワークでは防げないので、「入口の URL 以外で叩かない」は規約で扱う
- DB をネイティブクライアント(TablePlus、DataGrip 等)で見たい場合は、gitignore した個人用 `compose.override.yaml` でポートを開ける。チーム標準には含めない

### 本番との線引き
- edge は本番に持ち込まない(CI でブラウザ E2E を回す場合のみ CI でも起動する)
- アプリケーションは edge 固有の前提に依存しないこと。`*.bakery.localhost` をコードに書かず、ベース URL は設定から受け取る。Traefik が付与する `X-Forwarded-*` の挙動を前提にしない

---

## 6. 規約の強制(CI)

人に期待せず仕組みで守らせる。以下を CI チェックとして実装すること。

- モジュール境界違反の import を検出してエラーにする
- edge 以外の compose で `ports:` が書かれていたらエラーにする
- `profiles: [tools]` のサービスは `*.devtools.bakery.localhost`、それ以外のサービスは `devtools` 配下の使用を禁止する
- マイグレーションが自スキーマ外のオブジェクトに触れていないことを確認する(方法は計画時に提案すること)

規約本文は `docs/conventions/` に置く。

---

## 7. フェーズ案

計画時にこの案を検証し、必要なら組み替えて提示すること。

1. **edge**: `edge/compose.yaml` を作成し、`traefik/whoami` を `whoami.bakery.localhost` に出して、ホスト・WSL・devcontainer の3環境から同じ URL で届くことを確認する
2. **プロダクトの骨組み**: Hono の `api`/`worker` エントリポイント、PostgreSQL のスキーマとロール、マイグレーション、5モジュールの空の雛形、境界チェックと compose チェックの CI
3. **devcontainer**: 転送スクリプトを含む devcontainer を用意し、サービス設定を一切持たないことを確認する
4. **ドメイン実装**: `catalog` → `purchasing`/`inventory` → `production` → `sales` の順で実装し、outbox 経由のイベント連携を通す
5. **参照モデルとフロントエンド**: コンテキスト横断のダッシュボード用参照モデルと `web`

各フェーズの完了条件には、動作確認のコマンドまたは手順を含めること。
