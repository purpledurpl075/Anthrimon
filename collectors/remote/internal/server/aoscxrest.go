package server

// /aoscx-rest: a generic ArubaOS-CX REST passthrough.
//
// For collector-managed AOS-CX devices the hub can't reach the device's REST
// API directly (it's on a remote LAN), so the collector — which already
// maintains a cookie-authenticated REST session for BGP/OSPF/route polling
// (see internal/collector/rest_aruba.go) — performs the request on the hub's
// behalf and returns the raw status/body.  All AOS-CX REST knowledge (which
// paths to call, how to interpret the response) stays on the hub; this
// endpoint is a thin "log in and do one GET/PUT" executor.

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/collector"
)

type aoscxRestReq struct {
	DeviceIP string            `json:"device_ip"`
	Username string            `json:"username"`
	Password string            `json:"password"`
	Method   string            `json:"method"` // GET | PUT
	Path     string            `json:"path"`   // e.g. "/fullconfigs/running-config"
	Params   map[string]string `json:"params,omitempty"`
	Body     json.RawMessage   `json:"body,omitempty"`
}

type aoscxRestResp struct {
	StatusCode int             `json:"status_code"`
	Body       json.RawMessage `json:"body,omitempty"`
	Error      string          `json:"error,omitempty"`
}

func (s *Server) handleAOSCXRest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}

	var req aoscxRestReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.DeviceIP == "" || req.Username == "" || req.Path == "" {
		http.Error(w, "device_ip, username and path are required", http.StatusBadRequest)
		return
	}
	method := strings.ToUpper(req.Method)
	if method != http.MethodGet && method != http.MethodPut {
		http.Error(w, "method must be GET or PUT", http.StatusBadRequest)
		return
	}

	s.log.Info().
		Str("device", req.DeviceIP).
		Str("method", method).
		Str("path", req.Path).
		Msg("aoscx-rest requested")

	ac := collector.NewArubaClient(req.DeviceIP, req.Username, req.Password)
	if err := ac.Login(r.Context()); err != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(aoscxRestResp{Error: "login: " + err.Error()})
		return
	}
	defer ac.Logout(r.Context())

	params := url.Values{}
	for k, v := range req.Params {
		params.Set(k, v)
	}

	var (
		status int
		body   []byte
		err    error
	)
	switch method {
	case http.MethodGet:
		var result any
		result, err = ac.Get(r.Context(), req.Path, params)
		if err == nil {
			status = http.StatusOK
			body, err = json.Marshal(result)
		}
	case http.MethodPut:
		var rawBody any
		if len(req.Body) > 0 {
			if uerr := json.Unmarshal(req.Body, &rawBody); uerr != nil {
				http.Error(w, "invalid body JSON: "+uerr.Error(), http.StatusBadRequest)
				return
			}
		}
		status, body, err = ac.Put(r.Context(), req.Path, params, rawBody)
	}

	if err != nil {
		s.log.Warn().Err(err).Str("device", req.DeviceIP).Str("path", req.Path).Msg("aoscx-rest failed")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(aoscxRestResp{StatusCode: status, Error: err.Error()})
		return
	}

	resp := aoscxRestResp{StatusCode: status}
	if len(body) > 0 {
		resp.Body = json.RawMessage(body)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
