# syntax=docker/dockerfile:1

# ツールチェーンのバージョンは mise.toml が唯一の情報源。
# ホスト・devcontainer・このイメージが同じ定義を共有する。
FROM debian:trixie-slim AS toolchain

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git libatomic1 \
 && rm -rf /var/lib/apt/lists/*

ENV MISE_DATA_DIR=/usr/local/share/mise \
    MISE_CONFIG_DIR=/usr/local/share/mise \
    MISE_CACHE_DIR=/tmp/mise-cache \
    MISE_INSTALL_PATH=/usr/local/bin/mise \
    PATH=/usr/local/share/mise/shims:$PATH
RUN curl -fsSL https://mise.run | sh

WORKDIR /app
COPY mise.toml ./
RUN mise trust --yes && mise install && mise reshim

# ---- 開発用 ----
# ソースは compose の bind mount で入れる。
# node_modules は named volume にして、ホストの node_modules と混ざらないようにする。
# volume は初回にこのイメージの /app/node_modules から seed される。
FROM toolchain AS dev
ENV NODE_ENV=development
# 依存はイメージ側で入れてある。bind mount で入るソースと照合させると、
# ホスト側 node_modules との差で毎回 install をやり直そうとするので止める。
# /app は bind mount で隠れるため、ホームディレクトリ側に置く。
RUN printf 'verify-deps-before-run=false\n' > /root/.npmrc
# workspace の全パッケージの manifest を入れる。web/package.json が無いと
# pnpm が「workspace が不完全」と判断して install をやり直そうとする。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "dev:api"]

# ---- 本番相当 ----
FROM toolchain AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM toolchain AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
CMD ["node", "dist/src/entrypoints/api.js"]
