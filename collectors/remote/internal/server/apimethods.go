package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/httpstofu"
)

// ── /api-probe ────────────────────────────────────────────────────────────────
//
// Probes a device's REST or eAPI endpoint from the collector's LAN and returns
// whether the service is listening.  The hub uses this to update
// device_api_methods.reachable for collector-managed devices instead of
// attempting a direct HTTP probe it can't reach.

type apiProbeReq struct {
	IP     string `json:"ip"`
	Method string `json:"method"`
}

type apiProbeResp struct {
	Reachable bool   `json:"reachable"`
	Error     string `json:"error,omitempty"`
}

// probeURLs maps api-method name → ordered list of URLs to try.
// Any HTTP response (including 401/403/404) means the service is up.
var probeURLs = map[string][]string{
	"arista_eapi": {
		"http://{ip}/command-api",
		"https://{ip}/command-api",
	},
	"aruba_cx_rest": {
		"https://{ip}/rest/v10.04/",
		"https://{ip}/rest/v10.08/",
	},
}

func replaceIP(tmpl, ip string) string {
	out := make([]byte, 0, len(tmpl))
	for i := 0; i < len(tmpl); i++ {
		if tmpl[i] == '{' && i+3 < len(tmpl) && tmpl[i:i+4] == "{ip}" {
			out = append(out, ip...)
			i += 3
		} else {
			out = append(out, tmpl[i])
		}
	}
	return string(out)
}

func (s *Server) handleAPIProbe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}

	var req apiProbeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.IP == "" || req.Method == "" {
		http.Error(w, "ip and method are required", http.StatusBadRequest)
		return
	}

	urls, ok := probeURLs[req.Method]
	if !ok {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(apiProbeResp{
			Reachable: false,
			Error:     "unknown method: " + req.Method,
		})
		return
	}

	var lastErr string
	for _, tmpl := range urls {
		target := replaceIP(tmpl, req.IP)
		hostPort := req.IP + ":443"
		client := &http.Client{
			Timeout: 5 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: httpstofu.PinningConfig(hostPort),
			},
		}
		resp, err := client.Get(target)
		if err == nil {
			resp.Body.Close()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(apiProbeResp{Reachable: true})
			return
		}
		lastErr = target + ": " + err.Error()
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(apiProbeResp{Reachable: false, Error: lastErr})
}
