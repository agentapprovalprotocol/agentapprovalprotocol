package hook

import (
	"context"
	"io"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
)

// DeepSeek runs the PreToolUse hook for DeepSeek Harness (dsh), DeepSeek's
// agent runtime.
//
// The harness has no hook protocol of its own: every extension point is a
// Cordis plugin, and tool calls pass through its `tools/pre-execute`
// waterfall, where a listener answers allow, deny, or ask. DeepSeek ships
// one such listener, @deepseek-ai/dsh-hooks-claude-code, which runs the
// command hooks from a Claude Code style hooks.json and maps their verdicts
// onto that waterfall. That bridge is the adapter's transport: it feeds this
// frontend the Claude Code PreToolUse payload (session_id, cwd, tool_name,
// tool_input, tool_use_id) on stdin and reads the same
// hookSpecificOutput.permissionDecision JSON back.
//
// So the wire shape is Claude Code's, but the runtime is not, and the
// differences are what this frontend owns:
//
//   - requests are attributed to runtime "deepseek", with the harness call
//     id in context, so the reviewer queue does not misreport a dsh session
//     as Claude Code;
//   - transcript_path is always empty (the harness persistence seam exposes
//     no artifact path), so agent_reasoning is never available here;
//   - approval is passthrough (no output), which the bridge turns into
//     next(): the harness's own monotonic guards, sandbox policy, and
//     user-approval seam still apply after the org has approved, exactly as
//     Claude Code's local permissions do.
//
// Denial and fail-closed map to permissionDecision "deny" with the boundary
// text, which the harness renders as an isError tool result the model reads
// as a stated policy boundary.
func DeepSeek(ctx context.Context, client *aap.Client, stdin io.Reader, stdout io.Writer) error {
	return preToolUse(ctx, client, stdin, stdout, "deepseek")
}
