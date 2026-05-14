-- Idempotent bootstrap for the Untenanted database.
--
-- Designed to be mounted into Postgres's /docker-entrypoint-initdb.d. It runs
-- once when the postgres data volume is first initialized. After that, it is
-- ignored. Safe to coexist with init scripts from other applications (Zitadel,
-- etc.) — it only touches the `untenanted` user and database.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'untenanted') THEN
    CREATE ROLE untenanted WITH LOGIN PASSWORD 'untenanted';
  END IF;
END
$$;

SELECT 'CREATE DATABASE untenanted OWNER untenanted'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'untenanted')
\gexec

\connect untenanted

GRANT ALL ON SCHEMA public TO untenanted;
