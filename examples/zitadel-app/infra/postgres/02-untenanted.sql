-- Provisioning for the Untenanted application alongside the Zitadel database.
-- Mounted into /docker-entrypoint-initdb.d as 02-untenanted.sql so it runs
-- after the official Zitadel image creates POSTGRES_DB=zitadel. Idempotent.

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
