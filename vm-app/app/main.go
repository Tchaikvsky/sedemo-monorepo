// nav-service is a small fund NAV pricing service used to demonstrate
// Kargo-driven deployments to virtual machines.
package main

import (
	"flag"
	"log"
	"net/http"
	"time"
)

// version is set at build time: -ldflags "-X main.version=<v>".
var version = "dev"

func main() {
	configPath := flag.String("config", "/etc/nav-service/config.yaml", "path to the config file")
	flag.Parse()

	cfg, raw, err := LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("nav-service: %v", err)
	}
	// A semantically invalid config still starts the server so /healthz can
	// report the problem.
	if err := cfg.Validate(); err != nil {
		log.Printf("nav-service: config invalid, /healthz will fail: %v", err)
	}

	addr := cfg.Service.ListenAddr
	if addr == "" {
		addr = ":8080"
	}
	srv := &http.Server{
		Addr:              addr,
		Handler:           NewServer(cfg, raw, version),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("nav-service %s (stage %q) listening on %s", version, cfg.Service.Stage, addr)
	log.Fatal(srv.ListenAndServe())
}
