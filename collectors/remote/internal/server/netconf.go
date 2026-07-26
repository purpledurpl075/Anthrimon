package server

// /netconf: a generic NETCONF RPC-sequence executor.
//
// For collector-managed Junos devices the hub can't reach the device's
// NETCONF port directly (it's on a remote LAN), so the collector opens one
// NETCONF-over-SSH session and runs an ordered list of raw RPC bodies the
// hub supplies, returning each <rpc-reply>. All Junos-specific knowledge —
// which RPCs to send, in what order, how to interpret a reply as success or
// failure — stays on the hub (configmgmt/netconf.py); this endpoint mirrors
// /config-exec's and /aoscx-rest's "thin executor" shape, just for NETCONF's
// RPC/XML transport instead of SSH-CLI or REST.
//
// A transport-level failure (dial, auth, a single RPC send/receive erroring)
// aborts the remaining RPCs — there's no point sending a commit after the
// session died. An RPC reply containing <rpc-error> is NOT treated as
// failure here: many Junos replies carry rpc-error at "warning" severity
// (e.g. missing licenses) alongside a real result, so severity/success
// interpretation is left entirely to the hub-side caller, exactly as the
// SSH-recipe path leaves "did the commit really succeed" to the hub.

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/netconf"
)

type netconfRPCReq struct {
	Body     string  `json:"body"`      // inner RPC XML, no <rpc> wrapper
	TimeoutS float64 `json:"timeout_s"` // 0 = use default
}

type netconfExecReq struct {
	DeviceIP string          `json:"device_ip"`
	Port     int             `json:"port"` // 0 = default 830
	Username string          `json:"username"`
	Password string          `json:"password"`
	RPCs     []netconfRPCReq `json:"rpcs"`
}

type netconfExecResp struct {
	Replies []string `json:"replies"`
	Error   string   `json:"error,omitempty"`
}

func (s *Server) handleNetconf(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}

	var req netconfExecReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.DeviceIP == "" || req.Username == "" || len(req.RPCs) == 0 {
		http.Error(w, "device_ip, username and at least one rpc are required", http.StatusBadRequest)
		return
	}
	port := req.Port
	if port == 0 {
		port = 830
	}

	s.log.Info().
		Str("device", req.DeviceIP).
		Int("rpcs", len(req.RPCs)).
		Msg("netconf-exec requested")

	sess, err := netconf.Dial(req.DeviceIP, port, req.Username, req.Password, 15*time.Second)
	if err != nil {
		s.log.Warn().Err(err).Str("device", req.DeviceIP).Msg("netconf-exec dial failed")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(netconfExecResp{Error: "dial: " + err.Error()})
		return
	}
	defer sess.Close()

	replies := make([]string, 0, len(req.RPCs))
	for i, rpc := range req.RPCs {
		timeout := 20 * time.Second
		if rpc.TimeoutS > 0 {
			timeout = time.Duration(rpc.TimeoutS * float64(time.Second))
		}
		reply, err := sess.RPC(rpc.Body, timeout)
		if err != nil {
			s.log.Warn().Err(err).Str("device", req.DeviceIP).Int("step", i).Msg("netconf-exec rpc failed")
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(netconfExecResp{
				Replies: replies,
				Error:   err.Error(),
			})
			return
		}
		replies = append(replies, reply)
	}

	s.log.Info().Str("device", req.DeviceIP).Int("rpcs", len(replies)).Msg("netconf-exec complete")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(netconfExecResp{Replies: replies})
}
