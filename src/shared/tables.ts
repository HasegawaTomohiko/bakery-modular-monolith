/**
 * 全モジュールが同じ形で持つ基盤テーブル。
 *
 * outbox / inbox は「状態変化の通知は transactional outbox 経由のイベントのみ」
 * (境界の強制 3/3) を支える受け皿で、モジュールごとに**自分のスキーマの中に**持つ。
 * 共有テーブルを1つ置くと、そこがスキーマ境界の抜け道になるため置かない。
 *
 * 定義をここに集約するのは、5モジュールで DDL がずれないようにするため。
 * モジュール側の schema.ts はこれを呼んで自分のスキーマに生やす。
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { index, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { SchemaOwner } from "./config.ts";

/**
 * drizzle の接続そのものと、トランザクションの両方を受けられる型。
 * outbox への書き込みは必ず業務データと同じトランザクションで行うため、
 * ヘルパーは `db` ではなく `tx` を受け取れる必要がある。
 */
export type Executor = Pick<NodePgDatabase, "insert" | "select" | "update" | "delete" | "execute">;

/** モジュール1つ分の基盤テーブル。drizzle-kit はここで作られた実体を読む。 */
export function moduleBaseTables(module: SchemaOwner) {
  const schema = pgSchema(module);

  // 発行側。業務データと同じトランザクションで書く。worker が読んで配信する。
  const outbox = schema.table(
    "outbox",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      eventName: text("event_name").notNull(),
      payload: jsonb("payload").notNull(),
      occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
      publishedAt: timestamp("published_at", { withTimezone: true }),
    },
    (table) => [index("outbox_unpublished_idx").on(table.publishedAt, table.occurredAt)],
  );

  // 購読側。処理済みのイベントを記録して冪等にする。
  // 配信は at-least-once なので、同じイベントが2回来ても2回処理しないためのもの。
  // ハンドラ単位で持つのは、1つのイベントを複数のハンドラが購読しうるため。
  const inbox = schema.table(
    "inbox",
    {
      eventId: uuid("event_id").notNull(),
      handler: text("handler").notNull(),
      eventName: text("event_name").notNull(),
      processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [primaryKey({ columns: [table.eventId, table.handler] })],
  );

  return { schema, outbox, inbox } as const;
}

export type ModuleBaseTables = ReturnType<typeof moduleBaseTables>;
export type OutboxTable = ModuleBaseTables["outbox"];
export type InboxTable = ModuleBaseTables["inbox"];

// drizzle のテーブルは呼ぶたびに別インスタンスになるため、実行時は使い回す。
const cache = new Map<SchemaOwner, ModuleBaseTables>();

/** 実行時用。モジュール名から outbox / inbox のテーブル定義を引く。 */
export function baseTablesOf(module: SchemaOwner): ModuleBaseTables {
  let tables = cache.get(module);
  if (tables === undefined) {
    tables = moduleBaseTables(module);
    cache.set(module, tables);
  }
  return tables;
}
