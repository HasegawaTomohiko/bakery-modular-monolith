/**
 * テストは2つのプロジェクトに分かれる。
 *
 *   unit        — DB 不要。CI (DB なし) で回る。`pnpm test`
 *   integration — DB 必須。コンテナ内でしか走らない。`make test-integration`
 *
 * postgres は internal ネットワークにのみ居て ports を開けていない
 * (docs/conventions/local-environment.md) ため、ホストからは届かない。
 * 統合テストは `docker compose run --rm --no-deps api pnpm test:integration` で実行する。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // projects 単位では指定できない (vitest 5 のルート専用オプション)。
    // unit には tests/unit/smoke.test.ts が、integration には境界テストが必ずある。
    // 「テストが1本も無い」状態は基盤が壊れた合図なので、素通りさせない。
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: "unit",
          // web/ のマウント煙テストもここに含める。HTTP は壊れていても 200 を返すので、
          // 「import が無い」「コンポーネントが組み上がらない」は実際に描画してみないと
          // 落とせない (web/src/App.test.ts)。
          include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts", "web/src/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          // 接続確認をここでやる。届かなければ実行方法を案内して落とす。
          setupFiles: ["tests/helpers/integration-setup.ts"],
          // 同じ DB を共有するので、ファイル間で並列に走らせない。
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
