# ローカル環境

## 基本方針

devcontainer は「ホスト PC をコンテナに入れたもの」である。ホストと同列で、**サービスネットワークの外にいる**。したがって devcontainer は、サービスの設定 (env/conf) もミドルウェアの接続情報も一切持たない。

devcontainer の利用は任意。ホストで開発しても devcontainer で開発しても、**同じ URL で同じサービスに届く**こと。

ローカル側の名前解決設定 (hosts ファイル、独自 DNS、外部 DNS サービス) を必要とする構成は採用しない。

## compose の分割

入口 (edge) とプロダクトを別の compose プロジェクトにする。依存の向きは一方向。

```
        devcontainer ─┐
                      ├─→ edge (dev-edge ネットワーク / Traefik)
      プロダクト compose ─┘
```

edge はプロダクトを知らない。Docker ラベルからルーティングを発見する。

| compose | プロジェクト名 | 性格 | 中身 |
|---|---|---|---|
| `edge/compose.yaml` | `dev-edge` | ローカルの都合。本番に持ち込まない | Traefik、`dev-edge` ネットワーク |
| `compose.yaml` | (ディレクトリ名) | 本番構造のローカル写像 | `api`, `worker`, `web`, `postgres`, 開発者ツール |

edge は当面このリポジトリ内に置くが、プロジェクト名とライフサイクルを独立させてある。将来複数プロダクトで共有する際に別リポジトリへ切り出せる。

## ネットワーク

| ネットワーク | 所有者 | 参加するもの |
|---|---|---|
| `dev-edge` | edge compose (`external: true` で参照される) | Traefik、入口に出すサービス、devcontainer |
| `internal` | プロダクト compose (固定名なし) | 全プロダクトサービス |

**ルール**

- 入口に出すもの (`api`, `web`, 開発者ツール) は `internal` と `dev-edge` の**両方**に参加する
- ミドルウェア (`postgres` 等) は `internal` **のみ**
- Traefik は `dev-edge` にのみ参加し、`--providers.docker.network=dev-edge` でターゲットを探す

## ポートの公開

**`ports:` を書いてよいのは `edge/compose.yaml` だけ。** プロダクト側 compose に `ports:` は一切書かない。CI (`pnpm check:compose`) がこれを強制する。

Traefik は `127.0.0.1:80` にバインドする。`0.0.0.0` にしない理由は、開発者ツールの UI が認証なしのものが多く、LAN に DB の中身を晒すため。

## ホスト名規約

| 対象 | ホスト名 |
|---|---|
| フロントエンド | `app.bakery.localhost` |
| API | `api.bakery.localhost` |
| 開発者ツール | `<tool>.devtools.bakery.localhost` |
| Traefik ダッシュボード | `traefik.localhost` |

`bakery` はプロダクトの名前空間。将来マシン共通の Traefik に移行してもそのまま使える。Traefik ダッシュボードだけ `bakery` を付けないのは、**edge はプロダクトを知らない**という原則のため。

詳細は [hostnames.md](./hostnames.md)。

## 名前解決の考え方

`*.localhost` を採用する。Chrome・Edge・Firefox・curl は `*.localhost` を DNS に問い合わせずループバックに解決する。そのため各環境で必要なのは「`127.0.0.1:80` が Traefik に届くこと」だけで、**名前解決の設定は不要**。

| 環境 | 必要な処理 |
|---|---|
| Mac | Traefik を `127.0.0.1:80` で公開するだけ。追加処理なし |
| WSL | 追加処理なし (下記の実測結果を参照) |
| devcontainer | `127.0.0.1:80` → `edge:80` への転送を1本置く (socat)。`edge` は Docker 組み込み DNS が解決する |

### WSL での実測結果 (2026-09-10)

「NAT モードの WSL2 は 127.0.0.1 バインドのポートを Windows 側 localhost に転送しないことがある」という既知の懸念があったため、実測した。

| 項目 | 値 |
|---|---|
| WSL バージョン | 2.7.11.0 |
| Windows | 10.0.26200 |
| Docker | ネイティブ Docker Engine 29.7.2 (Docker Desktop ではない) |
| `.wslconfig` | 無し (= NAT モード) |

**結果: 追加設定なしで Windows 側から届いた。**

```
# WSL 内
curl -H 'Host: whoami.bakery.localhost' http://127.0.0.1/   → 200
curl http://whoami.bakery.localhost/                         → 200

# Windows 側 (C:\Windows\System32\curl.exe)
curl.exe -H "Host: whoami.bakery.localhost" http://127.0.0.1/ → 200
curl.exe http://whoami.bakery.localhost/                      → 200
```

つまり NAT モードでも `localhostForwarding` が 127.0.0.1 バインドを拾っている。`networkingMode=mirrored` への切り替えは不要。

