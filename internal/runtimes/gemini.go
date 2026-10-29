package runtimes

import (
	"fmt"
	"path/filepath"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

// gemini wires Gemini CLI: a BeforeTool hook in ~/.gemini/settings.json
// with a catch-all matcher and a millisecond timeout past the approval
// window, because Gemini runs the call when a hook times out.
//
// With a runtime plugin, the hook is an extension the person installed
// with `gemini extensions install`; install only checks it is there.
type gemini struct{}

func (gemini) AcceptsRuntimePlugin() {}

func (gemini) Key() catalog.Key { return catalog.Gemini }

// home is Gemini's directory: GEMINI_CLI_HOME stands in for the user's
// home when set.
func (gemini) home(env Env) string {
	if home := env.getenv("GEMINI_CLI_HOME"); home != "" {
		return filepath.Join(home, ".gemini")
	}
	return filepath.Join(env.Home, ".gemini")
}

func (g gemini) settingsPath(env Env) string { return filepath.Join(g.home(env), "settings.json") }

// extensionInstalled reports whether the named extension is installed
// and carries hooks.
func (g gemini) extensionInstalled(env Env, name string) bool {
	dir := filepath.Join(g.home(env), "extensions", name)
	return exists(filepath.Join(dir, "gemini-extension.json")) && exists(filepath.Join(dir, "hooks", "hooks.json"))
}

func (g gemini) Detect(env Env) (Detection, error) {
	runtime, _ := catalog.Lookup(g.Key())
	det := Detection{Runtime: string(g.Key())}
	binary, version := detectBinary(env, runtime)
	det.Installed = binary != "" || exists(g.settingsPath(env)) || exists(filepath.Join(g.home(env), "extensions"))
	if !det.Installed {
		return det, nil
	}
	det.BinaryPath, det.Version, det.ConfigPath = binary, version, g.settingsPath(env)
	if env.RuntimePlugin != "" {
		det.AlreadyHooked = g.extensionInstalled(env, env.RuntimePlugin)
		return det, nil
	}
	content, existed, err := readFile(det.ConfigPath)
	if err != nil {
		return det, err
	}
	if doc, err := loadJSONObject(content, existed); err == nil {
		det.AlreadyHooked = geminiBeforeTool.installed(doc.Root, g.Key(), env.hookCommand(g.Key()))
	}
	return det, nil
}

func (g gemini) Install(env Env, _ Detection, plan HookPlan) (InstallResult, error) {
	ed := newEditor(env, g.Key())
	if plan.RuntimePlugin != "" {
		if !g.extensionInstalled(env, plan.RuntimePlugin) {
			return InstallResult{}, fmt.Errorf("the %s Gemini CLI extension is not installed; install it with `gemini extensions install` first", plan.RuntimePlugin)
		}
		return ed.result(true, []string{"New Gemini CLI sessions use the connection."}, nil), nil
	}
	path := g.settingsPath(env)
	content, existed, err := readFile(path)
	if err != nil {
		return InstallResult{}, err
	}
	doc, err := loadJSONObject(content, existed)
	if err != nil {
		return InstallResult{}, err
	}
	geminiBeforeTool.upsert(doc.Root, g.Key(), env.hookCommand(g.Key()), plan.Matcher)
	if err := ed.write(path, doc.Bytes()); err != nil {
		return InstallResult{}, err
	}
	notes := []string{"Running Gemini CLI sessions pick the hook up when they restart."}
	return ed.result(true, notes, nil), nil
}

func (g gemini) Eject(env Env, entry ManifestEntry) error {
	return ejectFiles(env, entry, geminiBeforeTool.stripFile(g.Key()))
}
