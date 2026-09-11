# devcontainer は「ホスト PC をコンテナに入れたもの」。
# ホストと同列で、サービスネットワークの外にいる。
# サービスの設定 (env/conf) やミドルウェアの接続情報を一切持たないこと。
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client sudo less iproute2 \
      libatomic1 \
      # 入口 (edge:80) を devcontainer 内の 127.0.0.1:80 に転送するために使う
      socat \
 && rm -rf /var/lib/apt/lists/*

ARG USERNAME=dev
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid $USER_GID $USERNAME \
 && useradd --uid $USER_UID --gid $USER_GID -m -s /bin/bash $USERNAME \
 && echo "$USERNAME ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/$USERNAME \
 && chmod 0440 /etc/sudoers.d/$USERNAME

# ホストと同じ mise.toml でツールチェーンをそろえる。
ENV MISE_DATA_DIR=/usr/local/share/mise \
    MISE_CONFIG_DIR=/usr/local/share/mise \
    MISE_INSTALL_PATH=/usr/local/bin/mise \
    PATH=/usr/local/share/mise/shims:$PATH
RUN curl -fsSL https://mise.run | sh

COPY mise.toml /tmp/mise.toml
RUN cd /tmp && MISE_CACHE_DIR=/tmp/mise-build-cache mise trust --yes \
 && cd /tmp && MISE_CACHE_DIR=/tmp/mise-build-cache mise install && MISE_CACHE_DIR=/tmp/mise-build-cache mise reshim \
 && rm -rf /tmp/mise-build-cache \
 && rm /tmp/mise.toml \
 && chmod -R a+rX /usr/local/share/mise

# ログインシェル (/etc/profile) が PATH を上書きするため、shims を明示的に前置する。
RUN printf 'export PATH=/usr/local/share/mise/shims:$PATH\n' > /etc/profile.d/mise.sh

USER $USERNAME
