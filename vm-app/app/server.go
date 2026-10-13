package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"html/template"
	"net/http"
)

var indexTmpl = template.Must(template.New("index").Parse(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>nav-service ({{.Stage}})</title></head>
<body style="font-family: sans-serif; margin: 2rem">
<h1>Fund NAV pricing service</h1>
<table>
<tr><th align="left">Version</th><td>{{.Version}}</td></tr>
<tr><th align="left">Stage</th><td>{{.Stage}}</td></tr>
<tr><th align="left">Currency</th><td>{{.Currency}}</td></tr>
<tr><th align="left">NAV cutoff</th><td>{{.NavCutoff}}</td></tr>
<tr><th align="left">Database host</th><td>{{.DatabaseHost}}</td></tr>
<tr><th align="left">Config hash</th><td>{{.ConfigHash}}</td></tr>
<tr><th align="left">Health</th><td>{{.Health}}</td></tr>
</table>
</body>
</html>
`))

// NewServer returns the HTTP handler. raw is the config file content, used for
// the configHash fingerprint.
func NewServer(cfg Config, raw []byte, version string) http.Handler {
	sum := sha256.Sum256(raw)
	configHash := hex.EncodeToString(sum[:])[:12]

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if err := cfg.Validate(); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(err.Error() + "\n"))
			return
		}
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"version":    version,
			"stage":      cfg.Service.Stage,
			"configHash": configHash,
		})
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		health := "ok"
		if err := cfg.Validate(); err != nil {
			health = err.Error()
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_ = indexTmpl.Execute(w, map[string]string{
			"Version":      version,
			"Stage":        cfg.Service.Stage,
			"Currency":     cfg.Pricing.Currency,
			"NavCutoff":    cfg.Pricing.NavCutoff,
			"DatabaseHost": cfg.Database.Host,
			"ConfigHash":   configHash,
			"Health":       health,
		})
	})
	return mux
}
