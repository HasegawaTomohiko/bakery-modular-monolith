/**
 * 実体の組み立て。
 *
 * ユースケース (application) は口 (ports) しか知らないので、drizzle の
 * リポジトリと outbox への発行をここで束ねる。index.ts はこれを呼ぶだけ。
 *
 * 接続は **production 専用ロール** (moduleDb("production"))。他モジュールの
 * スキーマには権限が無いため、ここから境界を越えることはそもそもできない。
 */
import { randomUUID } from "node:crypto";
import { moduleDb } from "../../../shared/db.ts";
import { publishEvent } from "../../../shared/outbox.ts";
import {
  createProductionService,
  type ProductionService,
} from "../application/production-service.ts";
import { delistedProductRepository } from "./delisted-product-repository.ts";
import { productionPlanRepository } from "./production-plan-repository.ts";
import { productionRunRepository } from "./production-run-repository.ts";
import { recipeRepository } from "./recipe-repository.ts";
import { salesResultRepository } from "./sales-result-repository.ts";

let service: ProductionService | undefined;

/**
 * 実 DB につながったユースケース。
 *
 * 遅延生成にしているのは、import しただけで接続を張らないようにするため
 * (env が無い環境で import されても壊れない)。
 */
export function productionService(): ProductionService {
  service ??= createProductionService({
    // トランザクション境界はユースケース側が決める。ここは張り方だけを与える。
    runInTransaction: (run) => moduleDb("production").transaction((tx) => run(tx)),
    // 業務データと同じ tx を受け取るので、outbox への書き込みは必ず同じ原子性で入る。
    publishProductionCompleted: (tx, payload) =>
      publishEvent(tx, "production", "production.ProductionCompleted", payload),
    recipes: recipeRepository,
    plans: productionPlanRepository,
    runs: productionRunRepository,
    salesResults: salesResultRepository,
    delistedProducts: delistedProductRepository,
    newId: () => randomUUID(),
    now: () => new Date(),
  });
  return service;
}
