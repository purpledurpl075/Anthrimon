-- 037_api_token_scopes.sql
-- Extend API tokens with an optional site restriction list.
-- site_ids = NULL / '{}' means the token is scoped to the full tenant (current default).
-- The scopes column already exists (JSONB array); no DDL needed there.

ALTER TABLE api_tokens
    ADD COLUMN IF NOT EXISTS site_ids UUID[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_api_tokens_site_ids
    ON api_tokens USING gin(site_ids) WHERE array_length(site_ids, 1) > 0;

COMMENT ON COLUMN api_tokens.site_ids IS
    'If non-empty, requests authenticated with this token are restricted to these '
    'site IDs regardless of the token owner''s tenant-level role.';
