-- スキーマ自体は db/bootstrap/001_schemas_and_roles.sql が admin 権限で作る。
-- drizzle-kit が出力した CREATE SCHEMA "inventory"; はここでは実行できない
-- (モジュールのロールにデータベースへの CREATE 権限が無い) ため削除してある。
CREATE TABLE "inventory"."outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
