/**
 * 境界の強制 (1/3): コード
 *
 * docs/conventions/module-boundaries.md を機械可読にしたもの。
 * モジュール間の依存は「相手の index.ts のみ」に限る。
 */
module.exports = {
  forbidden: [
    {
      name: "no-cross-module-internals",
      comment:
        "他モジュールへは index.ts 経由でのみ依存できる。domain/application/infra/http を直接 import してはいけない。",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/" },
      to: {
        path: "^src/modules/[^/]+/",
        pathNot: ["^src/modules/$1/", "^src/modules/[^/]+/index\\.ts$"],
      },
    },
    {
      name: "no-module-to-entrypoint",
      comment:
        "モジュールはエントリポイント(api/worker)を知ってはいけない。依存の向きは entrypoints → modules。",
      severity: "error",
      from: { path: "^src/modules/" },
      to: { path: "^src/entrypoints/" },
    },
    {
      name: "no-shared-to-module",
      comment: "shared は全モジュールの土台。個別のモジュールに依存してはいけない。",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { path: "^src/modules/" },
    },
    {
      name: "no-module-internals-from-outside",
      comment:
        "モジュール外(entrypoints 等)からもモジュールの内部には入れない。公開面は index.ts と http/routes.ts のみ。",
      severity: "error",
      from: { pathNot: "^src/modules/" },
      to: {
        path: "^src/modules/[^/]+/.+",
        pathNot: ["^src/modules/[^/]+/index\\.ts$", "^src/modules/[^/]+/http/routes\\.ts$"],
      },
    },
    {
      name: "no-readmodel-to-module",
      comment:
        "参照モデルはイベントだけから組み立てる。モジュールに依存すると、結局そこが JOIN の代わりになってしまう。",
      severity: "error",
      from: { path: "^src/readmodel/" },
      to: { path: "^src/modules/" },
    },
    {
      name: "no-module-to-readmodel",
      comment: "モジュールは参照モデルを知らない。依存の向きは readmodel → shared のみ。",
      severity: "error",
      from: { path: "^src/modules/" },
      to: { path: "^src/readmodel/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      extensions: [".ts", ".js", ".mts", ".cts", ".json"],
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
