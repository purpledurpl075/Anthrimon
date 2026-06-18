// Package config loads and validates collector settings from a YAML file and
// environment variable overrides. All secrets (DB password, encryption key)
// come from env vars so they never need to appear in the config file.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Database   DatabaseConfig   `yaml:"database"`
	Encryption EncryptionConfig `yaml:"encryption"`
	SNMP       SNMPConfig       `yaml:"snmp"`
	Polling    PollingConfig    `yaml:"polling"`
	Metrics    MetricsConfig    `yaml:"metrics"`
	Log        LogConfig        `yaml:"log"`
}

type DatabaseConfig struct {
	DSN      string `yaml:"dsn"`
	MaxConns int    `yaml:"max_conns"`
	MinConns int    `yaml:"min_conns"`
}

type EncryptionConfig struct {
	Key string `yaml:"key"`
}

type SNMPConfig struct {
	TimeoutSeconds int `yaml:"timeout_seconds"`
	Retries        int `yaml:"retries"`
	MaxOids        int `yaml:"max_oids"`
	MaxRepetitions int `yaml:"max_repetitions"`
}

type PollingConfig struct {
	DefaultIntervalS     int `yaml:"default_interval_s"`
	StateIntervalS       int `yaml:"state_interval_s"`
	HealthIntervalS      int `yaml:"health_interval_s"`
	HealthMultiplier     int `yaml:"health_multiplier"` // kept for config-file compat; no longer used
	DeviceRefreshS       int `yaml:"device_refresh_s"`
	MaxConcurrentDevices int `yaml:"max_concurrent_devices"`
}

type MetricsConfig struct {
	VictoriaMetricsURL string        `yaml:"victoriametrics_url"`
	FlushInterval      time.Duration `yaml:"flush_interval"`
	BatchSize          int           `yaml:"batch_size"`
}

type LogConfig struct {
	Level string `yaml:"level"`
}

// defaults returns a Config pre-populated with safe production defaults.
func defaults() Config {
	return Config{
		Database:   DatabaseConfig{MaxConns: 25, MinConns: 2},
		SNMP:       SNMPConfig{TimeoutSeconds: 10, Retries: 3, MaxOids: 60, MaxRepetitions: 25},
		Polling:    PollingConfig{DefaultIntervalS: 60, StateIntervalS: 15, HealthIntervalS: 60, HealthMultiplier: 5, DeviceRefreshS: 300, MaxConcurrentDevices: 500},
		Metrics:    MetricsConfig{VictoriaMetricsURL: "http://localhost:8428", FlushInterval: 10 * time.Second, BatchSize: 500},
		Log:        LogConfig{Level: "info"},
	}
}

// Load reads configuration from the given YAML file (optional) then applies
// SNMP_* environment variable overrides.
func Load(path string) (*Config, error) {
	cfg := defaults()

	if path == "" {
		for _, candidate := range []string{"/etc/anthrimon/snmp-collector.yaml", "snmp-collector.yaml"} {
			if _, err := os.Stat(candidate); err == nil {
				path = candidate
				break
			}
		}
	}

	if path != "" {
		f, err := os.Open(path)
		if err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("opening config file: %w", err)
		}
		if err == nil {
			defer f.Close()
			if err := yaml.NewDecoder(f).Decode(&cfg); err != nil {
				return nil, fmt.Errorf("parsing config file: %w", err)
			}
		}
	}

	// Environment variable overrides: SNMP_DATABASE_DSN, SNMP_LOG_LEVEL, etc.
	applyEnv(&cfg)

	if cfg.Database.DSN == "" {
		return nil, fmt.Errorf("database.dsn is required (set SNMP_DATABASE_DSN env var)")
	}

	return &cfg, nil
}

func applyEnv(cfg *Config) {
	if v := env("SNMP_DATABASE_DSN");                v != "" { cfg.Database.DSN = v }
	if v := env("SNMP_DATABASE_MAX_CONNS");           v != "" { cfg.Database.MaxConns = atoi(v, cfg.Database.MaxConns) }
	if v := env("SNMP_DATABASE_MIN_CONNS");           v != "" { cfg.Database.MinConns = atoi(v, cfg.Database.MinConns) }
	if v := env("ANTHRIMON_ENCRYPTION_KEY");          v != "" { cfg.Encryption.Key = v }
	if v := env("SNMP_SNMP_TIMEOUT_SECONDS");         v != "" { cfg.SNMP.TimeoutSeconds = atoi(v, cfg.SNMP.TimeoutSeconds) }
	if v := env("SNMP_SNMP_RETRIES");                 v != "" { cfg.SNMP.Retries = atoi(v, cfg.SNMP.Retries) }
	if v := env("SNMP_POLLING_DEFAULT_INTERVAL_S");     v != "" { cfg.Polling.DefaultIntervalS = atoi(v, cfg.Polling.DefaultIntervalS) }
	if v := env("SNMP_POLLING_STATE_INTERVAL_S");       v != "" { cfg.Polling.StateIntervalS = atoi(v, cfg.Polling.StateIntervalS) }
	if v := env("SNMP_POLLING_HEALTH_INTERVAL_S");      v != "" { cfg.Polling.HealthIntervalS = atoi(v, cfg.Polling.HealthIntervalS) }
	if v := env("SNMP_POLLING_HEALTH_MULTIPLIER");      v != "" { cfg.Polling.HealthMultiplier = atoi(v, cfg.Polling.HealthMultiplier) }
	if v := env("SNMP_POLLING_DEVICE_REFRESH_S");       v != "" { cfg.Polling.DeviceRefreshS = atoi(v, cfg.Polling.DeviceRefreshS) }
	if v := env("SNMP_POLLING_MAX_CONCURRENT_DEVICES"); v != "" { cfg.Polling.MaxConcurrentDevices = atoi(v, cfg.Polling.MaxConcurrentDevices) }
	if v := env("SNMP_METRICS_VICTORIAMETRICS_URL");  v != "" { cfg.Metrics.VictoriaMetricsURL = v }
	if v := env("SNMP_LOG_LEVEL");                    v != "" { cfg.Log.Level = v }
}

func env(key string) string { return strings.TrimSpace(os.Getenv(key)) }

func atoi(s string, fallback int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return fallback
}
