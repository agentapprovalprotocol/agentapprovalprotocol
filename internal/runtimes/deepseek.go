package runtimes

import (
	"os"
	"path/filepath"
	"sort"

	"gopkg.in/yaml.v3"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

// deepSeek wires DeepSeek Harness (dsh). The harness has no hook protocol
// of its own: its Claude Code hooks bridge runs a hooks.json, so the
// install writes one under our config directory and mounts the bridge in
// the profile's cordis.patch.yml.
type deepSeek struct{}

func (deepSeek) Key() catalog.Key { return catalog.DeepSeek }

const deepSeekBridgePackage = "@deepseek-ai/dsh-hooks-claude-code"

// home is $DSH_HOME or ~/.dsh.
func (deepSeek) home(env Env) string {
	if home := env.getenv("DSH_HOME"); home != "" {
		return home
	}
	return filepath.Join(env.Home, ".dsh")
}

// profileDir picks the profile the bridge is mounted in: `default` when
// present, the only profile when there is one, else `default` is created.
func (d deepSeek) profileDir(env Env) string {
	profiles := filepath.Join(d.home(env), "profiles")
	if exists(filepath.Join(profiles, "default")) {
		return filepath.Join(profiles, "default")
	}
	entries, err := os.ReadDir(profiles)
	if err == nil {
		var dirs []string
		for _, entry := range entries {
			if entry.IsDir() {
				dirs = append(dirs, entry.Name())
			}
		}
		sort.Strings(dirs)
		if len(dirs) == 1 {
			return filepath.Join(profiles, dirs[0])
		}
	}
	return filepath.Join(profiles, "default")
}

func (d deepSeek) patchPath(env Env) string {
	return filepath.Join(d.profileDir(env), "cordis.patch.yml")
}

func (d deepSeek) hooksPath(env Env) string {
	return filepath.Join(env.ConfigDir, "deepseek", "hooks.json")
}

func (d deepSeek) Detect(env Env) (Detection, error) {
	runtime, _ := catalog.Lookup(d.Key())
	det := Detection{Runtime: string(d.Key())}
	binary, version := detectBinary(env, runtime)
	det.Installed = binary != "" || exists(d.home(env))
	if !det.Installed {
		return det, nil
	}
	det.BinaryPath, det.Version, det.ConfigPath = binary, version, d.patchPath(env)
	det.AlreadyHooked = d.installed(env)
	return det, nil
}

// installed reports whether the patch mounts the bridge on our hooks.json
// and that file names this binary.
func (d deepSeek) installed(env Env) bool {
	content, existed, err := readFile(d.patchPath(env))
	if err != nil || !existed {
		return false
	}
	seq, err := loadYAMLSequence(content, true)
	if err != nil {
		return false
	}
	entry := d.findBridge(seq)
	if entry == nil {
		return false
	}
	config := yamlGet(entry, "config")
	if yamlString(config, "configPath") != d.hooksPath(env) {
		return false
	}
	hooks, existed, err := readFile(d.hooksPath(env))
	if err != nil || !existed {
		return false
	}
	doc, err := loadJSONObject(hooks, true)
	return err == nil && claudeHookInstalled(doc.Root, d.Key(), env.hookCommand(d.Key()))
}

// findBridge locates the aap entry in a Cordis patch sequence.
func (deepSeek) findBridge(seq *yaml.Node) *yaml.Node {
	for _, item := range seq.Content {
		if item.Kind == yaml.MappingNode && yamlString(item, "id") == "aap" {
			return item
		}
	}
	return nil
}

func (d deepSeek) Install(env Env, _ Detection, plan HookPlan) (InstallResult, error) {
	ed := newEditor(env, d.Key())
	hooksPath := d.hooksPath(env)
	content, existed, err := readFile(hooksPath)
	if err != nil {
		return InstallResult{}, err
	}
	doc, err := loadJSONObject(content, existed)
	if err != nil {
		doc, _ = loadJSONObject(nil, false) // our own file: rewrite it if it was damaged
	}
	upsertClaudeHook(doc.Root, d.Key(), env.hookCommand(d.Key()), plan.Matcher)
	if err := ed.write(hooksPath, doc.Bytes()); err != nil {
		return InstallResult{}, err
	}

	patchPath := d.patchPath(env)
	patch, existed, err := readFile(patchPath)
	if err != nil {
		return InstallResult{}, err
	}
	seq, err := loadYAMLSequence(patch, existed)
	if err != nil {
		return InstallResult{}, err
	}
	bridge := yamlMapping(
		yamlScalar("id"), yamlScalar("aap"),
		yamlScalar("name"), yamlScalar(deepSeekBridgePackage),
		yamlScalar("config"), yamlMapping(yamlScalar("configPath"), yamlScalar(hooksPath)),
	)
	if existing := d.findBridge(seq); existing != nil {
		*existing = *bridge
	} else {
		seq.Content = append(seq.Content, bridge)
	}
	rendered, err := formatYAML(seq)
	if err != nil {
		return InstallResult{}, err
	}
	if err := ed.write(patchPath, rendered); err != nil {
		return InstallResult{}, err
	}
	notes := []string{
		"Run dsh under the profile at " + d.profileDir(env) + ": it mounts the AAP hooks bridge.",
		"The dsh bridge lets a tool call proceed when it cannot start the hook, so keep the binary at " + env.Binary + ".",
	}
	return ed.result(true, notes, nil), nil
}

func (d deepSeek) Eject(env Env, entry ManifestEntry) error {
	return ejectFiles(env, entry, func(path string, content []byte) ([]byte, bool, error) {
		if filepath.Ext(path) == ".json" {
			return stripClaudeHookFile(d.Key())(path, content)
		}
		seq, err := loadYAMLSequence(content, true)
		if err != nil {
			return nil, false, err
		}
		kept := make([]*yaml.Node, 0, len(seq.Content))
		for _, item := range seq.Content {
			if !(item.Kind == yaml.MappingNode && yamlString(item, "id") == "aap") {
				kept = append(kept, item)
			}
		}
		if len(kept) == len(seq.Content) {
			return nil, false, nil
		}
		if len(kept) == 0 {
			return nil, true, nil
		}
		seq.Content = kept
		rendered, err := formatYAML(seq)
		return rendered, true, err
	})
}

func domainChange(path, action string) FileChange {
	return FileChange{Path: path, Action: action}
}
