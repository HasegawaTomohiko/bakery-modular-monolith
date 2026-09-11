import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * web (フロントエンド) の開発サーバ。
 *
 * 入口は edge (Traefik) だけで、compose には `ports:` を書かない
 * (docs/conventions/local-environment.md)。したがってこのサーバは
 * 「コンテナの外から Traefik 経由で届く」前提で設定する必要がある。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    // コンテナの外 (= Traefik) から届かせるため 0.0.0.0 で listen する。
    host: true,
    port: 5173,
    strictPort: true,
    /**
     * Vite は既定で知らない Host ヘッダを弾く (DNS リバインディング対策)。
     * Traefik は `app.bakery.localhost` の Host をそのまま転送してくるので許可する。
     *
     * ここはローカルの入口の都合を知ってよい唯一の場所。アプリのコード
     * (web/src/**) には edge 固有のホスト名を書かない — API のベース URL は
     * VITE_API_BASE_URL で外から渡す (docs/conventions/local-environment.md
     * 「本番との線引き」)。
     */
    allowedHosts: ["app.bakery.localhost"],
    hmr: {
      // ブラウザは Traefik (80 番) 経由で来る。HMR の WebSocket も同じ入口を
      // 通す必要があるので、クライアントが繋ぎに行く先を 5173 ではなく 80 にする。
      clientPort: 80,
    },
  },
});
