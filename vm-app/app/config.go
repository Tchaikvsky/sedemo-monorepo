package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"

	"gopkg.in/yaml.v3"
)

// Config is the schema of /etc/nav-service/config.yaml, rendered per stage by
// the nav-config Helm chart.
type Config struct {
	Service  ServiceConfig  `yaml:"service"`
	Pricing  PricingConfig  `yaml:"pricing"`
	Database DatabaseConfig `yaml:"database"`
}

type ServiceConfig struct {
	Stage      string `yaml:"stage"`
	ListenAddr string `yaml:"listenAddr"`
}

type PricingConfig struct {
	FeedURL          string `yaml:"feedUrl"`
	Currency         string `yaml:"currency"`
	NavCutoff        string `yaml:"navCutoff"`
	RoundingDecimals int    `yaml:"roundingDecimals"`
}

type DatabaseConfig struct {
	Host string `yaml:"host"`
	Name string `yaml:"name"`
}

// LoadConfig reads and parses the config file. It returns the raw bytes so the
// caller can fingerprint exactly what is on disk. Only malformed YAML (or an
// unreadable file) is an error here; semantic problems are reported by Validate.
func LoadConfig(path string) (Config, []byte, error) {
	var cfg Config
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg, nil, fmt.Errorf("read config: %w", err)
	}
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return cfg, nil, fmt.Errorf("parse config %s: %w", path, err)
	}
	return cfg, raw, nil
}

// Validate checks the config semantically. The only rule: pricing.feedUrl must
// be an https URL with a host. Deterministic, no network access.
func (c Config) Validate() error {
	u, err := url.Parse(c.Pricing.FeedURL)
	if err != nil {
		return fmt.Errorf("pricing.feedUrl %q is not a valid URL: %v", c.Pricing.FeedURL, err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf("pricing.feedUrl %q must use the https scheme", c.Pricing.FeedURL)
	}
	if u.Host == "" {
		return errors.New("pricing.feedUrl must include a host")
	}
	return nil
}
