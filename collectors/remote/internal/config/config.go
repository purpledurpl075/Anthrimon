// Package config loads and validates the remote-collector configuration.
// Settings may be supplied via YAML file or environment variable overrides.
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Config is the top-level configuration structure.
type Config struct {
	HubURL    string `yaml:"hub_url"`
	Token     string `yaml:"token"`
	CACert    string `yaml:"ca_cert"`
	StateFile string `yaml:"state_file"`

	SNMP    SNMPConfig    `yaml:"snmp"`
	Flow    FlowConfig    `yaml:"flow"`
	Syslog  SyslogConfig  `yaml:"syslog"`
	Trap    TrapConfig    `yaml:"trap"`
	Forward ForwardConfig `yaml:"forward"`
	Server  ServerConfig  `yaml:"server"`
	Log     LogConfig     `yaml:"log"`
}

// SNMPConfig holds parameters for the SNMP poller.
type SNMPConfig struct {
	PollingIntervalS int `yaml:"polling_interval_s"`
	MaxConcurrent    int `yaml:"max_concurrent"`
	TimeoutSeconds   int `yaml:"timeout_seconds"`
	Retries          int `yaml:"retries"`
}

// FlowConfig holds addresses for NetFlow/sFlow listeners.
type FlowConfig struct {
	NetflowAddr string `yaml:"netflow_addr"`
	SflowAddr   string `yaml:"sflow_addr"`
	BufferSize  int    `yaml:"buffer_size"`
}

// SyslogConfig holds addresses for syslog listeners.
type SyslogConfig struct {
	UDPAddr string `yaml:"udp_addr"`
	TCPAddr string `yaml:"tcp_addr"`
}

// TrapConfig holds the address for the SNMP trap listener.
type TrapConfig struct {
	UDPAddr string `yaml:"udp_addr"` // default ":162"
	Enabled bool   `yaml:"enabled"`  // default true when addr is non-empty
}

// ForwardConfig controls how data is batched before being sent to the hub.
type ForwardConfig struct {
	BatchSize      int `yaml:"batch_size"`
	FlushIntervalS int `yaml:"flush_interval_s"`
}

// ServerConfig holds the mini HTTP server bind address.
type ServerConfig struct {
	Addr string `yaml:"addr"`
}

// LogConfig holds logging settings.
type LogConfig struct {
	Level string `yaml:"level"`
}

// defaults fills in sensible values for any unset fields.
func defaults(c *Config) {
	// No default for HubURL — must be set explicitly in collector.yaml
	// or via the ANTHRIMON_HUB environment variable.
	if c.CACert == "" {
		c.CACert = "/etc/anthrimon/ca.crt"
	}
	if c.StateFile == "" {
		c.StateFile = "/etc/anthrimon/collector-state.json"
	}
	if c.SNMP.PollingIntervalS == 0 {
		c.SNMP.PollingIntervalS = 60
	}
	if c.SNMP.MaxConcurrent == 0 {
		c.SNMP.MaxConcurrent = 20
	}
	if c.SNMP.TimeoutSeconds == 0 {
		c.SNMP.TimeoutSeconds = 10
	}
	if c.SNMP.Retries == 0 {
		c.SNMP.Retries = 2
	}
	if c.Flow.NetflowAddr == "" {
		c.Flow.NetflowAddr = ":2055"
	}
	if c.Flow.SflowAddr == "" {
		c.Flow.SflowAddr = ":6343"
	}
	if c.Flow.BufferSize == 0 {
		c.Flow.BufferSize = 65535
	}
	if c.Syslog.UDPAddr == "" {
		c.Syslog.UDPAddr = ":514"
	}
	if c.Syslog.TCPAddr == "" {
		c.Syslog.TCPAddr = ":514"
	}
	if c.Trap.UDPAddr == "" {
		c.Trap.UDPAddr = ":162"
	}
	if c.Forward.BatchSize == 0 {
		c.Forward.BatchSize = 500
	}
	if c.Forward.FlushIntervalS == 0 {
		c.Forward.FlushIntervalS = 10
	}
	if c.Log.Level == "" {
		c.Log.Level = "info"
	}
}

// Load reads the YAML config file at path (empty = use built-in defaults only),
// then applies environment variable overrides:
//
//	ANTHRIMON_HUB   → hub_url
//	ANTHRIMON_TOKEN → token
//	ANTHRIMON_CA    → ca_cert
//	ANTHRIMON_STATE → state_file
func Load(path string) (*Config, error) {
	var cfg Config

	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read config %q: %w", path, err)
		}
		if err := yaml.Unmarshal(data, &cfg); err != nil {
			return nil, fmt.Errorf("parse config %q: %w", path, err)
		}
	}

	defaults(&cfg)

	// Environment variable overrides always win.
	if v := os.Getenv("ANTHRIMON_HUB"); v != "" {
		cfg.HubURL = v
	}
	if v := os.Getenv("ANTHRIMON_TOKEN"); v != "" {
		cfg.Token = v
	}
	if v := os.Getenv("ANTHRIMON_CA"); v != "" {
		cfg.CACert = v
	}
	if v := os.Getenv("ANTHRIMON_STATE"); v != "" {
		cfg.StateFile = v
	}

	if cfg.HubURL == "" {
		return nil, fmt.Errorf("hub_url is not set — configure it in collector.yaml or set ANTHRIMON_HUB")
	}

	return &cfg, nil
}
