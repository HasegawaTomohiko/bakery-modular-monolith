/**
 * トランザクション境界の実装。
 *
 * ユースケースは「1 回の run が 1 トランザクション」だけを知っていればよく、
 * drizzle も接続も知らない。sales 専用ロールの接続を使うので、
 * この中から他モジュールのスキーマには届かない (境界の強制 2/3)。
 */
import { moduleDb } from "../../../shared/db.ts";
import type { SalesTx, UnitOfWork } from "../application/ports.ts";
import { salesTx } from "./sales-repository.ts";

export function drizzleUnitOfWork(): UnitOfWork {
  return {
    run<T>(work: (tx: SalesTx) => Promise<T>): Promise<T> {
      return moduleDb("sales").transaction((tx) => work(salesTx(tx)));
    },
  };
}
