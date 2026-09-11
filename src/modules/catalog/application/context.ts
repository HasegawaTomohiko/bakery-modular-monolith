/**
 * 実行時の CatalogContext。
 *
 * 組み立てを遅延させるのは、`moduleDb()` が env を読むため。import した時点で
 * 接続情報を要求すると、DB を持たない単体テストや drizzle-kit の実行で落ちる。
 */
import { moduleDb } from "../../../shared/db.ts";
import { createCatalogStore } from "../infra/store.ts";
import type { CatalogContext } from "./store.ts";

let cached: CatalogContext | undefined;

/** index.ts と http/routes.ts が共有する既定の文脈。 */
export function catalogContext(): CatalogContext {
  cached ??= {
    store: createCatalogStore(moduleDb("catalog")),
    now: () => new Date(),
    newProductId: () => crypto.randomUUID(),
  };
  return cached;
}
