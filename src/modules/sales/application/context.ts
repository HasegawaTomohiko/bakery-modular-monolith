/**
 * 既定の依存関係。
 *
 * 実物 (drizzle と catalog) を束ねるのはここだけ。ユースケースは `SalesDeps` しか
 * 知らないので、単体テストではインメモリの実装を差し込める。
 */
import { randomUUID } from "node:crypto";
import { catalogProducts } from "../infra/catalog-products.ts";
import { drizzleUnitOfWork } from "../infra/unit-of-work.ts";
import type { SalesDeps } from "./ports.ts";

/** 接続は最初に使うときに張られる (moduleDb が遅延して繋ぐ)。 */
export function salesContext(): SalesDeps {
  return {
    uow: drizzleUnitOfWork(),
    products: catalogProducts,
    newId: () => randomUUID(),
    now: () => new Date(),
  };
}
