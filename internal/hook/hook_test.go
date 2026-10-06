package hook

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/mcpclient/mcptest"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/testprovider"
)

func TestMain(m *testing.M) {
	mcptest.MaybeServe()
	os.Exit(m.Run())
}

func payload(runtime, tool string) []byte {
	p := map[string]any{"tool_name": tool, "session_id": "session", "tool_use_id": "call", "tool_call_id": "call", "tool_input": map[string]any{"amount": json.Number("9007199254740993")}, "arguments": map[string]any{"amount": json.Number("9007199254740993")}, "params": map[string]any{"amount": json.Number("9007199254740993")}, "hook_event_name": "PreToolUse"}
	if runtime == "hermes" {
		p["hook_event_name"] = "pre_tool_call"
		p["extra"] = map[string]any{"tool_call_id": "call"}
	}
	raw, _ := json.Marshal(p)
	return raw
}
func denied(out string) bool {
	return strings.Contains(out, `"deny"`) || strings.Contains(out, `"block"`)
}
func TestSixRuntimeHooks(t *testing.T) {
	for _, key := range []string{"claude-code", "codex", "deepseek", "hermes", "openclaw", "pi"} {
		t.Run(key, func(t *testing.T) {
			p := testprovider.New(t)
			c := p.Client(t)
			// Each runtime's own spelling of the same Stripe tool.
			name, wantServer := "mcp__stripe__create_refund", "stripe"
			switch key {
			case "openclaw":
				name = "stripe__create_refund"
			case "pi":
				name, wantServer = "create_refund", ""
			}
			raw := payload(key, name)
			var out bytes.Buffer
			if err := Run(context.Background(), key, c, raw, &out); err != nil || denied(out.String()) {
				t.Fatalf("approval %s: %v", out.String(), err)
			}
			in := p.Inputs()[0]
			wantTimeout := "604800s"
			if key == "hermes" {
				wantTimeout = "270s"
			}
			if in.Timeout != wantTimeout {
				t.Fatalf("approval timeout = %s, want %s", in.Timeout, wantTimeout)
			}
			if in.Tool != "create_refund" || in.Server != wantServer || in.Context["mcp_server"] != nil || in.Context["runtime"] != key || in.Arguments["amount"] != json.Number("9007199254740993") {
				t.Fatalf("submission %+v", in)
			}
			out.Reset()
			if err := Run(context.Background(), key, c, raw, &out); err != nil || !denied(out.String()) {
				t.Fatalf("replay %s: %v", out.String(), err)
			}
			c.ToolGlob = "read_*"
			out.Reset()
			Run(context.Background(), key, c, raw, &out)
			if denied(out.String()) {
				t.Fatalf("nonmatching blocked %s", out.String())
			}
			n, _ := p.Counts()
			if n != 2 {
				t.Fatalf("filtered call contacted provider (%d)", n)
			}
			for _, bad := range []string{`{`, `{}`, `{"tool_name":"x"}`} {
				out.Reset()
				Run(context.Background(), key, c, []byte(bad), &out)
				if !denied(out.String()) {
					t.Fatalf("malformed call passed: %s", bad)
				}
			}
		})
	}
}
func TestPluginApprovalWindows(t *testing.T) {
	for _, key := range []string{"pi", "openclaw"} {
		for _, tc := range []struct {
			name    string
			ceiling int64
			want    string
		}{
			{"week", 604830000, "604800s"},
			{"custom", 60000, "30s"},
		} {
			t.Run(key+"/"+tc.name, func(t *testing.T) {
				p := testprovider.New(t)
				var input map[string]any
				if err := aap.Decode(payload(key, "tool"), &input); err != nil {
					t.Fatal(err)
				}
				input["timeout_ms"] = tc.ceiling
				raw, err := json.Marshal(input)
				if err != nil {
					t.Fatal(err)
				}
				var out bytes.Buffer
				if err := Run(context.Background(), key, p.Client(t), raw, &out); err != nil || denied(out.String()) {
					t.Fatalf("approval %s: %v", out.String(), err)
				}
				if got := p.Inputs()[0].Timeout; got != tc.want {
					t.Fatalf("approval timeout = %s, want %s", got, tc.want)
				}
			})
		}
	}
}
func TestOpenClawServerNormalization(t *testing.T) {
	p := testprovider.New(t)
	c := p.Client(t)
	c.ToolGlob = "create_*"
	var out bytes.Buffer
	Run(context.Background(), "openclaw", c, payload("openclaw", "stripe__create_refund"), &out)
	if denied(out.String()) || len(p.Inputs()) != 1 || p.Inputs()[0].Tool != "create_refund" {
		t.Fatal(out.String())
	}
}

