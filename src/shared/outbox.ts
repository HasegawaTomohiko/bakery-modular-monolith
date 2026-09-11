/**
 * transactional outbox。
 *
 * 状態変化の通知はここを通す (境界の強制 3/3)。業務データの書き込みと同じ
 * トランザクションでイベント行を書くので、「業務データは変わったのにイベントが
 * 出ていない」も「イベントは出たのに業務データが変わっていない」も起きない。
 *
 * 配信は worker が別トランザクションで行うため at-least-once になる。
 * 重複は購読側の inbox で吸収する。
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { ModuleName } from "./config.ts";
import {
  type EventEnvelope,
  type EventName,
  type EventPayload,
  eventSchemas,
  isEventName,
  publisherOf,
} from "./events.ts";
import { baseTablesOf, type Executor } from "./tables.ts";

/**
 * イベントを1件積む。**業務データの書き込みと同じトランザクション** (`tx`) で呼ぶこと。
 *
 * 契約違反はここで落とす。壊れた payload を outbox に入れてしまうと、
 * 配信時まで気づけず、購読側から見て原因の分からない失敗になるため。
 */
export async function publishEvent<N extends EventName>(
  tx: Executor,
  module: ModuleName,
  name: N,
  payload: EventPayload<N>,
): Promise<void> {
  if (publisherOf(name) !== module) {
    throw new Error(
      `${module} は ${name} を発行できません。イベントの発行元は ${publisherOf(name)} です。`,
    );
  }
  const validated = eventSchemas[name].parse(payload);
  const { outbox } = baseTablesOf(module);
  await tx.insert(outbox).values({ eventName: name, payload: validated });
}

/**
 * 未配信のイベントを取り出す。
 *
 * `FOR UPDATE SKIP LOCKED` を付けるのは、worker を複数本に増やしたときに
 * 同じ行を2本が掴まないようにするため。
 */
export async function fetchUnpublished(
  tx: Executor,
  module: ModuleName,
  limit: number,
): Promise<readonly EventEnvelope[]> {
  const { outbox } = baseTablesOf(module);
  const rows = await tx
    .select()
    .from(outbox)
    .where(isNull(outbox.publishedAt))
    .orderBy(asc(outbox.occurredAt), asc(outbox.id))
    .limit(limit)
    .for("update", { skipLocked: true });

  return rows.map((row) => {
    if (!isEventName(row.eventName)) {
      throw new Error(
        `${module}.outbox に契約外のイベント ${row.eventName} があります (id=${row.id})`,
      );
    }
    return {
      id: row.id,
      name: row.eventName,
      payload: eventSchemas[row.eventName].parse(row.payload),
      occurredAt: row.occurredAt,
    } as EventEnvelope;
  });
}

/** 配信済みとして印を付ける。全購読者の処理が終わってから呼ぶ。 */
export async function markPublished(
  tx: Executor,
  module: ModuleName,
  eventId: string,
  publishedAt: Date = new Date(),
): Promise<void> {
  const { outbox } = baseTablesOf(module);
  await tx
    .update(outbox)
    .set({ publishedAt })
    .where(and(eq(outbox.id, eventId), isNull(outbox.publishedAt)));
}