**もし将来届かなくなった場合**の対処を、優先順に記録しておく。

1. `%USERPROFILE%\.wslconfig` に `[wsl2]` / `networkingMode=mirrored` を書いて `wsl --shutdown`。ミラーモードでは 127.0.0.1 が Windows と共有されるため確実に届く
2. Windows 側で `netsh interface portproxy add v4tov4 listenport=80 connectaddress=<WSLのIP> connectport=80`
3. 最終手段として edge を `0.0.0.0:80` にバインドし、Windows Firewall で受信を拒否する。LAN 露出のトレードオフを受け入れることになるので、チーム標準にはしない

## 起動順

edge が先に起動している必要がある。以下の両方で先に実行する (冪等)。

- `make up` (プロダクト側)
- devcontainer の `initializeCommand`

```bash
docker compose -f edge/compose.yaml up -d
```

## 疎通確認

```bash
docker compose -f edge/compose.yaml --profile verify up -d
curl -s http://whoami.bakery.localhost/            # 200 が返ること
curl -s -o /dev/null -w '%{http_code}\n' http://nope.bakery.localhost/   # 404 (exposedbydefault=false)
curl -s -o /dev/null -w '%{http_code}\n' http://traefik.localhost/dashboard/  # 200
docker compose -f edge/compose.yaml --profile verify down whoami
```

`whoami` は `--profile verify` を付けたときだけ起動する疎通確認専用サービス。通常の `up` では起動しない。

## 既知の限界とトレードオフ

- **`*.localhost` を解決できないプログラムがある。** ブラウザや curl のような組み込みの `*.localhost` 解決を持たないプログラムは、OS のリゾルバ次第で解決できないことがある。入口を使うのは人間とブラウザ系ツールであり、サービス間通信は `internal` 上のサービス名で行うため実害は小さい。devcontainer で必要になれば glibc の `nss-myhostname` を入れて OS レベルで解決させる
- **devcontainer から Traefik を迂回できてしまう。** devcontainer と入口に出したサービスが同じ `dev-edge` に乗るため、devcontainer からサービスへ直接届く。ネットワークでは防げないので、「**入口の URL 以外で叩かない**」は規約で扱う
- **ネイティブ DB クライアント。** TablePlus・DataGrip 等で DB を見たい場合は、gitignore してある個人用 `compose.override.yaml` でポートを開ける。チーム標準には含めない

## 本番との線引き

- edge は本番に持ち込まない (CI でブラウザ E2E を回す場合のみ CI でも起動する)
- アプリケーションは edge 固有の前提に依存しないこと
  - `*.bakery.localhost` をコードに書かない。ベース URL は設定から受け取る
  - Traefik が付与する `X-Forwarded-*` の挙動を前提にしない

## devcontainer

`.devcontainer/` の構成は次のとおり。

| ファイル | 役割 |
|---|---|
| `Dockerfile` | mise + socat のみ。**DB クライアントも入れない** |
| `devcontainer.json` | edge への接続と転送の設定だけ。サービス設定は持たない |
| `edge-forward.sh` | `127.0.0.1:80` → `edge:80` の転送 (socat) |

**要点**

- `initializeCommand` で edge を先に起動する (冪等)
- `runArgs` の `--network=dev-edge` で入口と同じネットワークに乗る。プロダクトの `internal` には乗らない
- `--sysctl net.ipv4.ip_unprivileged_port_start=0` は、非 root ユーザーで 80 番を listen するため
- `postStartCommand` の `nohup` は、バックグラウンドプロセスが終了させられるのを防ぐため
- `workspaceMount` の target をホストと同じ絶対パスにしてある。docker-outside-of-docker で compose を動かしたとき、bind mount のパスがホストから見ても devcontainer から見ても同じ意味になる

**サービス設定を持たないことの確認**

```bash
grep -rniE 'postgres|password|DATABASE_URL|devpass|5432' .devcontainer/   # 0件であること
```

**動作確認**

```bash
# devcontainer 内で
curl -s http://api.bakery.localhost/health     # {"status":"ok"}
getent hosts postgres                          # 解決できないこと (internal の外に居る証明)
```

### 実測結果 (2026-09-11)

| 確認項目 | 結果 |
|---|---|
| 転送前に `127.0.0.1:80` へ届かないこと | 000 (期待どおり) |
| `edge-forward.sh` 起動後 `whoami.bakery.localhost` | 200 |
| `traefik.localhost/dashboard/` | 200 |
| `api.bakery.localhost/health` | 200 (ホストと同じ URL・同じ結果) |
| `getent hosts postgres` | 解決できない |
| `.devcontainer/` 内のサービス設定 | 0 件 |
