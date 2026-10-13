package main

import (
	"os"
	"path/filepath"
	"testing"
)

const validConfig = `service:
  stage: dev
  listenAddr: ":8080"
pricing:
  feedUrl: https://feeds.example.com/nav
  currency: CAD
  navCutoff: "16:00 ET"
  roundingDecimals: 4
database:
  host: db-dev.internal.example
  name: nav_dev
`

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadConfig_Valid(t *testing.T) {
	cfg, raw, err := LoadConfig(writeTemp(t, validConfig))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(raw) != validConfig {
		t.Errorf("raw bytes not returned verbatim")
	}
	want := Config{
		Service:  ServiceConfig{Stage: "dev", ListenAddr: ":8080"},
		Pricing:  PricingConfig{FeedURL: "https://feeds.example.com/nav", Currency: "CAD", NavCutoff: "16:00 ET", RoundingDecimals: 4},
		Database: DatabaseConfig{Host: "db-dev.internal.example", Name: "nav_dev"},
	}
	if cfg != want {
		t.Errorf("got %+v, want %+v", cfg, want)
	}
}

func TestLoadConfig_MalformedYAML(t *testing.T) {
	if _, _, err := LoadConfig(writeTemp(t, "service: [unclosed\n  stage: : :\n")); err == nil {
		t.Fatal("expected error for malformed YAML")
	}
}

func TestLoadConfig_MissingFile(t *testing.T) {
	if _, _, err := LoadConfig(filepath.Join(t.TempDir(), "nope.yaml")); err == nil {
		t.Fatal("expected error for missing file")
	}
}
