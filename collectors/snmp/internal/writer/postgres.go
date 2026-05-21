// Package writer handles persistence of poll results into PostgreSQL and
// VictoriaMetrics. Both writers implement poller.ResultHandler so the poller
// package never needs to import the writer package (dependency inversion).
package writer

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/poller"
	"github.com/rs/zerolog"
)

// PostgresWriter writes poll results to the PostgreSQL database using the
// same schema defined in storage/migrations/postgres/001_init.sql.
type PostgresWriter struct {
	pool *pgxpool.Pool
	log  zerolog.Logger
}

// NewPostgresWriter connects to PostgreSQL and returns a ready writer.
func NewPostgresWriter(ctx context.Context, dsn string, maxConns, minConns int, log zerolog.Logger) (*PostgresWriter, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse postgres DSN: %w", err)
	}
	cfg.MaxConns = int32(maxConns)
	cfg.MinConns = int32(minConns)

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create postgres pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("postgres ping: %w", err)
	}

	log.Info().Str("dsn_prefix", dsn[:min(len(dsn), 30)]).Msg("postgres writer connected")
	return &PostgresWriter{pool: pool, log: log.With().Str("component", "postgres_writer").Logger()}, nil
}

// Close releases the connection pool.
func (w *PostgresWriter) Close() {
	w.pool.Close()
}

// Handle implements poller.ResultHandler.
func (w *PostgresWriter) Handle(ctx context.Context, result *poller.PollResult) error {
	if result.SysInfo != nil {
		if err := w.upsertDevice(ctx, result.SysInfo); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert device failed")
		}
	}

	if len(result.Interfaces) > 0 {
		if err := w.upsertInterfaces(ctx, result.DeviceID, result.Interfaces); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert interfaces failed")
		}
	}

	if result.Health != nil {
		if err := w.upsertHealth(ctx, result.Health); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert health failed")
		}
	}

	if len(result.RouteEntries) > 0 {
		if err := w.upsertRouteEntries(ctx, result.DeviceID, result.RouteEntries); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert route entries failed")
		}
	}

	if len(result.OSPFNeighbours) > 0 {
		if err := w.upsertOSPFNeighbours(ctx, result.DeviceID, result.OSPFNeighbours); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert ospf neighbours failed")
		}
	}

	if len(result.BGPSessions) > 0 {
		if err := w.upsertBGPSessions(ctx, result.DeviceID, result.BGPSessions); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert bgp sessions failed")
		}
	}

	if len(result.ARPEntries) > 0 {
		if err := w.upsertARPEntries(ctx, result.DeviceID, result.ARPEntries); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert arp entries failed")
		}
	}

	if len(result.MACEntries) > 0 {
		if err := w.upsertMACEntries(ctx, result.DeviceID, result.MACEntries); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert mac entries failed")
		}
	}

	if len(result.VLANs) > 0 || result.VLANs != nil {
		if err := w.upsertVLANs(ctx, result.DeviceID, result.VLANs, result.InterfaceVLANs); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert vlans failed")
		}
	}

	if len(result.STPPorts) > 0 {
		if err := w.upsertSTPPorts(ctx, result.DeviceID, result.STPPorts); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert stp ports failed")
		}
	}

	if len(result.LLDPNeighbors) > 0 {
		if err := w.upsertLLDPNeighbors(ctx, result.DeviceID, result.LLDPNeighbors); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert lldp neighbors failed")
		}
	}

	if len(result.CDPNeighbors) > 0 {
		if err := w.upsertCDPNeighbors(ctx, result.DeviceID, result.CDPNeighbors); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert cdp neighbors failed")
		}
	}

	return nil
}

// ── Device ────────────────────────────────────────────────────────────────────

