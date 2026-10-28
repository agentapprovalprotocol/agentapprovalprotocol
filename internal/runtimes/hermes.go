package runtimes

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

// hermes wires Hermes Agent: the last hooks.pre_tool_call entry in
// ~/.hermes/config.yaml with fail_closed, and plugins.hook_callback_timeout
// raised so the outer watchdog contains the shell hook's 300 seconds.
// Hermes splits the command into arguments and runs it without a shell,
// so the hook goes through env(1) to set AAP_CONFIG_DIR.
//
// A caller's plugin replaces the shell hook: its files go to
// ~/.hermes/plugins/<name>/ with an aap.json naming the binary and
// credential, the name joins plugins.enabled, and
// plugins.hook_callback_timeout is 0 so Hermes never abandons the plugin's
// wait. The plugin runs `hook hermes` itself with its own ceiling.
type hermes struct{}

func (hermes) Key() catalog.Key { return catalog.Hermes }

func (hermes) ValidatePlugin(plugin Plugin) error {
	if !hermesPluginName.MatchString(plugin.Name) {
		return fmt.Errorf("invalid Hermes plugin name %q", plugin.Name)
	}
	if plugin.Files == nil {
		return errors.New("the Hermes plugin has no files")
	}
	return nil
}

func (hermes) pluginsDir(env Env) string {
	return filepath.Join(env.Home, ".hermes", "plugins")
}

// hermesPluginName is the name Hermes accepts as a plugin key.
var hermesPluginName = regexp.MustCompile(`^[a-z0-9_-]{1,64}$`)

func (hermes) configPath(env Env) string {
	return filepath.Join(env.Home, ".hermes", "config.yaml")
}

const (
	hermesCallbackTimeout = 330
	hermesHookTimeout     = 300
	hermesConsentNote     = "Hermes asks for one-time consent before running a new shell hook: accept it interactively, or start once with `hermes --accept-hooks chat`. `hermes hooks list` shows the active hook."
	hermesOrderNote       = "AAP must stay the last pre_tool_call hook: Hermes merges hook modifications in registration order."
	hermesPluginOrderNote = "Hermes applies argument changes from hooks that run after the plugin, including every shell hook. Keep other pre_tool_call hooks from changing tool arguments."
)

func (h hermes) Detect(env Env) (Detection, error) {
	runtime, _ := catalog.Lookup(h.Key())
	det := Detection{Runtime: string(h.Key())}
	binary, version := detectBinary(env, runtime)
	det.Installed = binary != "" || exists(h.configPath(env))
	if !det.Installed {
		return det, nil
	}
	det.BinaryPath, det.Version, det.ConfigPath = binary, version, h.configPath(env)
	root, err := h.load(env)
	if err != nil {
		return det, nil
	}
	det.AlreadyHooked = h.installed(root, env.execHookCommand(h.Key())) || h.pluginInstalled(env, root)
	return det, nil
}

func (h hermes) load(env Env) (*yaml.Node, error) {
	content, existed, err := readFile(h.configPath(env))
	if err != nil {
		return nil, err
	}
	return loadYAMLMapping(content, existed)
}

// preToolCall returns the hooks.pre_tool_call sequence, or nil.
func (hermes) preToolCall(root *yaml.Node) *yaml.Node {
	hooks := yamlGet(root, "hooks")
	if hooks == nil || hooks.Kind != yaml.MappingNode {
		return nil
	}
	seq := yamlGet(hooks, "pre_tool_call")
	if seq == nil || seq.Kind != yaml.SequenceNode {
		return nil
	}
	return seq
}

func (h hermes) ours(entry *yaml.Node) bool {
	return entry.Kind == yaml.MappingNode && isOurHookCommand(yamlString(entry, "command"), h.Key())
}

func (h hermes) installed(root *yaml.Node, command string) bool {
	seq := h.preToolCall(root)
	if seq == nil || len(seq.Content) == 0 {
		return false
	}
	last := seq.Content[len(seq.Content)-1]
	return h.ours(last) && yamlString(last, "command") == command
}

