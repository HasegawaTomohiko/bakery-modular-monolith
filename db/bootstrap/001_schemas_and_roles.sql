-- 境界の強制 (2/3): DB
--
-- モジュールごとにスキーマを分け、モジュールごとのロールに「自スキーマだけ」の権限を与える。
-- 他モジュールのスキーマには USAGE すら与えないため、スキーマをまたぐ JOIN と外部キーは
-- 権限エラーになり、物理的に書けない。
--
-- 何度流しても同じ結果になること (冪等)。scripts/migrate.ts が admin 接続で流す。
-- ローカル開発用のパスワードは devpass 固定。本番では別途ロール管理を行う。

BEGIN;

-- public は使わない。誰でも書ける置き場があると境界の抜け道になる。
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- モジュールのロールが自分のスキーマ以外を作れないよう、DB への CREATE も閉じる。
REVOKE ALL ON DATABASE bakery FROM PUBLIC;

DO $$
DECLARE
  module text;
  role_name text;
BEGIN
  FOREACH module IN ARRAY ARRAY['catalog', 'production', 'inventory', 'purchasing', 'sales'] LOOP
    role_name := 'bakery_' || module;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', role_name, 'devpass');
    ELSE
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', role_name, 'devpass');
    END IF;

    -- スキーマの所有者はそのモジュールのロール。マイグレーションは自分のスキーマだけを触る。
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', module, role_name);
    EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', module, role_name);

    -- 他モジュールのスキーマは見えているだけで触れない。念のため PUBLIC も閉じる。
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', module);

    -- 接続に search_path を書かせない。ロール側に持たせる。
    EXECUTE format('ALTER ROLE %I SET search_path = %I', role_name, module);

    EXECUTE format('GRANT CONNECT ON DATABASE bakery TO %I', role_name);
  END LOOP;
END $$;

COMMIT;
