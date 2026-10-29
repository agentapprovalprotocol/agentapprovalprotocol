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

func geminiPayload(tool string, mcp map[string]any) []byte {
	p := map[string]any{
		"hook_event_name": "BeforeTool", "session_id": "session", "cwd": "/work", "timestamp": "2026-10-29T12:00:00Z",
		"transcript_path": "/tmp/t.json", "tool_name": tool, "tool_input": map[string]any{"amount": json.Number("9007199254740993")},
	}
	if mcp != nil {
		p["mcp_context"] = mcp
	}
	raw, _ := json.Marshal(p)
	return raw
}

func antigravityPayload(tool string, args map[string]any, step int) []byte {
	raw, _ := json.Marshal(map[string]any{
		"conversationId": "conversation", "stepIdx": step, "workspacePaths": []string{"/work"},
		"transcriptPath": "/tmp/t.jsonl", "modelName": "auto", "toolCall": map[string]any{"name": tool, "args": args},
	})
	return raw
}

func TestGeminiHook(t *testing.T) {
	p := testprovider.New(t)
	c := p.Client(t)
	// Gemini's own spelling of an MCP tool; the identity comes from mcp_context.
	raw := geminiPayload("mcp_stripe_create_refund", map[string]any{"server_name": "stripe", "tool_name": "create_refund", "command": "stripe-mcp"})
	var out bytes.Buffer
	if err := Run(context.Background(), "gemini", c, raw, &out); err != nil || strings.TrimSpace(out.String()) != "{}" {
		t.Fatalf("approval %q: %v", out.String(), err)
	}
	in := p.Inputs()[0]
	if in.Tool != "create_refund" || in.Server != "stripe" || in.Context["runtime"] != "gemini" || in.Context["cwd"] != "/work" ||
		in.Timeout != "604800s" || in.Arguments["amount"] != json.Number("9007199254740993") {
		t.Fatalf("submission %+v", in)
	}

	// Without a call ID every invocation is a fresh request, not a replay
	// of the spent approval.
	out.Reset()
	if err := Run(context.Background(), "gemini", c, raw, &out); err != nil || denied(out.String()) || len(p.Inputs()) != 2 {
		t.Fatalf("second invocation %q: %v", out.String(), err)
	}

	out.Reset()
	Run(context.Background(), "gemini", c, geminiPayload("run_shell_command", nil), &out)
	if in := p.Inputs()[2]; in.Tool != "run_shell_command" || in.Server != "" {
		t.Fatalf("built-in submission %+v", in)
	}

	for _, bad := range []string{`{`, `{}`, `{"tool_name":"x"}`, strings.Replace(string(raw), "BeforeTool", "AfterTool", 1)} {
		out.Reset()
		Run(context.Background(), "gemini", c, []byte(bad), &out)
		if !strings.Contains(out.String(), `"decision":"deny"`) {
			t.Fatalf("malformed call passed: %s -> %s", bad, out.String())
		}
	}
}

func TestAntigravityHook(t *testing.T) {
	p := testprovider.New(t)
	c := p.Client(t)
	// Every MCP call arrives as call_mcp_tool; the request names the server
	// and tool and carries the tool's own arguments.
	raw := antigravityPayload("call_mcp_tool", map[string]any{
		"ServerName": "stripe", "ToolName": "create_refund", "Arguments": map[string]any{"amount": json.Number("9007199254740993")},
	}, 4)
	var out bytes.Buffer
	if err := Run(context.Background(), "antigravity", c, raw, &out); err != nil || strings.TrimSpace(out.String()) != `{"decision":"ask"}` {
		t.Fatalf("approval %q: %v", out.String(), err)
	}
	in := p.Inputs()[0]
	if in.Tool != "create_refund" || in.Server != "stripe" || in.Context["runtime"] != "antigravity" ||
		in.Context["session_id"] != "conversation" || in.Context["call_id"] != "4" || in.Context["cwd"] != "/work" ||
		in.Timeout != "604800s" || in.Arguments["amount"] != json.Number("9007199254740993") || in.Arguments["ServerName"] != nil {
		t.Fatalf("submission %+v", in)
	}

	// The same step recovers the same attempt, whose approval is spent.
	out.Reset()
	if err := Run(context.Background(), "antigravity", c, raw, &out); err != nil || !denied(out.String()) {
		t.Fatalf("replay %q: %v", out.String(), err)
	}

	out.Reset()
	Run(context.Background(), "antigravity", c, antigravityPayload("run_command", map[string]any{"CommandLine": "ls"}, 6), &out)
	if in := p.Inputs()[len(p.Inputs())-1]; in.Tool != "run_command" || in.Server != "" || in.Arguments["CommandLine"] != "ls" {
		t.Fatalf("built-in submission %+v", in)
	}

	for _, bad := range []string{
		`{`, `{}`,
		string(antigravityPayload("run_command", nil, 1)),
		strings.Replace(string(antigravityPayload("run_command", map[string]any{}, 1)), `"stepIdx":1,`, "", 1),
		string(antigravityPayload("call_mcp_tool", map[string]any{"ToolName": "create_refund"}, 2)),
	} {
		out.Reset()
		Run(context.Background(), "antigravity", c, []byte(bad), &out)
		if !strings.Contains(out.String(), `"decision":"deny"`) {
			t.Fatalf("malformed call passed: %s -> %s", bad, out.String())
		}
	}
}

func TestGeminiAntigravityDeniedOutcomes(t *testing.T) {
	cases := map[string][]byte{
		"gemini":      geminiPayload("run_shell_command", nil),
		"antigravity": antigravityPayload("run_command", map[string]any{"CommandLine": "ls"}, 2),
	}
	for key, raw := range cases {
		for _, status := range []aap.Status{aap.StatusDenied, aap.StatusExpired, aap.StatusCancelled} {
			t.Run(key+"/"+string(status), func(t *testing.T) {
				p := testprovider.New(t)
				p.Status = status
				var out bytes.Buffer
				Run(context.Background(), key, p.Client(t), raw, &out)
				if !strings.Contains(out.String(), `"decision":"deny"`) {
					t.Fatalf("%s", out.String())
				}
			})
		}
		t.Run(key+"/refused", func(t *testing.T) {
			p := testprovider.New(t)
			c := p.Client(t)
			c.Token = "revoked-token"
			c.EjectCommand = "provider agent eject " + key
			var out bytes.Buffer
			if err := Run(context.Background(), key, c, raw, &out); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), `"decision":"deny"`) || !strings.Contains(out.String(), "provider agent eject "+key) {
				t.Fatalf("refused credential: %s", out.String())
			}
		})
		t.Run(key+"/fail-closed", func(t *testing.T) {
			var out bytes.Buffer
			Deny(key, raw, &out)
			if !strings.Contains(out.String(), `"decision":"deny"`) {
				t.Fatalf("deny: %s", out.String())
			}
		})
	}
}
