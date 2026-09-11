-- スキーマ自体は db/bootstrap/002_readmodel.sql が admin 権限で作る。
-- drizzle-kit が出力した CREATE SCHEMA "readmodel"; はここでは実行できない
-- (このロールにデータベースへの CREATE 権限が無い) ため削除してある。
CREATE TABLE "readmodel"."daily_ingredient_flow" (
	"business_date" date NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"received_amount" numeric(14, 3) DEFAULT '0' NOT NULL,
	"consumed_amount" numeric(14, 3) DEFAULT '0' NOT NULL,
	"reorder_breached" boolean DEFAULT false NOT NULL,
	"breach_on_hand_amount" numeric(14, 3),
	"breach_reorder_point_amount" numeric(14, 3),
	"breach_suggested_amount" numeric(14, 3),
	"breach_detected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_ingredient_flow_business_date_ingredient_id_pk" PRIMARY KEY("business_date","ingredient_id")
);
--> statement-breakpoint
CREATE TABLE "readmodel"."daily_lot_summary" (
	"business_date" date NOT NULL,
	"lot_code" text NOT NULL,
	"product_id" uuid NOT NULL,
	"best_before" date,
	"produced_pieces" integer DEFAULT 0 NOT NULL,
	"sold_pieces" integer DEFAULT 0 NOT NULL,
	"sales_jpy" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_lot_summary_business_date_lot_code_pk" PRIMARY KEY("business_date","lot_code")
);
--> statement-breakpoint
CREATE TABLE "readmodel"."daily_product_summary" (
	"business_date" date NOT NULL,
	"product_id" uuid NOT NULL,
	"produced_pieces" integer DEFAULT 0 NOT NULL,
	"sold_pieces" integer DEFAULT 0 NOT NULL,
	"sales_jpy" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_product_summary_business_date_product_id_pk" PRIMARY KEY("business_date","product_id")
);
--> statement-breakpoint
CREATE TABLE "readmodel"."delisted_products" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"delisted_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "readmodel"."inbox" (
	"event_id" uuid NOT NULL,
	"handler" text NOT NULL,
	"event_name" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_event_id_handler_pk" PRIMARY KEY("event_id","handler")
);
