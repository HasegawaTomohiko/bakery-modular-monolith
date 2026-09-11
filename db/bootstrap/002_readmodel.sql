-- 参照モデル (readmodel) のスキーマとロール。
--
-- コンテキストをまたぐ画面 (例: 今日の在庫と販売状況) は JOIN では作れない。
-- スキーマをまたぐ権限が無いのだから当然で、そこを緩めるのは境界を壊すこと。
-- 代わりに、イベントから組み立てた参照用モデルをこのスキーマに持つ。
--
-- readmodel はモジュール (境界づけられたコンテキスト) ではない。
-- 業務ロジックを持たず、購読して投影するだけ。他モジュールのスキーマには触れない。
--
-- 何度流しても同じ結果になること (冪等)。

BEGIN;

DO $$
DECLARE
  role_name text := 'bakery_readmodel';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', role_name, 'devpass');
  ELSE
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', role_name, 'devpass');
  END IF;

  EXECUTE format('CREATE SCHEMA IF NOT EXISTS readmodel AUTHORIZATION %I', role_name);
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA readmodel TO %I', role_name);
  EXECUTE 'REVOKE ALL ON SCHEMA readmodel FROM PUBLIC';
  EXECUTE format('ALTER ROLE %I SET search_path = readmodel', role_name);
  EXECUTE format('GRANT CONNECT ON DATABASE bakery TO %I', role_name);
END $$;

COMMIT;
