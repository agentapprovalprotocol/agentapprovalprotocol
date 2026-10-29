package hook

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/tool"
)

// Gemini runs the BeforeTool hook of Gemini CLI. Gemini pipes one proposed
// call to stdin and reads one directive from stdout:
//
//	{}                                       // approved: Gemini's own policy still applies
//	{"decision":"deny","reason":"<reason>"} // denied or failed closed
//
// Every call becomes an approval request; the provider's pipeline approves
// at once the tools nobody chose to gate and holds the rest for a human.
// An approval carries no decision, because Gemini's "allow" changes nothing
// and its policy and confirmation run after the hook either way.
//
// Gemini runs a call when a hook times out, crashes or exits 1, so the
// registration's timeout must outlast the approval window and every path
// here prints an explicit verdict.
func Gemini(ctx context.Context, client *aap.Client, stdin io.Reader, stdout io.Writer) error {
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return err
	}
	deny := func(reason string) {
		_ = json.NewEncoder(stdout).Encode(geminiVerdict{Decision: "deny", Reason: reason})
	}

	var in geminiInput
	if err := aap.Decode(raw, &in); err != nil ||
		in.HookEventName != "BeforeTool" ||
		in.ToolName == "" ||
		in.ToolInput == nil ||
		in.SessionID == "" {
		deny(aap.FailClosedText)
		return nil
	}

	// Gemini spells an MCP tool mcp_<server>_<tool>, which cannot be split
	// back reliably, so the identity comes from the MCP context it sends
	// beside the name.
	call := tool.Identify(in.ToolName, tool.NamingPlain)
	if in.MCPContext != nil && in.MCPContext.ServerName != "" && in.MCPContext.ToolName != "" {
		call = tool.Identity{Tool: in.MCPContext.ToolName, Server: in.MCPContext.ServerName}
	}

	requestContext := map[string]any{
		"runtime":    "gemini",
		"session_id": in.SessionID,
		"cwd":        in.Cwd,
	}
	// Gemini sends no call ID, so each invocation is its own attempt and
	// the shared gate generates a fresh idempotency key.
	decision, err := gate(ctx, client, aap.CreateInput{
		Tool:           call.Tool,
		Server:         call.Server,
		Arguments:      in.ToolInput,
		Context:        requestContext,
		Timeout:        fmt.Sprintf("%ds", int(requestTimeout.Seconds())),
		IdempotencyKey: aap.IdempotencyKey(in.SessionID, call, in.ToolInput),
	})
	switch {
	case err != nil:
		fmt.Fprintf(os.Stderr, "aap: fail closed: %v\n", err)
		deny(client.FailureText(err))
	case decision.Allows():
		_, _ = io.WriteString(stdout, "{}\n")
	default:
		deny(aap.BoundaryText(decision))
	}
	return nil
}

type geminiInput struct {
	HookEventName string         `json:"hook_event_name"`
	SessionID     string         `json:"session_id"`
	Cwd           string         `json:"cwd"`
	ToolName      string         `json:"tool_name"`
	ToolInput     map[string]any `json:"tool_input"`
	MCPContext    *struct {
		ServerName string `json:"server_name"`
		ToolName   string `json:"tool_name"`
	} `json:"mcp_context"`
}

type geminiVerdict struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason,omitempty"`
}