// upsertDevice updates the devices row with sysinfo data from the latest poll.
// Only updates fields that the SNMP poller is authoritative for.
func (w *PostgresWriter) upsertDevice(ctx context.Context, info *model.DeviceInfo) error {
	_, err := w.pool.Exec(ctx, `
		UPDATE devices SET
			sys_description = $1,
			sys_object_id   = $2,
			vendor          = $3::vendor_type,
			device_type     = CASE WHEN $7 <> '' THEN $7::device_type ELSE device_type END,
			fqdn            = NULLIF($4, ''),
			os_version      = CASE WHEN $8 <> '' THEN $8 ELSE os_version END,
			platform        = CASE WHEN $9 <> '' THEN $9 ELSE platform END,
			sys_location    = CASE WHEN $10 <> '' THEN $10 ELSE sys_location END,
			sys_contact     = CASE WHEN $11 <> '' THEN $11 ELSE sys_contact END,
			status          = 'up'::device_status,
			last_polled     = $5,
			last_seen       = $5
		WHERE id = $6`,
		info.SysDescr, info.SysObjectID, info.DBVendorType, info.SysName,
		info.PollTime, info.DeviceID,
		info.DBDeviceType, info.OSVersion, info.Platform,
		info.SysLocationStr, info.SysContactStr,
	)
	return err
}

// ── Interfaces ────────────────────────────────────────────────────────────────

// upsertInterfaces writes one interface result per row using a pgx batch to
// minimise round trips. It also appends to interface_status_log when
// oper_status has changed since the last stored value.
func (w *PostgresWriter) upsertInterfaces(ctx context.Context, deviceID uuid.UUID, ifaces []*model.InterfaceResult) error {
	// Fetch current oper_status values so we can detect changes.
	currentStatus, err := w.fetchIfaceStatus(ctx, deviceID)
	if err != nil {
		return fmt.Errorf("fetch current interface status: %w", err)
	}

	batch := &pgx.Batch{}

	for _, iface := range ifaces {
		var lastChange *time.Time
		if !iface.LastChange.IsZero() {
			t := iface.LastChange
			lastChange = &t
		}

		// Serialize IP addresses as JSONB.
		ipJSON := marshalIPs(iface.IPAddresses)

		// Upsert the interface row.
		batch.Queue(`
			INSERT INTO interfaces (
				device_id, if_index, name, description, if_type,
				speed_bps, mtu, mac_address,
				admin_status, oper_status, last_change,
				ip_addresses, updated_at
			) VALUES (
				$1, $2, $3, $4, $5,
				$6, $7, $8,
				$9::if_status, $10::if_status, $11,
				$12, $13
			)
			ON CONFLICT (device_id, if_index) DO UPDATE SET
				name         = EXCLUDED.name,
				description  = EXCLUDED.description,
				if_type      = EXCLUDED.if_type,
				speed_bps    = EXCLUDED.speed_bps,
				mtu          = EXCLUDED.mtu,
				mac_address  = EXCLUDED.mac_address,
				admin_status = EXCLUDED.admin_status,
				oper_status  = EXCLUDED.oper_status,
				last_change  = EXCLUDED.last_change,
				ip_addresses = CASE
					WHEN EXCLUDED.ip_addresses != '[]'::jsonb
					THEN EXCLUDED.ip_addresses
					ELSE interfaces.ip_addresses
				END,
				updated_at   = EXCLUDED.updated_at
		`,
			deviceID, iface.IfIndex, ifName(iface), nullStr(iface.IfAlias), nullStr(iface.IfType),
			nullUint64(iface.SpeedBPS), nullInt(iface.MTU), nullStr(iface.MACAddress),
			iface.AdminStatus, iface.OperStatus, lastChange,
			ipJSON, iface.PollTime,
		)

		// Log a status-change event if oper_status changed.
		// We need the interface UUID which is returned by the upsert, but
		// pgx batch results don't give us RETURNING rows. Instead we record
		// the event separately using a sub-query to look up the interface UUID.
		prev, hasPrev := currentStatus[iface.IfIndex]
		if hasPrev && prev != iface.OperStatus {
			batch.Queue(`
				INSERT INTO interface_status_log (interface_id, device_id, prev_status, new_status, recorded_at)
				SELECT id, $1, $2::if_status, $3::if_status, $4
				FROM interfaces
				WHERE device_id = $1 AND if_index = $5
			`,
				deviceID, prev, iface.OperStatus, iface.PollTime, iface.IfIndex,
			)
		}
	}

	br := w.pool.SendBatch(ctx, batch)
	defer br.Close()

	for i := 0; i < batch.Len(); i++ {
		if _, err := br.Exec(); err != nil {
			w.log.Error().Err(err).Msg("batch exec error")
		}
	}

	// Touch last_polled/last_seen so the device doesn't appear stale between sysinfo polls.
	if len(ifaces) > 0 {
		t := ifaces[0].PollTime
		if _, err := w.pool.Exec(ctx,
			`UPDATE devices SET last_polled = $1, last_seen = $1, status = 'up'::device_status WHERE id = $2`,
			t, deviceID,
		); err != nil {
			w.log.Error().Err(err).Msg("touch last_polled failed")
		}
	}
	return nil
}