// Codex hands its hook sanitised names. With the server in Codex's config
// the hook lists it once and submits the server-defined name and alias.
func TestCodexRecoversServerDefinedNames(t *testing.T) {
	home := filepath.Join(t.TempDir(), ".codex")
	command, env := mcptest.Command()
	config := "[mcp_servers.\"google-mail\"]\ncommand = " + strconv.Quote(command) + "\n[mcp_servers.\"google-mail\".env]\n"
	for key, value := range env {
		config += key + " = " + strconv.Quote(value) + "\n"
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", home)
	p := testprovider.New(t)
	c := p.Client(t)
	var out bytes.Buffer
	if err := Run(context.Background(), "codex", c, payload("codex", "mcp__google_mail__gmail_send_email"), &out); err != nil || denied(out.String()) {
		t.Fatalf("approval %s: %v", out.String(), err)
	}
	in := p.Inputs()[0]
	if in.Tool != "gmail.send_email" || in.Server != "google-mail" {
		t.Fatalf("submission %+v", in)
	}
	if _, err := os.Stat(filepath.Join(c.CacheDir, "codex-tools.json")); err != nil {
		t.Fatalf("listing not cached: %v", err)
	}
}

func TestCodexPermissionBypassPreservesLocalPrompt(t *testing.T) {
	p := testprovider.New(t)
	c := p.Client(t)
	c.ToolGlob = "other"
	raw := bytes.ReplaceAll(payload("codex", "Bash"), []byte("PreToolUse"), []byte("PermissionRequest"))
	var out bytes.Buffer
	Run(context.Background(), "codex", c, raw, &out)
	if out.Len() != 0 {
		t.Fatalf("bypass overrode local permission: %s", out.String())
	}
}
func TestNativeDeniedOutcomes(t *testing.T) {
	for _, status := range []aap.Status{aap.StatusDenied, aap.StatusExpired, aap.StatusCancelled} {
		for _, key := range []string{"claude-code", "codex", "deepseek", "hermes", "openclaw", "pi"} {
			t.Run(key+"/"+string(status), func(t *testing.T) {
				p := testprovider.New(t)
				p.Status = status
				var out bytes.Buffer
				Run(context.Background(), key, p.Client(t), payload(key, "tool"), &out)
				if !denied(out.String()) {
					t.Fatalf("%s", out.String())
				}
			})
		}
	}
}
func TestRefusedCredentialNamesEject(t *testing.T) {
	for _, key := range []string{"claude-code", "codex", "deepseek", "hermes", "openclaw", "pi"} {
		t.Run(key, func(t *testing.T) {
			p := testprovider.New(t)
			c := p.Client(t)
			c.Token = "revoked-token"
			c.EjectCommand = "provider agent eject " + key
			var out bytes.Buffer
			if err := Run(context.Background(), key, c, payload(key, "mcp__stripe__create_refund"), &out); err != nil {
				t.Fatal(err)
			}
			if !denied(out.String()) || !strings.Contains(out.String(), "provider agent eject "+key) {
				t.Fatalf("refused credential: %s", out.String())
			}
		})
	}
}
