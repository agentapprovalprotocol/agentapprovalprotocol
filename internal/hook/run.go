package hook

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
	"io"
)

func Run(ctx context.Context, key string, c *aap.Client, raw []byte, out io.Writer) error {
	runners := map[string]func(context.Context, *aap.Client, io.Reader, io.Writer) error{
		"claude-code": ClaudeCode, "codex": Codex, "deepseek": DeepSeek, "hermes": Hermes, "openclaw": OpenClaw, "pi": Pi,
	}
	run, ok := runners[key]
	if !ok {
		return errors.New("unknown adapter")
	}
	var rendered bytes.Buffer
	if err := run(ctx, c, bytes.NewReader(raw), &rendered); err != nil {
		return err
	}
	_, err := out.Write(rendered.Bytes())
	return err
}
func Deny(key string, raw []byte, out io.Writer) {
	switch key {
	case "hermes":
		json.NewEncoder(out).Encode(hermesVerdict{Action: "block", Message: aap.FailClosedText})
	case "pi":
		json.NewEncoder(out).Encode(piVerdict{Decision: "deny", Reason: aap.FailClosedText})
	case "openclaw":
		json.NewEncoder(out).Encode(openclawVerdict{Decision: "deny", Reason: aap.FailClosedText})
	case "codex":
		var in codexInput
		_ = aap.Decode(raw, &in)
		if in.HookEventName == "PermissionRequest" {
			emitPermission(out, "deny", aap.FailClosedText)
		} else {
			emitDeny(out, aap.FailClosedText)
		}
	default:
		emitDeny(out, aap.FailClosedText)
	}
}
