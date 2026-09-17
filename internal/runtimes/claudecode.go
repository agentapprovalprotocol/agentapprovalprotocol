package runtimes

import (
	"path/filepath"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

// claudeCode wires Claude Code: a PreToolUse hook in ~/.claude/settings.json
// with a catch-all matcher and a 600 second timeout.
type claudeCode struct{}

func (claudeCode) Key() catalog.Key { return catalog.ClaudeCode }

func (claudeCode) settingsPath(env Env) string {
	return filepath.Join(env.Home, ".claude", "settings.json")
}

func (c claudeCode) Detect(env Env) (Detection, error) {
	runtime, _ := catalog.Lookup(c.Key())
	det := Detection{Runtime: string(c.Key())}
	binary, version := detectBinary(env, runtime)
	homeDir := filepath.Join(env.Home, runtime.HomeDir)
	det.Installed = binary != "" || exists(homeDir)
	if !det.Installed {
		return det, nil
	}
	det.BinaryPath, det.Version, det.ConfigPath = binary, version, c.settingsPath(env)
	content, existed, err := readFile(det.ConfigPath)
	if err != nil {
		return det, err
	}
	if doc, err := loadJSONObject(content, existed); err == nil {
		det.AlreadyHooked = claudeHookInstalled(doc.Root, c.Key(), env.hookCommand(c.Key()))
	}
	return det, nil
}

func (c claudeCode) Install(env Env, _ Detection, plan HookPlan) (InstallResult, error) {
	path := c.settingsPath(env)
	content, existed, err := readFile(path)
	if err != nil {
		return InstallResult{}, err
	}
	doc, err := loadJSONObject(content, existed)
	if err != nil {
		return InstallResult{}, err
	}
	upsertClaudeHook(doc.Root, c.Key(), env.hookCommand(c.Key()), plan.Matcher)
	ed := newEditor(env, c.Key())
	if err := ed.write(path, doc.Bytes()); err != nil {
		return InstallResult{}, err
	}
	notes := []string{"Running Claude Code sessions pick the hook up when they restart."}
	return ed.result(true, notes, nil), nil
}

func (c claudeCode) Eject(env Env, entry ManifestEntry) error {
	return ejectFiles(env, entry, stripClaudeHookFile(c.Key()))
}
