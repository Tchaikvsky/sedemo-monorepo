package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testConfig(feedURL string) Config {
	return Config{
		Service:  ServiceConfig{Stage: "dev", ListenAddr: ":8080"},
		Pricing:  PricingConfig{FeedURL: feedURL, Currency: "CAD", NavCutoff: "16:00 ET", RoundingDecimals: 4},
		Database: DatabaseConfig{Host: "db-dev.internal.example", Name: "nav_dev"},
	}
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestHealthz_ValidFeedURL(t *testing.T) {
	rec := get(t, NewServer(testConfig("https://feeds.example.com/nav"), []byte("x"), "1.0.0"), "/healthz")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
	}
	if strings.TrimSpace(rec.Body.String()) != "ok" {
		t.Errorf("body = %q, want ok", rec.Body.String())
	}
}

func TestHealthz_InvalidFeedURL(t *testing.T) {
	for _, u := range []string{"htps://feeds.example.com/nav", "http://feeds.example.com/nav", "", "not a url"} {
		t.Run(u, func(t *testing.T) {
			rec := get(t, NewServer(testConfig(u), []byte("x"), "1.0.0"), "/healthz")
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500", rec.Code)
			}
			if !strings.Contains(rec.Body.String(), "pricing.feedUrl") {
				t.Errorf("body %q does not mention pricing.feedUrl", rec.Body.String())
			}
		})
	}
}

func TestVersion(t *testing.T) {
	rec := get(t, NewServer(testConfig("https://feeds.example.com/nav"), []byte(validConfig), "1.2.3"), "/version")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}
	var v struct {
		Version    string `json:"version"`
		Stage      string `json:"stage"`
		ConfigHash string `json:"configHash"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if v.Version != "1.2.3" || v.Stage != "dev" {
		t.Errorf("got %+v", v)
	}
	if len(v.ConfigHash) != 12 {
		t.Errorf("configHash %q has length %d, want 12", v.ConfigHash, len(v.ConfigHash))
	}
	// sha256("...validConfig...") prefix must be deterministic and differ for different bytes
	other := get(t, NewServer(testConfig("https://feeds.example.com/nav"), []byte(validConfig+"#"), "1.2.3"), "/version")
	if strings.Contains(other.Body.String(), v.ConfigHash) {
		t.Errorf("configHash did not change when config bytes changed")
	}
}

func TestIndex(t *testing.T) {
	rec := get(t, NewServer(testConfig("https://feeds.example.com/nav"), []byte("x"), "1.0.0"), "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{"dev", "CAD", "1.0.0", "16:00 ET", "db-dev.internal.example"} {
		if !strings.Contains(body, want) {
			t.Errorf("index body missing %q", want)
		}
	}
}

func TestUnknownPath404(t *testing.T) {
	rec := get(t, NewServer(testConfig("https://feeds.example.com/nav"), []byte("x"), "1.0.0"), "/nope")
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}
