-- Dev bootstrap, runs once on an empty volume. Passwords here are dev-only.
--   pos_owner : owns the schema, runs migrations. Not a superuser, no BYPASSRLS.
--   pos_app   : what the API connects as. NOBYPASSRLS, owns nothing.
CREATE ROLE pos_owner LOGIN PASSWORD 'pos_owner' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE pos_app   LOGIN PASSWORD 'pos_app'   NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

--   app_platform : the platform console (PLAN 5, 15). No default privileges; sees only what a migration grants it.
CREATE ROLE app_platform LOGIN PASSWORD 'app_platform' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

ALTER DATABASE pos OWNER TO pos_owner;
GRANT CONNECT ON DATABASE pos TO pos_app, app_platform;
