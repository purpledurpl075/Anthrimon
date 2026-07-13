// flow-collector is the Anthrimon flow telemetry daemon.
// It listens for NetFlow v5, NetFlow v9, IPFIX, and sFlow v5 over UDP and
// writes decoded flow records to ClickHouse.
//
// Usage:
//
//	flow-collector [--config /path/to/flow-collector.yaml]
//
// Config file is optional — all settings have defaults and can be overridden
// via FLOW_* environment variables (e.g. FLOW_DATABASE_DSN).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/lookup"
	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/server"
	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/writer"
)

const version = "0.1.2"

func main() {
	cfgPath := flag.String("config", "", "path to config file (default: /etc/anthrimon/flow-collector.yaml)")
	showVer := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVer {
		fmt.Printf("flow-collector %s\n", version)
		os.Exit(0)
	}

	// Bootstrap a temporary console logger for startup.
	zerolog.TimeFieldFormat = time.RFC3339
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})

	if err := run(*cfgPath); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal().Err(err).Msg("flow-collector exited with error")
	}
}

func run(cfgPath string) error {
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	// Switch to JSON structured logging for production.
	level, err := zerolog.ParseLevel(cfg.Log.Level)
	if err != nil {
		level = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(level)
	logger := zerolog.New(os.Stderr).With().Timestamp().Str("service", "flow-collector").Logger()

	logger.Info().Str("version", version).Str("log_level", level.String()).Msg("starting")

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Device lookup — maps exporter IPs to device UUIDs via PostgreSQL.
	lkp, err := lookup.NewDeviceLookup(ctx, cfg.Database.DSN, cfg.Lookup.DeviceRefreshS, logger)
	if err != nil {
		return fmt.Errorf("init device lookup: %w", err)
	}
	defer lkp.Close()

	// ClickHouse batch writer.
	w, err := writer.NewWriter(ctx, cfg.ClickHouse.DSN, cfg.Writer.BatchSize, cfg.Writer.FlushIntervalS, logger)
	if err != nil {
		return fmt.Errorf("init clickhouse writer: %w", err)
	}
	defer w.Close()

	// Start the ClickHouse flush loop in the background.
	go w.Run(ctx)

	// UDP server — blocks until ctx is cancelled.
	srv := server.NewServer(cfg, lkp, w, logger)
	logger.Info().
		Str("netflow_addr", cfg.Listener.NetFlowAddr).
		Str("sflow_addr", cfg.Listener.SFlowAddr).
		Msg("starting UDP listeners")

	if err := srv.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return fmt.Errorf("server: %w", err)
	}

	logger.Info().Msg("flow-collector stopped")
	return nil
}
