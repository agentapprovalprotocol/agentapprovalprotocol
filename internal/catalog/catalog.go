// Package catalog lists the supported runtime integrations.
package catalog

type Key string

const (
	ClaudeCode Key = "claude-code"
	Codex      Key = "codex"
	OpenClaw   Key = "openclaw"
	Pi         Key = "pi"
	Hermes     Key = "hermes"
	DeepSeek   Key = "deepseek"
)

type Runtime struct {
	Key                          Key
	DisplayName, Binary, HomeDir string
}

var catalog = []Runtime{
	{ClaudeCode, "Claude Code", "claude", ".claude"}, {Codex, "Codex", "codex", ".codex"},
	{OpenClaw, "OpenClaw", "openclaw", ".openclaw"}, {Pi, "Pi", "pi", ".pi"},
	{Hermes, "Hermes Agent", "hermes", ".hermes"}, {DeepSeek, "DeepSeek Harness", "dsh", ".dsh"},
}

func All() []Runtime { return append([]Runtime(nil), catalog...) }
func Lookup(key Key) (Runtime, bool) {
	for _, r := range catalog {
		if r.Key == key {
			return r, true
		}
	}
	return Runtime{}, false
}
