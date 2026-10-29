package hook

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/tool"
)

// Antigravity runs the PreToolUse hook of Antigravity (the agy CLI and the
// desktop app). Antigravity pipes one proposed step to stdin and requires a
// decision on stdout; output without one blocks the call:
//
//	{"decision":"ask"}                        // approved: Antigravity's own permissions still apply
//	{"decision":"deny","reason":"<reason>"}  // denied or failed closed
//
// Every call becomes an approval request; the provider's pipeline approves
// at once the tools nobody chose to gate and holds the rest for a human.
// "ask" hands the call to Antigravity's permission rules unchanged, as a
// passthrough; "allow" would skip them in the app and is ignored headless.
//
// MCP tools arrive as one call_mcp_tool step whose arguments name the
// server and the tool, so the request carries those and the tool's own
// arguments. A server a plugin bundles is named <plugin>_<server>.
func Antigravity(ctx context.Context, client *aap.Client, stdin io.Reader, stdout io.Writer) error {
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return err
	}
	deny := func(reason string) {
		_ = json.NewEncoder(stdout).Encode(antigravityVerdict{Decision: "deny", Reason: reason})
	}

	var in antigravityInput
	if err := aap.Decode(raw, &in); err != nil ||
		in.ToolCall.Name == "" ||
		in.ToolCall.Args == nil ||
		in.ConversationID == "" ||
		in.StepIdx == nil {
		deny(aap.FailClosedText)
		return nil
	}

	call := tool.Identify(in.ToolCall.Name, tool.NamingPlain)
	args := in.ToolCall.Args
	if in.ToolCall.Name == antigravityMCPTool {
		server, _ := args["ServerName"].(string)
		name, _ := args["ToolName"].(string)
		arguments, ok := args["Arguments"].(map[string]any)
		if server == "" || name == "" {
			deny(aap.FailClosedText)
			return nil
		}
		if !ok {
			arguments = map[string]any{}
		}
		call, args = tool.Identity{Tool: name, Server: server}, arguments
	}

	callID := strconv.FormatInt(*in.StepIdx, 10)
	requestContext := map[string]any{
		"runtime":    "antigravity",
		"session_id": in.ConversationID,
		"call_id":    callID,
	}
	if len(in.WorkspacePaths) > 0 {
		requestContext["cwd"] = in.WorkspacePaths[0]
	}
	// A step index is unique within its conversation, so together they
	// recover the same execution attempt.
	decision, err := gate(ctx, client, aap.CreateInput{
		Tool:           call.Tool,
		Server:         call.Server,
		Arguments:      args,
		Context:        requestContext,
		Timeout:        fmt.Sprintf("%ds", int(requestTimeout.Seconds())),
		IdempotencyKey: aap.IdempotencyKey(in.ConversationID+"\x00"+callID, call, args),
	})
	switch {
	case err != nil:
		fmt.Fprintf(os.Stderr, "aap: fail closed: %v\n", err)
		deny(client.FailureText(err))
	case decision.Allows():
		_ = json.NewEncoder(stdout).Encode(antigravityVerdict{Decision: "ask"})
	default:
		deny(aap.BoundaryText(decision))
	}
	return nil
}

// antigravityMCPTool is the step Antigravity reports for every MCP call.
const antigravityMCPTool = "call_mcp_tool"

type antigravityInput struct {
	ConversationID string   `json:"conversationId"`
	StepIdx        *int64   `json:"stepIdx"`
	WorkspacePaths []string `json:"workspacePaths"`
	ToolCall       struct {
		Name string         `json:"name"`
		Args map[string]any `json:"args"`
	} `json:"toolCall"`
}

type antigravityVerdict struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason,omitempty"`
}
