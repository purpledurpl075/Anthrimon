// snmp-collector is the Anthrimon SNMP polling daemon.
// It reads devices from PostgreSQL, polls them via SNMP v2c/v3 on their
// configured intervals, and writes results to both PostgreSQL and VictoriaMetrics.
//
// Usage:
//
//	snmp-collector [--config /path/to/snmp-collector.yaml]
//
// Config file is optional — all settings have defaults and can be overridden
// via SNMP_* environment variables (e.g. SNMP_DATABASE_DSN).
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

	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/crypto"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/poller"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/writer"

	// Import all vendor profiles so their init() functions register them.
	_ "github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/vendor"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

const version = "0.1.10"

func main() {
	cfgPath := flag.String("config", "", "path to config file (default: /etc/anthrimon/snmp-collector.yaml)")
	showVer := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVer {
		fmt.Printf("snmp-collector %s\n", version)
		os.Exit(0)
	}

	// Bootstrap a temporary console logger for startup.
	zerolog.TimeFieldFormat = time.RFC3339
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})

	if err := run(*cfgPath); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal().Err(err).Msg("snmp-collector exited with error")
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
	logger := zerolog.New(os.Stderr).With().Timestamp().Str("service", "snmp-collector").Logger()

	logger.Info().Str("version", version).Str("log_level", level.String()).Msg("starting")

	// Credential encryption — nil codec means plaintext mode (dev/test only).
	var codec *crypto.AESCodec
	if cfg.Encryption.Key != "" {
		codec, err = crypto.NewAESCodec(cfg.Encryption.Key)
		if err != nil {
			return fmt.Errorf("init encryption: %w", err)
		}
		logger.Info().Msg("credential encryption enabled")
	} else {
		logger.Warn().Msg("ANTHRIMON_ENCRYPTION_KEY not set — credentials read as plaintext JSON")
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// PostgreSQL writer — also implements DeviceSource for the device list.
	pgWriter, err := writer.NewPostgresWriter(
		ctx,
		cfg.Database.DSN,
		cfg.Database.MaxConns,
		cfg.Database.MinConns,
		logger,
	)
	if err != nil {
		return fmt.Errorf("init postgres writer: %w", err)
	}
	defer pgWriter.Close()

	// VictoriaMetrics writer — buffers and flushes time-series metrics.
	vmWriter := writer.NewVMWriter(
		cfg.Metrics.VictoriaMetricsURL,
		cfg.Metrics.FlushInterval,
		cfg.Metrics.BatchSize,
		logger,
	)

	// Fan-out: send results to both writers.
	multi := &multiWriter{writers: []poller.ResultHandler{pgWriter, vmWriter}}

	// Start VM background flush loop.
	go vmWriter.Run(ctx)

	// Start poller manager. Blocks until ctx is cancelled.
	mgr := poller.NewManager(cfg, codec, multi, logger)
	return mgr.Run(ctx, pgWriter)
}

// multiWriter dispatches PollResults to multiple ResultHandlers in order.
// All handlers are called even if one returns an error.
type multiWriter struct {
	writers []poller.ResultHandler
}

func (m *multiWriter) Handle(ctx context.Context, result *poller.PollResult) error {
	var errs []error
	for _, w := range m.writers {
		if err := w.Handle(ctx, result); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
