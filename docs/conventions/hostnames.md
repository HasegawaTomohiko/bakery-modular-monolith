# ホスト名規約

ローカルのサービスに届く URL を決める規約。`pnpm check:compose` が CI で強制する。

関連: [local-environment.md](./local-environment.md)

## 規約

| 対象 | ホスト名 | 例 |
|---|---|---|
| フロントエンド | `app.bakery.localhost` | `http://app.bakery.localhost/` |
| API | `api.bakery.localhost` | `http://api.bakery.localhost/sales/orders` |
| 開発者ツール | `<tool>.devtools.bakery.localhost` | `http://cloudbeaver.devtools.bakery.localhost/` |
| Traefik ダッシュボード | `traefik.localhost` | `http://traefik.localhost/dashboard/` |

ホスト名は Traefik のルーターラベルに書く。プロダクト側 compose の唯一の入口の宣言方法。

```yaml
labels:
  - traefik.enable=true
  - traefik.docker.network=dev-edge
  - traefik.http.routers.bakery-api.rule=Host(`api.bakery.localhost`)
  - traefik.http.routers.bakery-api.entrypoints=web
  - traefik.http.services.bakery-api.loadbalancer.server.port=3000
```

## `bakery` はプロダクトの名前空間

すべてのプロダクト側ホスト名は `.bakery.localhost` で終わる。`bakery` がプロダクトを表す名前空間。

いま Traefik はこのリポジトリの `edge/compose.yaml` にいるが、edge はプロジェクト名 (`dev-edge`) とライフサイクルを独立させてあり、将来「マシンに 1 つの共有 Traefik」に移行できる。そのとき他のプロダクトも同じ `*.localhost` 空間に同居することになる。

```
app.bakery.localhost                     ← このプロダクト
api.bakery.localhost
cloudbeaver.devtools.bakery.localhost
api.other-product.localhost              ← 別プロダクト (将来)
```

名前空間を最初から切ってあるので、**移行時にホスト名を書き換える必要がない**。逆に `api.localhost` のようなプロダクト名の無い名前を 1 つでも許すと、その日に衝突する。

## `devtools` は開発者ツール専用

CloudBeaver のような開発者ツールは `<tool>.devtools.bakery.localhost` に置き、`profiles: [tools]` で分離する。

```yaml
cloudbeaver:
  image: dbeaver/cloudbeaver:latest
  profiles: [tools]
  networks: [internal, edge]
  labels:
    - traefik.enable=true
    - traefik.http.routers.bakery-cloudbeaver.rule=Host(`cloudbeaver.devtools.bakery.localhost`)
```

分ける理由は 2 つ。

- **URL を見ただけでプロダクトかツールかが分かる。** 開発者ツールの UI は認証なしのものが多い。`devtools` の下にあるものは「ローカルの都合で動いている、本番には存在しないもの」だと一目で分かる
- **将来まとめて扱える。** ツールだけに認証をかける、ツールだけ別ネットワークに寄せる、といった操作が名前空間ひとつでできる

対応して、**プロダクトのサービスは `devtools` を名前に使えない**。`api.devtools.bakery.localhost` のようなホスト名は規約違反。

## Traefik ダッシュボードだけ `bakery` が付かない理由

Traefik ダッシュボードは `traefik.localhost`。`traefik.bakery.localhost` ではない。

**edge はプロダクトを知らないから。**

依存の向きは一方向で、edge は何にも依存せず、プロダクト側と devcontainer が edge にのみ依存する。edge がプロダクトのルーティングを知る手段は Docker ラベルの発見だけで、`bakery` という名前はどこにも書かれていない。

その edge が自分自身のダッシュボードに `bakery` を名乗ったら、edge がプロダクトを知っていることになる。共有 Traefik に移行した瞬間に嘘になる名前を、いま付ける理由はない。

ダッシュボードは「今このマシンで触れるサービスのカタログ」であり、プロダクトの一部ではなくローカル環境の一部。だから `traefik.localhost` に置く。

同じ理由で、edge 側の疎通確認用 `whoami` は例外的に `whoami.bakery.localhost` を使っているが、これは「プロダクト側のホスト名がちゃんと届くか」を確かめるためのダミーであり、`--profile verify` を付けたときだけ起動する。

## なぜ `*.localhost` なのか

Chrome・Edge・Firefox・curl は `*.localhost` を DNS に問い合わせずループバックに解決する。そのため各環境で必要なのは「`127.0.0.1:80` が Traefik に届くこと」だけで、**hosts ファイルも独自 DNS も要らない**。

ホスト・WSL・devcontainer のどこからでも同じ URL で同じサービスに届く、という要件をローカル設定なしで満たせる唯一の方法がこれ。詳細と既知の限界は [local-environment.md](./local-environment.md) にある。

## CI による強制

`pnpm check:compose` (`scripts/check-compose.ts`) が compose ファイルを読んで検査する。CI (`.github/workflows/ci.yaml`) で実行され、違反があれば落ちる。

### 検査するもの

| # | ルール | 対象 |
|---|---|---|
| 1 | `ports:` を書いてよいのは `edge/compose.yaml` だけ | edge 以外の全 compose ファイル |
| 2 | `profiles: [tools]` のサービスのホスト名は `<tool>.devtools.bakery.localhost` 形式 | プロダクト側 compose |
| 3 | `profiles: [tools]` を持たないサービスは `devtools` を使えない | プロダクト側 compose |
| 4 | プロダクトのホスト名は `.bakery.localhost` で終わる | プロダクト側 compose |
| 5 | `traefik.enable=true` のサービスは `edge` ネットワークに参加する | プロダクト側 compose |
| 6 | `traefik.enable` を持たないサービス (= ミドルウェア) は `edge` に参加しない | プロダクト側 compose |

ホスト名は Traefik ラベルの `` Host(`...`) `` から抽出する。ラベルはリスト形式 (`- k=v`) でもマップ形式 (`k: v`) でも読む。

### 対象ファイル

`compose*.yaml` / `compose*.yml` を再帰的に拾う。`compose.yaml` のほか、将来の `web/compose.yaml` なども自動的に対象になる。

- **`edge/` 配下は 1〜6 すべての対象外。** edge は `ports:` を書く唯一の場所であり、プロダクトを知らないので `traefik.localhost` を使う
- **`compose.override.yaml` は対象外。** gitignore してある個人用のファイル。ネイティブ DB クライアントのためにポートを開けたい場合はここに書く (チーム標準には含めない)

`ports:` の検査はサービス定義だけでなくドキュメント全体を歩くので、`x-app` のような YAML アンカーに書いても検出される。

### 違反すると CI がどう落ちるか

```
$ pnpm check:compose

compose 規約違反が 3 件あります。

compose.yaml
  ✖ [ports] services.api.ports (compose.yaml:49)
      `ports:` を書いてよいのは edge/compose.yaml だけです。入口は Traefik (edge) 経由にしてください。
      個人用にポートを開けたい場合は gitignore された compose.override.yaml を使ってください。
  ✖ [hostname] cloudbeaver (compose.yaml:80)
      `profiles: [tools]` のサービスのホスト名は `<tool>.devtools.bakery.localhost` 形式で
      なければなりません: `cloudbeaver.bakery.localhost`
  ✖ [network] postgres (compose.yaml:63)
      `traefik.enable=true` を持たないサービス (= ミドルウェア) を `edge` に出してはいけません。
      internal のみに参加させてください。

規約: docs/conventions/local-environment.md / docs/conventions/hostnames.md
```

### ローカルでの確認

```bash
pnpm check:compose
pnpm check           # CI と同じ一式 (make check でも同じ)
```