// fetchIfaceStatus returns a map of ifIndex → current oper_status for a device.
func (w *PostgresWriter) fetchIfaceStatus(ctx context.Context, deviceID uuid.UUID) (map[int]string, error) {
	rows, err := w.pool.Query(ctx,
		`SELECT if_index, oper_status::text FROM interfaces WHERE device_id = $1`,
		deviceID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	m := make(map[int]string)
	for rows.Next() {
		var idx int
		var status string
		if err := rows.Scan(&idx, &status); err != nil {
			return nil, err
		}
		m[idx] = status
	}
	return m, rows.Err()
}

// ── Health ────────────────────────────────────────────────────────────────────

// upsertHealth writes the health snapshot to device_health_latest.
// The authoritative history lives in VictoriaMetrics; this row serves the
// dashboard health cards without requiring a time-series query.
func (w *PostgresWriter) upsertHealth(ctx context.Context, h *model.HealthResult) error {
	cpuPct := avgCPU(h.CPUSamples)
	memUsed, memTotal := sumMemory(h.MemSamples)
	tempsJSON := marshalTemps(h.TempSamples)

	_, err := w.pool.Exec(ctx, `
		INSERT INTO device_health_latest (
			device_id, collected_at, cpu_util_pct, mem_used_bytes, mem_total_bytes,
			temperatures, uptime_seconds, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $2)
		ON CONFLICT (device_id) DO UPDATE SET
			collected_at    = EXCLUDED.collected_at,
			cpu_util_pct    = EXCLUDED.cpu_util_pct,
			mem_used_bytes  = EXCLUDED.mem_used_bytes,
			mem_total_bytes = EXCLUDED.mem_total_bytes,
			temperatures    = EXCLUDED.temperatures,
			uptime_seconds  = EXCLUDED.uptime_seconds,
			updated_at      = EXCLUDED.updated_at
	`,
		h.DeviceID, h.PollTime, cpuPct, nullUint64(memUsed), nullUint64(memTotal),
		tempsJSON, h.UptimeSecs,
	)
	return err
}

// ── Routes ────────────────────────────────────────────────────────────────────

func (w *PostgresWriter) upsertRouteEntries(ctx context.Context, deviceID uuid.UUID, routes []*model.RouteEntry) error {
	batch := &pgx.Batch{}
	for _, r := range routes {
		batch.Queue(`
			INSERT INTO route_entries (device_id, destination, next_hop, protocol, metric, interface_name)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (device_id, destination, next_hop) DO UPDATE SET
				protocol       = EXCLUDED.protocol,
				metric         = EXCLUDED.metric,
				interface_name = EXCLUDED.interface_name,
				updated_at     = NOW()
		`, deviceID, r.Destination, r.NextHop, r.Protocol, nullInt(r.Metric), nullStr(r.InterfaceName))
	}
	br := w.pool.SendBatch(ctx, batch)
	defer br.Close()
	for i := 0; i < batch.Len(); i++ {
		if _, err := br.Exec(); err != nil {
			w.log.Error().Err(err).Msg("route entry batch exec error")
		}
	}
	return nil
}

// ── OSPF ──────────────────────────────────────────────────────────────────────

func (w *PostgresWriter) upsertOSPFNeighbours(ctx context.Context, deviceID uuid.UUID, neighbours []*model.OSPFNeighbour) error {
	batch := &pgx.Batch{}
	for _, n := range neighbours {
		batch.Queue(`
			INSERT INTO ospf_neighbors (
				device_id, neighbor_router_id, neighbor_ip,
				interface_name, area, state, priority, updated_at
			) VALUES (
				$1, $2::inet, $3::inet,
				$4, $5, $6::ospf_neighbor_state, $7, NOW()
			)
			ON CONFLICT (device_id, vrf, neighbor_router_id, interface_name) DO UPDATE SET
				neighbor_ip    = EXCLUDED.neighbor_ip,
				area           = EXCLUDED.area,
				state          = EXCLUDED.state,
				priority       = EXCLUDED.priority,
				last_state_change = CASE
					WHEN ospf_neighbors.state != EXCLUDED.state THEN NOW()
					ELSE ospf_neighbors.last_state_change
				END,
				updated_at     = NOW()
		`,
			deviceID,
			nullStr(n.RouterID), nullStr(n.NeighbourIP),
			&n.InterfaceName, nullStr(n.Area),  // InterfaceName: always store string (even "") so unique constraint fires
			n.State, n.Priority,
		)
	}
	br := w.pool.SendBatch(ctx, batch)
	defer br.Close()
	for i := 0; i < batch.Len(); i++ {
		if _, err := br.Exec(); err != nil {
			w.log.Error().Err(err).Msg("ospf neighbour batch exec error")
		}
	}
	return nil
}

// ── BGP ───────────────────────────────────────────────────────────────────────

func (w *PostgresWriter) upsertBGPSessions(ctx context.Context, deviceID uuid.UUID, sessions []*model.BGPSession) error {
	if len(sessions) == 0 {
		return nil
	}

	// Snapshot current state + flap_count so we can detect transitions.
	type snap struct {
		id        string
		peerIP    string
		state     string
		flapCount int64
	}
	snapRows, err := w.pool.Query(ctx,
		`SELECT id::text, peer_ip::text, session_state::text, flap_count FROM bgp_sessions WHERE device_id = $1`,
		deviceID,
	)
	prev := map[string]snap{}
	if err == nil {
		for snapRows.Next() {
			var sn snap
			if scanErr := snapRows.Scan(&sn.id, &sn.peerIP, &sn.state, &sn.flapCount); scanErr == nil {
				prev[sn.peerIP] = sn
			}
		}
		snapRows.Close()
	}

	// Upsert all sessions.
	batch := &pgx.Batch{}
	for _, s := range sessions {
		batch.Queue(`
			INSERT INTO bgp_sessions (
				device_id, peer_ip, peer_router_id, peer_description,
				local_asn, peer_asn,
				session_state, admin_status,
				prefixes_received,
				uptime_seconds,
				in_updates, out_updates,
				flap_count,
				updated_at
			) VALUES (
				$1, $2::inet, $3, $3,
				$4, $5,
				$6::bgp_session_state, $7,
				$8,
				$9,
				$10, $11,
				$12,
				NOW()
			)
			ON CONFLICT (device_id, vrf, peer_ip) DO UPDATE SET
				peer_router_id    = EXCLUDED.peer_router_id,
				peer_description  = EXCLUDED.peer_description,
				local_asn         = EXCLUDED.local_asn,
				peer_asn          = EXCLUDED.peer_asn,
				session_state     = EXCLUDED.session_state,
				admin_status      = EXCLUDED.admin_status,
				prefixes_received = EXCLUDED.prefixes_received,
				uptime_seconds    = EXCLUDED.uptime_seconds,
				in_updates        = EXCLUDED.in_updates,
				out_updates       = EXCLUDED.out_updates,
				flap_count        = EXCLUDED.flap_count,
				last_state_change = CASE
					WHEN bgp_sessions.session_state != EXCLUDED.session_state THEN NOW()
					ELSE bgp_sessions.last_state_change
				END,
				updated_at = NOW()
		`,
			deviceID,
			s.PeerIP,
			s.PeerRouterID,
			s.LocalASN, s.RemoteASN,
			s.State, s.AdminStatus,
			s.PrefixesReceived,
			s.UptimeSeconds,
			s.InUpdates, s.OutUpdates,
			s.FlapCount,
		)
	}
	br := w.pool.SendBatch(ctx, batch)
	defer br.Close()
	for i := 0; i < batch.Len(); i++ {
		if _, err := br.Exec(); err != nil {
			w.log.Error().Err(err).Msg("bgp session upsert error")
		}
	}

	// Log an event for every state transition detected since last poll.
	eventBatch := &pgx.Batch{}
	for _, s := range sessions {
		p, existed := prev[s.PeerIP]
		if existed && p.state != s.State {
			eventBatch.Queue(`
				INSERT INTO bgp_session_events (session_id, device_id, peer_ip, prev_state, new_state, recorded_at)
				SELECT id, $1, $2::inet, $3, $4, NOW() FROM bgp_sessions WHERE device_id = $1 AND peer_ip = $2::inet LIMIT 1
			`, deviceID, s.PeerIP, p.state, s.State)
			w.log.Info().
				Str("device_id", deviceID.String()).
				Str("peer_ip", s.PeerIP).
				Str("prev", p.state).Str("new", s.State).
				Msg("bgp state transition")
		}
	}
	if eventBatch.Len() > 0 {
		ebr := w.pool.SendBatch(ctx, eventBatch)
		defer ebr.Close()
		for i := 0; i < eventBatch.Len(); i++ {
			if _, err := ebr.Exec(); err != nil {
				w.log.Error().Err(err).Msg("bgp event insert error")
			}
		}
	}
	return nil
}

// ── Address tables ────────────────────────────────────────────────────────────

func (w *PostgresWriter) upsertARPEntries(ctx context.Context, deviceID uuid.UUID, entries []*model.ARPEntry) error {
	batch := &pgx.Batch{}
	for _, e := range entries {
		batch.Queue(`
			INSERT INTO arp_entries (device_id, ip_address, mac_address, interface_name, entry_type)
			VALUES ($1, $2::inet, $3::macaddr, $4, $5)
			ON CONFLICT (device_id, ip_address) DO UPDATE SET
				mac_address    = EXCLUDED.mac_address,
				interface_name = EXCLUDED.interface_name,
				entry_type     = EXCLUDED.entry_type,
				updated_at     = NOW()
		`, deviceID, e.IPAddress, e.MACAddress, nullStr(e.InterfaceName), e.EntryType)
	}
	br := w.pool.SendBatch(ctx, batch)
	defer br.Close()
	for i := 0; i < batch.Len(); i++ {
		if _, err := br.Exec(); err != nil {
			w.log.Error().Err(err).Msg("arp entry batch exec error")
		}
	}
	return nil
}

func (w *PostgresWriter) upsertMACEntries(ctx context.Context, deviceID uuid.UUID, entries []*model.MACEntry) error {
	batch := &pgx.Batch{}
	for _, e := range entries {
		batch.Queue(`
			INSERT INTO mac_entries (device_id, mac_address, port_name, entry_type)
			VALUES ($1, $2::macaddr, $3, $4)
			ON CONFLICT (device_id, mac_address) DO UPDATE SET
				port_name  = EXCLUDED.port_name,
				entry_type = EXCLUDED.entry_type,
				updated_at = NOW()
		`, deviceID, e.MACAddress, nullStr(e.PortName), e.EntryType)
	}
	br := w.pool.SendBatch(ctx, batch)
	defer br.Close()
	for i := 0; i < batch.Len(); i++ {
		if _, err := br.Exec(); err != nil {
			w.log.Error().Err(err).Msg("mac entry batch exec error")
		}
	}
	return nil
}

// ── Neighbours ────────────────────────────────────────────────────────────────

func (w *PostgresWriter) upsertLLDPNeighbors(ctx context.Context, deviceID uuid.UUID, neighbors []*model.LLDPNeighbor) error {
	batch := &pgx.Batch{}
	for _, n := range neighbors {
		capsJSON, _ := json.Marshal(n.Capabilities)
		var mgmtIP *string
		if n.MgmtIP != "" {
			mgmtIP = &n.MgmtIP
		}
		batch.Queue(`
			INSERT INTO lldp_neighbors (
				device_id, local_port_name,
				remote_chassis_id_subtype, remote_chassis_id,
				remote_port_id_subtype, remote_port_id, remote_port_desc,
				remote_system_name, remote_mgmt_ip, remote_system_capabilities
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (device_id, local_port_name, remote_chassis_id) DO UPDATE SET
				remote_chassis_id_subtype    = EXCLUDED.remote_chassis_id_subtype,
				remote_port_id_subtype       = EXCLUDED.remote_port_id_subtype,
				remote_port_id               = EXCLUDED.remote_port_id,
				remote_port_desc             = EXCLUDED.remote_port_desc,
				remote_system_name           = EXCLUDED.remote_system_name,
				remote_mgmt_ip               = EXCLUDED.remote_mgmt_ip,
				remote_system_capabilities   = EXCLUDED.remote_system_capabilities,
				updated_at                   = NOW()
		`,
			deviceID, n.LocalPort,
			safeStr(n.ChassisIDSubtype), safeStr(n.ChassisID),
			safeStr(n.PortIDSubtype), safeStr(n.PortID), safeStr(n.PortDesc),
			safeStr(n.SystemName), mgmtIP, capsJSON,
		)
	}

	br := w.pool.SendBatch(ctx, batch)
	defer br.Close()
	for i := 0; i < batch.Len(); i++ {
		if _, err := br.Exec(); err != nil {
			w.log.Error().Err(err).Msg("lldp neighbor batch exec error")
		}
	}
	return nil
}

func (w *PostgresWriter) upsertCDPNeighbors(ctx context.Context, deviceID uuid.UUID, neighbors []*model.CDPNeighbor) error {
	batch := &pgx.Batch{}
	for _, n := range neighbors {
		capsJSON, _ := json.Marshal(n.Capabilities)
		var mgmtIP *string
		if n.MgmtIP != "" {
			mgmtIP = &n.MgmtIP
		}
		var nativeVLAN *int
		if n.NativeVLAN > 0 {
			nativeVLAN = &n.NativeVLAN
		}
		batch.Queue(`
			INSERT INTO cdp_neighbors (
				device_id, local_port_name,
				remote_device_id, remote_port_id, remote_mgmt_ip,
				remote_platform, remote_capabilities, native_vlan, duplex
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (device_id, local_port_name, remote_device_id) DO UPDATE SET
				remote_port_id       = EXCLUDED.remote_port_id,
				remote_mgmt_ip       = EXCLUDED.remote_mgmt_ip,
				remote_platform      = EXCLUDED.remote_platform,
				remote_capabilities  = EXCLUDED.remote_capabilities,
				native_vlan          = EXCLUDED.native_vlan,
				duplex               = EXCLUDED.duplex,
				updated_at           = NOW()
		`,
			deviceID, n.LocalPort,
			safeStr(n.RemoteDevice), safeStr(n.RemotePort), mgmtIP,
			safeStr(n.Platform), capsJSON, nativeVLAN, safeStr(n.Duplex),
		)
	}

	br := w.pool.SendBatch(ctx, batch)
	defer br.Close()
	for i := 0; i < batch.Len(); i++ {
		if _, err := br.Exec(); err != nil {
			w.log.Error().Err(err).Msg("cdp neighbor batch exec error")
		}
	}
	return nil
}

// ── VLANs ─────────────────────────────────────────────────────────────────────

// upsertVLANs upserts per-device VLAN records and their interface memberships.
// Interface memberships are replaced in full: old rows for this device are
// deleted, then the current set is inserted.
func (w *PostgresWriter) upsertVLANs(ctx context.Context, deviceID uuid.UUID, vlans []*model.VLANResult, ifvlans []*model.InterfaceVLANResult) error {
	// Upsert each VLAN name record.
	if len(vlans) > 0 {
		batch := &pgx.Batch{}
		for _, v := range vlans {
			batch.Queue(`
				INSERT INTO vlans (device_id, vlan_id, name, updated_at)
				VALUES ($1, $2, $3, NOW())
				ON CONFLICT (device_id, vlan_id) DO UPDATE SET
					name       = EXCLUDED.name,
					updated_at = EXCLUDED.updated_at
			`, deviceID, v.VlanID, v.Name)
		}
		br := w.pool.SendBatch(ctx, batch)
		defer br.Close()
		for i := 0; i < batch.Len(); i++ {
			if _, err := br.Exec(); err != nil {
				w.log.Error().Err(err).Msg("vlan batch exec error")
			}
		}
	}

	// Replace interface_vlans for this device atomically.
	// 1) Delete all current rows for this device's interfaces.
	if _, err := w.pool.Exec(ctx, `
		DELETE FROM interface_vlans
		WHERE interface_id IN (
			SELECT id FROM interfaces WHERE device_id = $1
		)
	`, deviceID); err != nil {
		return fmt.Errorf("delete interface_vlans: %w", err)
	}

	// 2) Insert the fresh set, resolving ifIndex → interface_id inline.
	if len(ifvlans) > 0 {
		batch := &pgx.Batch{}
		for _, iv := range ifvlans {
			batch.Queue(`
				INSERT INTO interface_vlans (interface_id, vlan_id, tagged)
				SELECT id, $2, $3 FROM interfaces WHERE device_id = $1 AND if_index = $4
				ON CONFLICT (interface_id, vlan_id) DO UPDATE SET
					tagged = EXCLUDED.tagged
			`, deviceID, iv.VlanID, iv.Tagged, iv.IfIndex)
		}
		br2 := w.pool.SendBatch(ctx, batch)
		defer br2.Close()
		for i := 0; i < batch.Len(); i++ {
			if _, err := br2.Exec(); err != nil {
				w.log.Error().Err(err).Msg("interface_vlan batch exec error")
			}
		}
	}

	return nil
}

// ── STP ───────────────────────────────────────────────────────────────────────

// upsertSTPPorts upserts per-interface STP state rows, resolving ifIndex to
// interface_id via the interfaces table.
func (w *PostgresWriter) upsertSTPPorts(ctx context.Context, deviceID uuid.UUID, ports []*model.STPPortResult) error {
	batch := &pgx.Batch{}
	now := time.Now()
	for _, p := range ports {
		batch.Queue(`
			INSERT INTO interface_stp (interface_id, stp_state, stp_role, updated_at)
			SELECT id, $2, $3, $4 FROM interfaces WHERE device_id = $1 AND if_index = $5
			ON CONFLICT (interface_id) DO UPDATE SET
				stp_state  = EXCLUDED.stp_state,
				stp_role   = EXCLUDED.stp_role,
				updated_at = EXCLUDED.updated_at
		`, deviceID, p.State, p.Role, now, p.IfIndex)
	}
	br := w.pool.SendBatch(ctx, batch)
	defer br.Close()
	for i := 0; i < batch.Len(); i++ {
		if _, err := br.Exec(); err != nil {
			w.log.Error().Err(err).Msg("interface_stp batch exec error")
		}
	}
	return nil
}

// ── DeviceSource implementation ───────────────────────────────────────────────

// LoadDevices reads all active SNMP-capable devices and their first-priority
// credential from PostgreSQL. It implements poller.DeviceSource.
func (w *PostgresWriter) LoadDevices(ctx context.Context) ([]model.DeviceRow, error) {
	rows, err := w.pool.Query(ctx, `
		SELECT
			d.id,
			host(d.mgmt_ip),
			d.snmp_version::text,
			d.snmp_port,
			d.polling_interval_s,
			c.type::text   AS cred_type,
			c.data::text   AS cred_data
		FROM devices d
		JOIN device_credentials dc ON dc.device_id = d.id
		JOIN credentials c ON c.id = dc.credential_id
		WHERE
			d.is_active = true
			AND d.collection_method IN ('snmp', 'both')
			AND c.type IN ('snmp_v2c', 'snmp_v3')
		ORDER BY d.id, dc.priority ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("query devices: %w", err)
	}
	defer rows.Close()

	// Multiple credential rows per device — keep only the first (lowest priority).
	seen := make(map[uuid.UUID]bool)
	var devices []model.DeviceRow

	for rows.Next() {
		var dr model.DeviceRow
		var ipStr, versionStr, credType, credDataStr string
		if err := rows.Scan(&dr.ID, &ipStr, &versionStr, &dr.SNMPPort,
			&dr.PollingIntervalS, &credType, &credDataStr); err != nil {
			return nil, fmt.Errorf("scan device row: %w", err)
		}
		if seen[dr.ID] {
			continue
		}
		seen[dr.ID] = true
		dr.MgmtIP = ipStr
		dr.SNMPVersion = versionStr
		dr.CredentialType = credType
		dr.CredentialData = []byte(credDataStr)
		devices = append(devices, dr)
	}
	return devices, rows.Err()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func avgCPU(samples []model.CPUSample) *float64 {
	if len(samples) == 0 {
		return nil
	}
	var sum float64
	for _, s := range samples {
		sum += s.LoadPct
	}
	avg := sum / float64(len(samples))
	return &avg
}

func sumMemory(samples []model.MemorySample) (used, total uint64) {
	for _, s := range samples {
		if s.Type == "ram" {
			used += s.UsedBytes
			total += s.TotalBytes
		}
	}
	return
}

func marshalTemps(samples []model.TempSample) []byte {
	type entry struct {
		Sensor  string  `json:"sensor"`
		Celsius float64 `json:"celsius"`
		OK      bool    `json:"ok"`
	}
	entries := make([]entry, 0, len(samples))
	for _, s := range samples {
		entries = append(entries, entry{Sensor: s.SensorName, Celsius: s.Celsius, OK: s.StatusOK})
	}
	b, _ := json.Marshal(entries)
	return b
}

// ifName returns the best available interface name (ifName preferred, then ifDescr).
func ifName(i *model.InterfaceResult) string {
	if i.IfName != "" {
		return i.IfName
	}
	return i.IfDescr
}

func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// safeStr strips null bytes and invalid UTF-8 before DB insert.
// Some SNMP OctetString fields (CDP platform/port) contain raw binary data.
func safeStr(s string) *string {
	safe := strings.ToValidUTF8(strings.ReplaceAll(s, "\x00", ""), "")
	if safe == "" {
		return nil
	}
	return &safe
}

func nullUint64(v uint64) *uint64 {
	if v == 0 {
		return nil
	}
	return &v
}

func nullInt(v int) *int {
	if v == 0 {
		return nil
	}
	return &v
}

func marshalIPs(ips []model.InterfaceIP) []byte {
	type entry struct {
		Address   string `json:"address"`
		PrefixLen int    `json:"prefix_len"`
		Version   int    `json:"version"`
	}
	entries := make([]entry, 0, len(ips))
	for _, ip := range ips {
		entries = append(entries, entry{ip.Address, ip.PrefixLen, ip.Version})
	}
	b, _ := json.Marshal(entries)
	return b
}

