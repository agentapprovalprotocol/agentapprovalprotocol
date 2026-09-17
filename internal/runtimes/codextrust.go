package runtimes

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// Codex records trust for each configured hook as a hash of the hook's
// normalized definition, keyed by config path, event, group index, and
// handler index under [hooks.state]. A hook whose hash does not match is
// silently skipped by `codex exec` and flagged for review in the TUI.
//
// Running `aap install` is the person's decision to install this
// hook, so the install records the same hash Codex would after a manual
// review. The computation mirrors codex-rs (hooks/src/engine/discovery.rs
// hook_hash and config/src/fingerprint.rs version_for_toml): the identity
// {event_name, matcher, hooks: [normalized handler]} serialized as JSON
// with keys sorted recursively, then SHA-256. The normalized command
// handler carries type, command, the resolved timeout, and async; unset
// optional fields are absent.

// codexTrustHash computes Codex's trust hash for one PreToolUse command
// hook. An empty matcher is omitted, as Codex omits a missing matcher.
func codexTrustHash(matcher, command string, timeoutSeconds int64) string {
	hook := map[string]any{"async": false, "command": command, "timeout": timeoutSeconds, "type": "command"}
	identity := map[string]any{"event_name": "pre_tool_use", "hooks": []any{hook}}
	if matcher != "" {
		identity["matcher"] = matcher
	}
	// encoding/json sorts map keys, which is exactly the canonical form.
	serialized, _ := json.Marshal(identity)
	sum := sha256.Sum256(serialized)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// codexTrustKey is the [hooks.state] key for one handler.
func codexTrustKey(configPath string, groupIndex, handlerIndex int) string {
	return fmt.Sprintf("%s:pre_tool_use:%d:%d", configPath, groupIndex, handlerIndex)
}
