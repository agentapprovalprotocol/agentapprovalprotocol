package runtimes

import (
	"fmt"
	"path/filepath"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

// antigravity wires Antigravity (the agy CLI and the desktop app): a named
// hook in the global ~/.gemini/config/hooks.json with a catch-all
// PreToolUse matcher. Antigravity runs the command through sh -c and
// blocks the call when the hook fails.
//
// With a runtime plugin, the hook is a plugin the person installed with
// `agy plugin install`; install only checks it is there and enabled.
type antigravity struct{}

func (antigravity) AcceptsRuntimePlugin() {}

func (antigravity) Key() catalog.Key { return catalog.Antigravity }

// antigravityHookName is our key in hooks.json, which names each hook.
const antigravityHookName = "aap"

func (antigravity) configDir(env Env) string { return filepath.Join(env.Home, ".gemini", "config") }

func (a antigravity) hooksPath(env Env) string { return filepath.Join(a.configDir(env), "hooks.json") }

// pluginInstalled reports whether the named plugin is installed with
// hooks and not switched off in config.json.
func (a antigravity) pluginInstalled(env Env, name string) bool {
	dir := filepath.Join(a.configDir(env), "plugins", name)
	manifest := false
	for _, rel := range []string{"plugin.json", filepath.Join(".antigravity-plugin", "plugin.json"), filepath.Join(".gemini-plugin", "plugin.json")} {
		manifest = manifest || exists(filepath.Join(dir, rel))
	}
	if !manifest || !exists(filepath.Join(dir, "hooks.json")) {
		return false
	}
	content, existed, err := readFile(filepath.Join(a.configDir(env), "config.json"))
	if err != nil || !existed {
		return err == nil
	}
	doc, err := loadJSONObject(content, true)
	if err != nil {
		return false
	}
	plugins, _ := doc.Root.ObjectIfPresent("plugins")
	if plugins == nil {
		return true
	}
	plugin, _ := plugins.ObjectIfPresent(name)
	if plugin == nil {
		return true
	}
	enabled, ok := plugin.Get("enabled")
	return !ok || enabled != false
}

func (a antigravity) Detect(env Env) (Detection, error) {
	runtime, _ := catalog.Lookup(a.Key())
	det := Detection{Runtime: string(a.Key())}
	binary, version := detectBinary(env, runtime)
	det.Installed = binary != "" || exists(a.configDir(env))
	if !det.Installed {
		return det, nil
	}
	det.BinaryPath, det.Version, det.ConfigPath = binary, version, a.hooksPath(env)
	if env.RuntimePlugin != "" {
		det.AlreadyHooked = a.pluginInstalled(env, env.RuntimePlugin)
		return det, nil
	}
	content, existed, err := readFile(det.ConfigPath)
	if err != nil {
		return det, err
	}
	if doc, err := loadJSONObject(content, existed); err == nil {
		det.AlreadyHooked = a.installed(doc.Root, env.hookCommand(a.Key()))
	}
	return det, nil
}

// installed reports whether our named hook runs the given command.
func (a antigravity) installed(root *jsonObject, command string) bool {
	named, ok := root.ObjectIfPresent(antigravityHookName)
	if !ok {
		return false
	}
	return claudePreToolUse.installedIn(named, a.Key(), command)
}

func (a antigravity) Install(env Env, _ Detection, plan HookPlan) (InstallResult, error) {
	ed := newEditor(env, a.Key())
	if plan.RuntimePlugin != "" {
		if !a.pluginInstalled(env, plan.RuntimePlugin) {
			return InstallResult{}, fmt.Errorf("the %s Antigravity plugin is not installed and enabled; install it with `agy plugin install` first", plan.RuntimePlugin)
		}
		return ed.result(true, []string{"New Antigravity conversations use the connection."}, nil), nil
	}
	path := a.hooksPath(env)
	content, existed, err := readFile(path)
	if err != nil {
		return InstallResult{}, err
	}
	doc, err := loadJSONObject(content, existed)
	if err != nil {
		return InstallResult{}, err
	}
	// The hook is ours by name, so it is rewritten whole. Its PreToolUse
	// entry has Claude Code's shape, timed in seconds.
	named := newJSONObject()
	named.Set(claudePreToolUse.name, []jsonValue{claudePreToolUse.entry(env.hookCommand(a.Key()), plan.Matcher)})
	doc.Root.Set(antigravityHookName, named)
	if err := ed.write(path, doc.Bytes()); err != nil {
		return InstallResult{}, err
	}
	notes := []string{"New Antigravity conversations run the hook."}
	return ed.result(true, notes, nil), nil
}

func (a antigravity) Eject(env Env, entry ManifestEntry) error {
	return ejectFiles(env, entry, func(_ string, content []byte) ([]byte, bool, error) {
		doc, err := loadJSONObject(content, true)
		if err != nil {
			return nil, false, err
		}
		named, ok := doc.Root.ObjectIfPresent(antigravityHookName)
		if !ok || !claudePreToolUse.stripIn(named, a.Key()) {
			return nil, false, nil
		}
		if named.Len() == 0 {
			doc.Root.Delete(antigravityHookName)
		}
		return doc.Bytes(), true, nil
	})
}
