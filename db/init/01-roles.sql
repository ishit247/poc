-- Dev bootstrap, runs once on an empty volume. Passwords here are dev-only.
--   pos_owner : owns the schema, runs migrations. Not a superuser, no BYPASSRLS.
--   pos_app   : what the API connects as. NOBYPASSRLS, owns nothing.
CREATE ROLE pos_owner LOGIN PASSWORD 'pos_owner' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE pos_app   LOGIN PASSWORD 'pos_app'   NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

ALTER DATABASE pos OWNER TO pos_owner;
GRANT CONNECT ON DATABASE pos TO pos_app;
