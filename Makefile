# edge は何にも依存しない。プロダクトと devcontainer が edge に依存する。
# したがって edge は常に先に起動する (冪等)。
EDGE := docker compose -f edge/compose.yaml

.PHONY: help up down logs ps tools-up tools-down edge-up edge-down edge-verify migrate check test-integration clean

help:
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-12s %s\n", $$1, $$2}'

edge-up: ## 入口 (Traefik) を起動する
	$(EDGE) up -d

edge-down: ## 入口を停止する
	$(EDGE) down

edge-verify: ## whoami で入口の疎通を確認する
	$(EDGE) --profile verify up -d
	@curl -fsS -o /dev/null -w 'whoami.bakery.localhost -> %{http_code}\n' http://whoami.bakery.localhost/
	@curl -fsS -o /dev/null -w 'traefik.localhost      -> %{http_code}\n' http://traefik.localhost/dashboard/
	$(EDGE) --profile verify stop whoami

up: edge-up ## edge → プロダクトの順に起動する
	docker compose up -d --build

down: ## プロダクトを停止する (edge は残す)
	docker compose down

logs: ## api / worker のログを追う
	docker compose logs -f api worker

ps: ## 起動中のサービス一覧
	$(EDGE) ps
	docker compose ps

tools-up: edge-up ## 開発者ツール (CloudBeaver 等) を起動する
	docker compose --profile tools up -d

tools-down: ## 開発者ツールを停止する
	docker compose --profile tools down

migrate: ## スキーマ・ロールの作成とモジュールごとのマイグレーション
	docker compose run --rm api pnpm migrate

check: ## CI と同じチェックをローカルで回す
	pnpm check

# postgres は internal にのみ居て ports を開けていないので、ホストからは届かない。
# 統合テストは DB と同じネットワークに居るコンテナの中で走らせる。
# --no-deps: 既に起動している postgres を使う。落ちていれば setupFiles が案内して落ちる。
#
# 常駐 worker を止めるのは、テストが自前で relayOnce を呼んで配信を制御するため。
# 止めないと、常駐 worker が同じ outbox を先に拾って published 印を付けてしまい、
# 「配信前は届いていない」という結果整合のアサーションが不安定になる。
# 終わったら元の状態に戻す (止まっていたなら止めたまま)。
test-integration: ## DB を使う統合テストをコンテナ内で回す
	@worker_was_up=$$(docker compose ps --status running --quiet worker); \
	if [ -n "$$worker_was_up" ]; then echo "worker を一時停止します (テストが配信を制御するため)"; docker compose stop worker >/dev/null; fi; \
	docker compose run --rm --no-deps api pnpm test:integration; \
	status=$$?; \
	if [ -n "$$worker_was_up" ]; then docker compose start worker >/dev/null; fi; \
	exit $$status

clean: ## プロダクトを volume ごと消す (DB のデータも消える)
	docker compose down -v