// plugins returns the enabled plugin names whose directory carries an
// aap.json, with the binary each names.
func (h hermes) plugins(env Env, root *yaml.Node) map[string]string {
	ours := map[string]string{}
	pluginsNode := yamlGet(root, "plugins")
	disabled := yamlStrings(pluginsNode, "disabled")
	for _, name := range yamlStrings(pluginsNode, "enabled") {
		if !hermesPluginName.MatchString(name) || slices.Contains(disabled, name) {
			continue
		}
		content, existed, err := readFile(filepath.Join(h.pluginsDir(env), name, "aap.json"))
		if err != nil || !existed {
			continue
		}
		var config struct {
			Binary string `json:"binary"`
		}
		if json.Unmarshal(content, &config) == nil {
			ours[name] = config.Binary
		}
	}
	return ours
}

// pluginInstalled reports whether an enabled plugin runs this binary.
func (h hermes) pluginInstalled(env Env, root *yaml.Node) bool {
	for _, binary := range h.plugins(env, root) {
		if binary == env.Binary {
			return true
		}
	}
	return false
}

// stripHooks removes our shell hooks and reports whether any were present.
func (h hermes) stripHooks(root *yaml.Node) bool {
	seq := h.preToolCall(root)
	if seq == nil {
		return false
	}
	kept := make([]*yaml.Node, 0, len(seq.Content))
	for _, item := range seq.Content {
		if !h.ours(item) {
			kept = append(kept, item)
		}
	}
	if len(kept) == len(seq.Content) {
		return false
	}
	hooks := yamlGet(root, "hooks")
	if len(kept) == 0 {
		yamlDeleteKey(hooks, "pre_tool_call")
		if len(hooks.Content) == 0 {
			yamlDeleteKey(root, "hooks")
		}
	} else {
		seq.Content = kept
	}
	return true
}

func (h hermes) Install(env Env, _ Detection, plan HookPlan) (InstallResult, error) {
	if plan.Plugin != nil {
		return h.installPlugin(env, *plan.Plugin)
	}
	path := h.configPath(env)
	content, existed, err := readFile(path)
	if err != nil {
		return InstallResult{}, err
	}
	root, err := loadYAMLMapping(content, existed)
	if err != nil {
		return InstallResult{}, err
	}
	pluginsNode := yamlEnsure(root, "plugins", yaml.MappingNode)
	if yamlInt(yamlGet(pluginsNode, "hook_callback_timeout")) < hermesCallbackTimeout {
		yamlSetInt(pluginsNode, "hook_callback_timeout", hermesCallbackTimeout)
	}
	hooks := yamlEnsure(root, "hooks", yaml.MappingNode)
	seq := yamlEnsure(hooks, "pre_tool_call", yaml.SequenceNode)
	kept := seq.Content[:0]
	for _, entry := range seq.Content {
		if !h.ours(entry) {
			kept = append(kept, entry)
		}
	}
	seq.Content = append(kept, yamlMapping(
		yamlScalar("command"), yamlScalar(env.execHookCommand(h.Key())),
		yamlScalar("timeout"), yamlIntNode(hermesHookTimeout),
		yamlScalar("fail_closed"), yamlBool(true),
	))
	rendered, err := formatYAML(root)
	if err != nil {
		return InstallResult{}, err
	}
	ed := newEditor(env, h.Key())
	if err := ed.write(path, rendered); err != nil {
		return InstallResult{}, err
	}
	return ed.result(true, []string{hermesConsentNote, hermesOrderNote}, nil), nil
}

