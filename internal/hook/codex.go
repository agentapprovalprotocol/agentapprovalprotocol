package hook

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/codextools"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/tool"
)

// codexInput covers both Codex hook events. Codex's PreToolUse input is
// nearly identical to Claude Code's; PermissionRequest shares the common
// fields. hook_event_name tells us which mapping to apply.
type codexInput struct {
	HookEventName string         `json:"hook_event_name"`
	SessionID     string         `json:"session_id"`
	TurnID        string         `json:"turn_id"`
	ToolName      string         `json:"tool_name"`
	ToolInput     map[string]any `json:"tool_input"`
	ToolUseID     string         `json:"tool_use_id"`
	Cwd           string         `json:"cwd"`
}

// Codex PreToolUse verdicts use the same shape as Claude Code.
// PermissionRequest uses hookSpecificOutput.decision.behavior instead.
type codexPermissionOutput struct {
	HookSpecificOutput struct {
		HookEventName string `json:"hookEventName"`
		Decision      struct {
			Behavior string `json:"behavior"`
			Message  string `json:"message,omitempty"`
		} `json:"decision"`
	} `json:"hookSpecificOutput"`
}

func emitPermission(w io.Writer, behavior, message string) {
	var out codexPermissionOutput
	out.HookSpecificOutput.HookEventName = "PermissionRequest"
	out.HookSpecificOutput.Decision.Behavior = behavior
	out.HookSpecificOutput.Decision.Message = message
	_ = json.NewEncoder(w).Encode(out)
}

// Codex runs either Codex hook event, switching on hook_event_name. Every
// call becomes an approval request; the provider's pipeline approves at
// once the tools nobody chose to gate and holds the rest for a human.
//
// PreToolUse maps like Claude Code: approval is passthrough (no output) so
// Codex's own approval flow still applies; denial is an explicit deny.
//
// PermissionRequest is different by design (the adapter documentation): the org queue
// REPLACES the local terminal prompt, so approval maps to an explicit
// allow, not passthrough. Passthrough there would just re-prompt a local
// user who may not exist.
func Codex(ctx context.Context, client *aap.Client, stdin io.Reader, stdout io.Writer) error {
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return err
	}
	var in codexInput
	if err := aap.Decode(raw, &in); err != nil || in.ToolName == "" || in.ToolInput == nil {
		Deny("codex", raw, stdout)
		return nil
	}
	if in.HookEventName != "" && in.HookEventName != "PreToolUse" && in.HookEventName != "PermissionRequest" {
		Deny("codex", raw, stdout)
		return nil
	}
	isPermissionRequest := in.HookEventName == "PermissionRequest"

	deny := func(reason string) {
		if isPermissionRequest {
			emitPermission(stdout, "deny", reason)
		} else {
			emitDeny(stdout, reason)
		}
	}

	// Codex spells MCP tools the Claude Code way, with server and tool
	// names sanitised to [A-Za-z0-9_]. The server comes back from Codex's
	// config and the tool from a cached listing of that server; whatever
	// cannot be recovered keeps Codex's spelling.
	call := codextools.Resolver{Home: codextools.Home(os.Getenv), CacheDir: client.CacheDir}.
		Resolve(ctx, tool.Identify(in.ToolName, tool.NamingMCPPrefixed))

	requestContext := map[string]any{
		"runtime":    "codex",
		"hook_event": in.HookEventName,
		"session_id": in.SessionID,
		"turn_id":    in.TurnID,
		"cwd":        in.Cwd,
	}
	if in.ToolUseID != "" {
		requestContext["call_id"] = in.ToolUseID
	}
	// One logical request per execution attempt, as in the Claude Code
	// hook. PreToolUse carries a tool_use_id per call; PermissionRequest
	// only carries the turn. Both must be in the key: the provider binds
	// a key to the whole request, context included, so a key that ignored
	// the turn while the context carried it would make the same command
	// in a later turn a 409 instead of a fresh approval.
	attempt := strings.Join([]string{in.SessionID, in.TurnID, in.ToolUseID}, "\x00")
	decision, err := gate(ctx, client, aap.CreateInput{
		Tool:           call.Tool,
		Server:         call.Server,
		Arguments:      in.ToolInput,
		Context:        requestContext,
		Timeout:        fmt.Sprintf("%ds", int(requestTimeout.Seconds())),
		IdempotencyKey: aap.IdempotencyKey(attempt, call, in.ToolInput),
	})
	switch {
	case err != nil:
		deny(client.FailureText(err))
	case decision.Allows():
		if isPermissionRequest && !decision.Bypassed {
			emitPermission(stdout, "allow", "") // the queue replaced the local prompt
		}
		// PreToolUse: passthrough, Codex's own approval flow still applies.
	default:
		deny(aap.BoundaryText(decision))
	}
	return nil
}
