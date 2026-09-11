/**
 * 購読側の冪等化。
 *
 * 配信は at-least-once なので、同じイベントが2回届く。
 * 「処理済みの記録」と「実際の処理」を同じトランザクションに入れることで、
 * 2回目は何もしないことを保証する。
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SchemaOwner } from "./config.ts";
import type { EventEnvelope } from "./events.ts";
import { baseTablesOf, type Executor } from "./tables.ts";

export type InboxResult = "processed" | "already-processed";

/**
 * ハンドラを1回だけ実行する。
 *
 * `run` は inbox への記録と同じトランザクションで走る。したがって
 * 「処理は成功したが記録に失敗した」も「記録はされたが処理が失敗した」も起きない。
 *
 * @param subscriber 購読側のモジュール。**そのモジュールのロールの接続**を渡すこと。
 * @param handler    購読側モジュール内で一意な名前。1イベントを複数ハンドラが受けるため。
 */
export async function handleOnce(
  db: NodePgDatabase,
  subscriber: SchemaOwner,
  handler: string,
  event: EventEnvelope,
  run: (tx: Executor) => Promise<void>,
): Promise<InboxResult> {
  const { inbox } = baseTablesOf(subscriber);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(inbox)
      .values({ eventId: event.id, handler, eventName: event.name })
      .onConflictDoNothing()
      .returning({ eventId: inbox.eventId });

    if (inserted.length === 0) {
      return "already-processed";
    }

    await run(tx);
    return "processed";
  });
}
