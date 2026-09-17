package runtimes

import (
	"path/filepath"

	"gopkg.in/yaml.v3"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

// hermes wires Hermes Agent: the last hooks.pre_tool_call entry in
// ~/.hermes/config.yaml with fail_closed, and plugins.hook_callback_timeout
// raised so the outer watchdog contains the shell hook's 300 seconds.
type hermes struct{}

func (hermes) Key() catalog.Key { return catalog.Hermes }

func (hermes) configPath(env Env) string {
	return filepath.Join(env.Home, ".hermes", "config.yaml")
}

const (
	hermesCallbackTimeout = 330
	hermesHookTimeout     = 300
	hermesConsentNote     = "Hermes asks for one-time consent before running a new shell hook: accept it interactively, or start once with `hermes --accept-hooks chat`. `hermes hooks list` shows the active hook."
	hermesOrderNote       = "AAP must stay the last pre_tool_call hook: Hermes merges hook modifications in registration order."
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
	det.AlreadyHooked = h.installed(root, env.hookCommand(h.Key()))
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

func (h hermes) Install(env Env, _ Detection, _ HookPlan) (InstallResult, error) {
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
		yamlScalar("command"), yamlScalar(env.hookCommand(h.Key())),
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

func (h hermes) Eject(env Env, entry ManifestEntry) error {
	return ejectFiles(env, entry, func(_ string, content []byte) ([]byte, bool, error) {
		root, err := loadYAMLMapping(content, true)
		if err != nil {
			return nil, false, err
		}
		seq := h.preToolCall(root)
		if seq == nil {
			return nil, false, nil
		}
		kept := make([]*yaml.Node, 0, len(seq.Content))
		for _, item := range seq.Content {
			if !h.ours(item) {
				kept = append(kept, item)
			}
		}
		if len(kept) == len(seq.Content) {
			return nil, false, nil
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
		rendered, err := formatYAML(root)
		return rendered, true, err
	})
}
