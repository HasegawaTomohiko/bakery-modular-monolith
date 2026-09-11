#!/usr/bin/env bash
# devcontainer 内の localhost は自分自身を指すため、
# 127.0.0.1:80 → edge:80 への転送を1本置く。
#
# `edge` は dev-edge ネットワーク上の Traefik の別名で、Docker 組み込み DNS が解決する。
# hosts ファイルや独自 DNS といったローカル設定には一切依存しない。
#
# 非 root で 80 番を listen するため、devcontainer.json で
# net.ipv4.ip_unprivileged_port_start=0 を設定してある。
set -euo pipefail

if ss -ltn 2>/dev/null | grep -q '127.0.0.1:80 '; then
  echo "edge-forward: 127.0.0.1:80 is already listening; nothing to do"
  exit 0
fi

exec socat TCP-LISTEN:80,bind=127.0.0.1,fork,reuseaddr TCP:edge:80
