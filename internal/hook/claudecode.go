// Package hook contains the per-runtime frontends from the adapter documentation.
// Each frontend feeds the shared aap.Client core loop and maps the
// resulting Decision into whatever its runtime expects.
package hook

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/tool"
)

// preToolUseInput is the JSON Claude Code pipes to a PreToolUse hook. The
// same dialect is spoken by every runtime that runs Claude Code hooks
// (DeepSeek Harness through its hooks bridge), so the shape is shared.
type preToolUseInput struct {
	HookEventName  string         `json:"hook_event_name"`
	SessionID      string         `json:"session_id"`
	ToolName       string         `json:"tool_name"`
	ToolInput      map[string]any `json:"tool_input"`
	ToolUseID      string         `json:"tool_use_id"`
	Cwd            string         `json:"cwd"`
	TranscriptPath string         `json:"transcript_path"`
}

// hookOutput is the verdict shape Claude Code reads from hook stdout.
type hookOutput struct {
	HookSpecificOutput struct {
		HookEventName            string `json:"hookEventName"`
		PermissionDecision       string `json:"permissionDecision"`
		PermissionDecisionReason string `json:"permissionDecisionReason"`
	} `json:"hookSpecificOutput"`
}

func emitDeny(w io.Writer, reason string) {
	var out hookOutput
	out.HookSpecificOutput.HookEventName = "PreToolUse"
	out.HookSpecificOutput.PermissionDecision = "deny"
	out.HookSpecificOutput.PermissionDecisionReason = reason
	_ = json.NewEncoder(w).Encode(out)
}

// ClaudeCode runs the PreToolUse hook: read the payload from stdin, send
// the call to the approval provider as an approval request, and emit a
// verdict. Every call goes: the provider's pipeline approves at once the
// tools nobody chose to gate and holds the rest for a human. Passthrough
// (no output, exit 0) on approval so Claude Code's own permission system
// still applies; explicit deny JSON otherwise.
func ClaudeCode(ctx context.Context, client *aap.Client, stdin io.Reader, stdout io.Writer) error {
	return preToolUse(ctx, client, stdin, stdout, "claude-code")
}

// preToolUse is the Claude Code dialect PreToolUse loop shared by every
// runtime that speaks it. runtime names the agent runtime for request
// context, so the reviewer sees which product actually made the call.
func preToolUse(ctx context.Context, client *aap.Client, stdin io.Reader, stdout io.Writer, runtime string) error {
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return err
	}
	var in preToolUseInput
	if err := aap.Decode(raw, &in); err != nil || in.ToolName == "" || in.ToolInput == nil {
		emitDeny(stdout, aap.FailClosedText)
		return nil
	}
	if in.HookEventName != "" && in.HookEventName != "PreToolUse" {
		emitDeny(stdout, aap.FailClosedText)
		return nil
	}

	// The request carries the tool as its server defines it, with the
	// server alias apart, never the host's mcp__<server>__ spelling.
	call := tool.Identify(in.ToolName, tool.NamingMCPPrefixed)

	requestContext := map[string]any{
		"runtime":    runtime,
		"session_id": in.SessionID,
		"cwd":        in.Cwd,
	}
	if in.ToolUseID != "" {
		requestContext["call_id"] = in.ToolUseID
	}
	// A stable call ID recovers the same execution attempt. Without one, the
	// shared gate generates a fresh key for this invocation.
	attempt := in.SessionID
	if in.ToolUseID != "" {
		attempt += "\x00" + in.ToolUseID
	}
	// Agent and instance identity come from the credential, not the body;
	// context never overrides the credential identity.
	decision, err := gate(ctx, client, aap.CreateInput{
		Tool:           call.Tool,
		Server:         call.Server,
		Arguments:      in.ToolInput,
		AgentReasoning: transcriptReasoning(in.TranscriptPath),
		Context:        requestContext,
		Timeout:        fmt.Sprintf("%ds", int(requestTimeout.Seconds())),
		IdempotencyKey: aap.IdempotencyKey(attempt, call, in.ToolInput),
	})
	switch {
	case err != nil:
		// Fail closed, for every call: the provider is the only place a
		// call is classified. The underlying error goes to stderr for the
		// runtime's debug log; the model only ever sees the boundary text.
		fmt.Fprintf(os.Stderr, "aap: fail closed: %v\n", err)
		emitDeny(stdout, client.FailureText(err))
	case decision.Allows():
		// passthrough, not "allow": local permissions still apply
	default:
		emitDeny(stdout, aap.BoundaryText(decision))
	}
	return nil
}

// transcriptReasoning lifts the agent's most recent stated intent out of
// the session transcript (a JSONL file) into agent_reasoning, which the
// provider displays as an unverified agent claim. Best-effort: any
// failure returns "".
func transcriptReasoning(transcriptPath string) string {
	if transcriptPath == "" {
		return ""
	}
	f, err := os.Open(transcriptPath)
	if err != nil {
		return ""
	}
	defer f.Close()

	var last string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		var entry struct {
			Type    string `json:"type"`
			Message struct {
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(scanner.Bytes(), &entry) != nil || entry.Type != "assistant" {
			continue
		}
		text := ""
		for _, block := range entry.Message.Content {
			if block.Type == "text" && block.Text != "" {
				if text != "" {
					text += " "
				}
				text += block.Text
			}
		}
		if text != "" {
			last = text
		}
	}
	if len(last) > 280 {
		last = last[:277] + "..."
	}
	return last
}
