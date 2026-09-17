package runtimes

import "testing"

// The expected value was read from a ~/.codex/config.toml where Codex
// itself had recorded trust for this exact hook definition.
func TestCodexTrustHashMatchesCodex(t *testing.T) {
	got := codexTrustHash("shell", "/Users/chris/.local/bin/withhuman hook codex --agent codex", 600)
	want := "sha256:cf81fb8134b07849e96dd07cf01bcc5381364de20c03a6be0fd8f8ec0992e532"
	if got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
	if codexTrustHash("", "x", 600) == codexTrustHash("m", "x", 600) {
		t.Fatal("matcher must be part of the identity")
	}
	if key := codexTrustKey("/home/u/.codex/config.toml", 2, 0); key != "/home/u/.codex/config.toml:pre_tool_use:2:0" {
		t.Fatalf("key: %s", key)
	}
}