func (h hermes) installPlugin(env Env, plugin Plugin) (InstallResult, error) {
	if err := h.ValidatePlugin(plugin); err != nil {
		return InstallResult{}, err
	}
	dir := filepath.Join(h.pluginsDir(env), plugin.Name)
	ed := newEditor(env, h.Key())
	err := fs.WalkDir(plugin.Files, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		content, err := fs.ReadFile(plugin.Files, path)
		if err != nil {
			return err
		}
		return ed.write(filepath.Join(dir, filepath.FromSlash(path)), content)
	})
	if err != nil {
		return InstallResult{}, err
	}
	config, _ := json.MarshalIndent(map[string]any{"binary": env.Binary, "configDir": env.ConfigDir}, "", "  ")
	if err := ed.write(filepath.Join(dir, "aap.json"), append(config, '\n')); err != nil {
		return InstallResult{}, err
	}
	path := h.configPath(env)
	content, existed, err := readFile(path)
	if err != nil {
		return InstallResult{}, err
	}
	root, err := loadYAMLMapping(content, existed)
	if err != nil {
		return InstallResult{}, err
	}
	pluginsNode := yamlEnsure(root, "plugins", yaml.MappingNode)
	yamlSetInt(pluginsNode, "hook_callback_timeout", 0)
	if !slices.Contains(yamlStrings(pluginsNode, "enabled"), plugin.Name) {
		enabled := yamlEnsure(pluginsNode, "enabled", yaml.SequenceNode)
		enabled.Content = append(enabled.Content, yamlScalar(plugin.Name))
	}
	if disabled := yamlGet(pluginsNode, "disabled"); disabled != nil && disabled.Kind == yaml.SequenceNode {
		disabled.Content = slices.DeleteFunc(disabled.Content, func(item *yaml.Node) bool { return item.Value == plugin.Name })
		if len(disabled.Content) == 0 {
			yamlDeleteKey(pluginsNode, "disabled")
		}
	}
	h.stripHooks(root)
	rendered, err := formatYAML(root)
	if err != nil {
		return InstallResult{}, err
	}
	if err := ed.write(path, rendered); err != nil {
		return InstallResult{}, err
	}
	notes := []string{fmt.Sprintf("A fresh Hermes session loads the %s plugin.", plugin.Name), hermesPluginOrderNote}
	return ed.result(true, notes, nil), nil
}

func (h hermes) Eject(env Env, entry ManifestEntry) error {
	plugins := map[string]bool{}
	for _, edit := range entry.Files {
		if insideDir(edit.Path, h.pluginsDir(env)) {
			rel, _ := filepath.Rel(h.pluginsDir(env), edit.Path)
			name, _, _ := strings.Cut(filepath.ToSlash(rel), "/")
			plugins[name] = true
		}
	}
	err := ejectFiles(env, entry, func(path string, content []byte) ([]byte, bool, error) {
		if path != h.configPath(env) {
			return content, false, nil
		}
		root, err := loadYAMLMapping(content, true)
		if err != nil {
			return nil, false, err
		}
		changed := h.stripHooks(root)
		pluginsNode := yamlGet(root, "plugins")
		if enabled := yamlGet(pluginsNode, "enabled"); enabled != nil && enabled.Kind == yaml.SequenceNode {
			kept := slices.DeleteFunc(slices.Clone(enabled.Content), func(item *yaml.Node) bool { return plugins[item.Value] })
			if len(kept) != len(enabled.Content) {
				enabled.Content, changed = kept, true
			}
		}
		// Without our plugin, an unbounded callback timeout only lets other
		// plugins hang Hermes; return it to Hermes's default.
		if timeout := yamlGet(pluginsNode, "hook_callback_timeout"); len(plugins) > 0 && timeout != nil && timeout.Kind == yaml.ScalarNode && timeout.Value == "0" {
			yamlDeleteKey(pluginsNode, "hook_callback_timeout")
			changed = true
		}
		if !changed {
			return nil, false, nil
		}
		rendered, err := formatYAML(root)
		return rendered, true, err
	})
	if err != nil {
		return err
	}
	// Python leaves bytecode beside the plugin; remove it with the
	// directory once our files are gone. Other files keep the directory.
	for name := range plugins {
		dir := filepath.Join(h.pluginsDir(env), name)
		_ = os.RemoveAll(filepath.Join(dir, "__pycache__"))
		_ = os.Remove(dir)
	}
	return nil
}
