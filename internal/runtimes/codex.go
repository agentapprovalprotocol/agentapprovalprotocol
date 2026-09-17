package runtimes

import (
	"path/filepath"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

// codex wires Codex: a [[hooks.PreToolUse]] table in ~/.codex/config.toml
// plus the [hooks.state] trust record Codex would otherwise ask for in
// its TUI (see codextrust.go).
type codex struct{}

func (codex) Key() catalog.Key { return catalog.Codex }

func (codex) configPath(env Env) string {
	return filepath.Join(env.Home, ".codex", "config.toml")
}

// codexTrustNote tells the person what was recorded on their behalf.
const codexTrustNote = "The hook is recorded as trusted in Codex (hooks.state in config.toml), since running setup is that decision; review it any time with /hooks inside Codex."

func (c codex) Detect(env Env) (Detection, error) {
	runtime, _ := catalog.Lookup(c.Key())
	det := Detection{Runtime: string(c.Key())}
	binary, version := detectBinary(env, runtime)
	det.Installed = binary != "" || exists(c.configPath(env))
	if !det.Installed {
		return det, nil
	}
	det.BinaryPath, det.Version, det.ConfigPath = binary, version, c.configPath(env)
	table, err := c.load(env)
	if err != nil {
		return det, nil // an unparsable config is reported as unhooked; install surfaces the error
	}
	det.AlreadyHooked = c.installed(table, env.hookCommand(c.Key()))
	return det, nil
}

func (c codex) load(env Env) (map[string]any, error) {
	content, existed, err := readFile(c.configPath(env))
	if err != nil {
		return nil, err
	}
	return loadTOML(content, existed)
}

// preToolUse returns the hooks.PreToolUse array of tables.
func (codex) preToolUse(table map[string]any) []map[string]any {
	hooks, ok := tomlTableIfPresent(table, "hooks")
	if !ok {
		return nil
	}
	return tomlTables(hooks["PreToolUse"])
}

func (c codex) find(entries []map[string]any) (entryIndex, hookIndex int) {
	for i, entry := range entries {
		for j, hook := range tomlTables(entry["hooks"]) {
			if isOurHookCommand(tomlString(hook, "command"), c.Key()) {
				return i, j
			}
		}
	}
	return -1, -1
}

func (c codex) installed(table map[string]any, command string) bool {
	entries := c.preToolUse(table)
	i, j := c.find(entries)
	return i >= 0 && tomlString(tomlTables(entries[i]["hooks"])[j], "command") == command
}

func (c codex) Install(env Env, _ Detection, plan HookPlan) (InstallResult, error) {
	path := c.configPath(env)
	content, existed, err := readFile(path)
	if err != nil {
		return InstallResult{}, err
	}
	table, err := loadTOML(content, existed)
	if err != nil {
		return InstallResult{}, err
	}
	command := env.hookCommand(c.Key())
	hook := map[string]any{"type": "command", "command": command, "timeout": int64(hookTimeoutSeconds)}
	entries := c.preToolUse(table)
	i, j := c.find(entries)
	if i < 0 {
		entry := map[string]any{"hooks": []map[string]any{hook}}
		if plan.Matcher != "" {
			entry["matcher"] = plan.Matcher
		}
		entries = append(entries, entry)
	} else {
		if plan.Matcher != "" {
			entries[i]["matcher"] = plan.Matcher
		} else {
			delete(entries[i], "matcher")
		}
		hooks := tomlTables(entries[i]["hooks"])
		hooks[j] = hook
		entries[i]["hooks"] = hooks
	}
	hooks := tomlTable(table, "hooks")
	hooks["PreToolUse"] = entries
	// Record trust the way Codex does after a manual review, so codex exec
	// runs the hook instead of skipping it silently. An earlier install's
	// record for our hook goes first, wherever its group index was.
	state := tomlTable(hooks, "state")
	c.forgetTrust(state, path, entries)
	groupIndex, handlerIndex := c.find(entries)
	state[codexTrustKey(path, groupIndex, handlerIndex)] = map[string]any{
		"trusted_hash": codexTrustHash(plan.Matcher, command, int64(hookTimeoutSeconds)),
	}
	rendered, err := formatTOML(table)
	if err != nil {
		return InstallResult{}, err
	}
	ed := newEditor(env, c.Key())
	if err := ed.write(path, rendered); err != nil {
		return InstallResult{}, err
	}
	notes := []string{codexTrustNote}
	if existed && len(ed.changes) > 0 {
		notes = append(notes, tomlNote)
	}
	return ed.result(true, notes, nil), nil
}

// forgetTrust drops the trust record for our hook: the entry keyed by
// this config path and the group and handler index where our command
// sits in entries (as they were before any removal).
func (c codex) forgetTrust(state map[string]any, path string, entries []map[string]any) {
	i, j := c.find(entries)
	if i < 0 {
		return
	}
	delete(state, codexTrustKey(path, i, j))
}

func (c codex) Eject(env Env, entry ManifestEntry) error {
	return ejectFiles(env, entry, func(_ string, content []byte) ([]byte, bool, error) {
		table, err := loadTOML(content, true)
		if err != nil {
			return nil, false, err
		}
		entries := c.preToolUse(table)
		if entries == nil {
			return nil, false, nil
		}
		changed := false
		kept := make([]map[string]any, 0, len(entries))
		for _, e := range entries {
			hooks := tomlTables(e["hooks"])
			remaining := make([]map[string]any, 0, len(hooks))
			for _, hook := range hooks {
				if isOurHookCommand(tomlString(hook, "command"), c.Key()) {
					changed = true
					continue
				}
				remaining = append(remaining, hook)
			}
			if len(remaining) == 0 && len(hooks) > 0 {
				continue
			}
			e["hooks"] = remaining
			kept = append(kept, e)
		}
		if !changed {
			return nil, false, nil
		}
		hooks := tomlTable(table, "hooks")
		if state, ok := tomlTableIfPresent(hooks, "state"); ok {
			c.forgetTrust(state, c.configPath(env), entries)
			if len(state) == 0 {
				delete(hooks, "state")
			}
		}
		if len(kept) == 0 {
			delete(hooks, "PreToolUse")
		} else {
			hooks["PreToolUse"] = kept
		}
		if len(hooks) == 0 {
			delete(table, "hooks")
		}
		rendered, err := formatTOML(table)
		return rendered, true, err
	})
}
