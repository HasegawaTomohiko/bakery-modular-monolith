/**
 * 実際の DB に繋いだ `Transactor`。
 *
 * `repo` と `publish` を**同じ `tx`** から作るのがこのファイルの全て。
 * ユースケースから見ると単に「UnitOfWork の中で書いて publish する」だけだが、
 * その2つが同じトランザクションに乗ることはここで保証される。
 * 在庫は動いたのに発注点割れイベントが出ていない、あるいはその逆が起きない
 * (境界の強制 3/3)。
 */
import { moduleDb } from "../../../shared/db.ts";
import { publishEvent } from "../../../shared/outbox.ts";
import type { Transactor, UnitOfWork } from "../application/ports.ts";
import { createRepository } from "./repository.ts";

export const transaction: Transactor = (run) =>
  moduleDb("inventory").transaction(async (tx) => {
    const uow: UnitOfWork = {
      repo: createRepository(tx),
      publish: (name, payload) => publishEvent(tx, "inventory", name, payload),
    };
    return run(uow);
  });

/**
 * 購読ハンドラ用。
 *
 * 購読側は event-bus が既に inbox 用のトランザクションを開いているので、
 * そこに相乗りする。ここで新しくトランザクションを開くと、inbox の記録と
 * ハンドラの処理が別トランザクションになって冪等性が壊れる。
 */
export function unitOfWorkFor(tx: Parameters<typeof createRepository>[0]): UnitOfWork {
  return {
    repo: createRepository(tx),
    publish: (name, payload) => publishEvent(tx, "inventory", name, payload),
  };
}
