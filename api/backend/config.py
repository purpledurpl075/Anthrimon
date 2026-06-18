from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Reads from /etc/anthrimon/api.env in production; falls back to env vars.
        env_file="/etc/anthrimon/api.env",
        env_file_encoding="utf-8",
        env_file_override=False,    # env vars win over file values
        case_sensitive=False,
        extra="ignore",
    )

    # ── Database ──────────────────────────────────────────────────────────────
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "anthrimon"
    db_user: str = "anthrimon"
    db_password: str = "changeme"
    # Set this env var to override the full connection string (e.g. Unix socket for dev).
    database_url_override: str = ""

    @property
    def database_url(self) -> str:
        if self.database_url_override:
            return self.database_url_override
        return (
            f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )

    # ── API server ────────────────────────────────────────────────────────────
    api_host: str = "0.0.0.0"
    api_port: int = 8000

    # ── Auth ──────────────────────────────────────────────────────────────────
    # Override this with a long random string in production.
    jwt_secret_key: str = "CHANGE_ME_IN_PRODUCTION"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 1440   # 24 h

    # ── Logging ───────────────────────────────────────────────────────────────
    log_level: str = "INFO"
    log_json: bool = True            # False for local dev to get human-readable output

    # ── CORS ──────────────────────────────────────────────────────────────────
    # Comma-separated list of allowed origins. Empty = use hardcoded dev defaults.
    cors_origins: list[str] = []

    # ── Tenancy ───────────────────────────────────────────────────────────────
    # The default tenant UUID inserted by migration 001_init.sql.
    default_tenant_id: str = "00000000-0000-0000-0000-000000000001"

    # ── Time-series backends ──────────────────────────────────────────────────
    victoriametrics_url: str = "http://localhost:8428"
    clickhouse_url: str = "http://localhost:8123"

    # ── Licensing ─────────────────────────────────────────────────────────────
    # Offline RS256 license file. Absent = free tier. Lives under the
    # service-owned state dir so Platform Admin uploads persist in place without
    # needing root (the dir is created owned by the API service user at install).
    license_path: str = "/var/lib/anthrimon/license.key"
    # When True, a license bound to a different machine hard-fails at startup
    # instead of degrading to free tier. Default False (soft-fail).
    license_strict: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
