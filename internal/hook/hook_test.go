package hook

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/testprovider"
)

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
			raw := payload(key, "mcp__stripe__create_refund")
			var out bytes.Buffer
			if err := Run(context.Background(), key, c, raw, &out); err != nil || denied(out.String()) {
				t.Fatalf("approval %s: %v", out.String(), err)
			}
			in := p.Inputs()[0]
			if in.Tool != "create_refund" || in.Context["mcp_server"] != "stripe" || in.Context["runtime"] != key || in.Arguments["amount"] != json.Number("9007199254740993") {
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
