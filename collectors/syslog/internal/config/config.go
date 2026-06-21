// Package config loads and validates syslog-collector settings from a YAML file
// and environment variable overrides. All secrets (DB password) come from env
// vars so they never need to appear in the config file.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config is the top-level configuration for the syslog collector.
type Config struct {
	Database   DatabaseConfig   `yaml:"database"`
	ClickHouse ClickHouseConfig `yaml:"clickhouse"`
	Listener   ListenerConfig   `yaml:"listener"`
	Writer     WriterConfig     `yaml:"writer"`
	Lookup     LookupConfig     `yaml:"lookup"`
	Log        LogConfig        `yaml:"log"`
}

// DatabaseConfig configures the PostgreSQL connection used for device lookups.
type DatabaseConfig struct {
	DSN      string `yaml:"dsn"`
	MaxConns int    `yaml:"max_conns"`
}

// ClickHouseConfig configures the ClickHouse connection used for syslog storage.
type ClickHouseConfig struct {
	DSN string `yaml:"dsn"`
}

// ListenerConfig configures the UDP and TCP listeners.
type ListenerConfig struct {
	UDPAddr    string `yaml:"udp_addr"`
	TCPAddr    string `yaml:"tcp_addr"`
	BufferSize int    `yaml:"buffer_size"`
}

// WriterConfig controls batching behaviour for ClickHouse inserts.
type WriterConfig struct {
	BatchSize      int `yaml:"batch_size"`
	FlushIntervalS int `yaml:"flush_interval_s"`
}

// LookupConfig controls how often the device table is re-read from PostgreSQL.
type LookupConfig struct {
	DeviceRefreshS int `yaml:"device_refresh_s"`
}

// LogConfig controls log verbosity.
type LogConfig struct {
	Level string `yaml:"level"`
}

// defaults returns a Config pre-populated with safe production defaults.
func defaults() Config {
	return Config{
		Database: DatabaseConfig{
			MaxConns: 3,
		},
		ClickHouse: ClickHouseConfig{
			DSN: "clickhouse://localhost:9000/default",
		},
		Listener: ListenerConfig{
			UDPAddr:    ":514",
			TCPAddr:    ":514",
			BufferSize: 8192,
		},
		Writer: WriterConfig{
			BatchSize:      1000,
			FlushIntervalS: 5,
		},
		Lookup: LookupConfig{
			DeviceRefreshS: 300,
		},
		Log: LogConfig{Level: "info"},
	}
}

// Load reads configuration from the given YAML file (optional) then applies
// SYSLOG_* environment variable overrides.
func Load(path string) (*Config, error) {
	cfg := defaults()

	if path == "" {
		for _, candidate := range []string{"/etc/anthrimon/syslog-collector.yaml", "syslog-collector.yaml"} {
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

	applyEnv(&cfg)

	if cfg.Database.DSN == "" {
		return nil, fmt.Errorf("database.dsn is required (set SYSLOG_DATABASE_DSN env var)")
	}

	return &cfg, nil
}

func applyEnv(cfg *Config) {
	if v := env("SYSLOG_DATABASE_DSN");      v != "" { cfg.Database.DSN = v }
	if v := env("SYSLOG_DATABASE_MAX_CONNS"); v != "" { cfg.Database.MaxConns = atoi(v, cfg.Database.MaxConns) }
	if v := env("SYSLOG_CLICKHOUSE_DSN");    v != "" { cfg.ClickHouse.DSN = v }
	if v := env("SYSLOG_UDP_ADDR");          v != "" { cfg.Listener.UDPAddr = v }
	if v := env("SYSLOG_TCP_ADDR");          v != "" { cfg.Listener.TCPAddr = v }
	if v := env("SYSLOG_LOG_LEVEL");         v != "" { cfg.Log.Level = v }
	if v := env("SYSLOG_WRITER_BATCH_SIZE"); v != "" { cfg.Writer.BatchSize = atoi(v, cfg.Writer.BatchSize) }
}

func env(key string) string { return strings.TrimSpace(os.Getenv(key)) }

func atoi(s string, fallback int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return fallback
}
