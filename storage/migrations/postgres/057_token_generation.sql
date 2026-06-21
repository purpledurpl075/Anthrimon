-- 057: Token generation counter for session revocation
-- Incrementing this value invalidates all existing JWTs for the user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_generation INT NOT NULL DEFAULT 0;
