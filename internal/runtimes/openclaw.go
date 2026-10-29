package runtimes

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

// openClaw wires OpenClaw: the embedded plugin is written under our config
// directory and openclaw.json points the Gateway at it. OpenClaw reads
// JSON5, so a file that is not strict JSON gets a snippet to paste instead
// of an edit that would flatten the person's comments.
//
// A caller's plugin replaces the embedded one: its files go to
// plugins/<name>/ under our config directory with an aap.json naming the
// binary and configuration directory, plugins.load.paths points at them,
// and plugins.entries.<name> enables it. A load path outranks a copy of
// the same plugin installed from ClawHub, so the CLI's copy is the one the
// Gateway loads. The plugin runs `hook openclaw` itself with its own
// ceiling, and sets its own before_tool_call timeout.
type openClaw struct{}

func (openClaw) Key() catalog.Key { return catalog.OpenClaw }

// openClawPluginID is the id OpenClaw accepts for a plugin.
var openClawPluginID = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

func (openClaw) ValidatePlugin(plugin Plugin) error {
	if !openClawPluginID.MatchString(plugin.Name) || plugin.Name == "aap" {
		return fmt.Errorf("invalid OpenClaw plugin id %q", plugin.Name)
	}
	if plugin.Files == nil {
		return errors.New("the OpenClaw plugin has no files")
	}
	raw, err := fs.ReadFile(plugin.Files, "openclaw.plugin.json")
	if err != nil {
		return fmt.Errorf("the OpenClaw plugin has no openclaw.plugin.json: %w", err)
	}
	var manifest struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil || manifest.ID != plugin.Name {
		return fmt.Errorf("the OpenClaw plugin's manifest id must be %q", plugin.Name)
	}
	return nil
}

// callerPluginDir is where a caller's plugin is written.
func (openClaw) callerPluginDir(env Env, name string) string {
	return filepath.Join(env.ConfigDir, "plugins", name)
}

func (openClaw) configPath(env Env) string {
	return filepath.Join(env.Home, ".openclaw", "openclaw.json")
}

// The Go hook subtracts 30 seconds from this ceiling, leaving a full week
// for approval. The plugin adds a further process watchdog margin.
const openClawApprovalTimeoutMs = 7*24*60*60*1000 + 30_000

const openClawRestartNote = "Restart the OpenClaw Gateway so it loads the AAP plugin."

func (o openClaw) Detect(env Env) (Detection, error) {
	runtime, _ := catalog.Lookup(o.Key())
	det := Detection{Runtime: string(o.Key())}
	binary, version := detectBinary(env, runtime)
	det.Installed = binary != "" || exists(o.configPath(env))
	if !det.Installed {
		return det, nil
	}
	det.BinaryPath, det.Version, det.ConfigPath = binary, version, o.configPath(env)
	content, existed, err := readFile(det.ConfigPath)
	if err != nil {
		return det, err
	}
	doc, err := loadJSONObject(content, existed)
	if err != nil {
		return det, nil // JSON5: nothing to read, install prints a snippet
	}
	det.AlreadyHooked = o.installed(doc.Root, env) || o.pluginInstalled(doc.Root, env)
	return det, nil
}

// pluginInstalled reports whether openclaw.json loads and enables a
// caller's plugin whose aap.json names this binary.
func (o openClaw) pluginInstalled(root *jsonObject, env Env) bool {
	pluginsObject, ok := root.ObjectIfPresent("plugins")
	if !ok {
		return false
	}
	load, _ := pluginsObject.ObjectIfPresent("load")
	entries, _ := pluginsObject.ObjectIfPresent("entries")
	if load == nil || entries == nil {
		return false
	}
	for _, dir := range jsonStrings(load, "paths") {
		name := filepath.Base(dir)
		if dir != o.callerPluginDir(env, name) || !openClawPluginID.MatchString(name) {
			continue
		}
		entry, ok := entries.ObjectIfPresent(name)
		if !ok {
			continue
		}
		if enabled, ok := entry.Get("enabled"); !ok || enabled != true {
			continue
		}
		if allow, ok := pluginsObject.Array("allow"); ok && len(allow) > 0 && !containsString(jsonStrings(pluginsObject, "allow"), name) {
			continue
		}
		content, existed, err := readFile(filepath.Join(dir, "aap.json"))
		if err != nil || !existed {
			continue
		}
		var config struct {
			Binary string `json:"binary"`
		}
		if json.Unmarshal(content, &config) == nil && config.Binary == env.Binary {
			return true
		}
	}
	return false
}

func (o openClaw) installed(root *jsonObject, env Env) bool {
	pluginsObject, ok := root.ObjectIfPresent("plugins")
	if !ok {
		return false
	}
	entries, ok := pluginsObject.ObjectIfPresent("entries")
	if !ok {
		return false
	}
	entry, ok := entries.ObjectIfPresent("aap")
	if !ok {
		return false
	}
	config, ok := entry.ObjectIfPresent("config")
	if !ok || config.String("binary") != env.Binary {
		return false
	}
	load, _ := pluginsObject.ObjectIfPresent("load")
	return load != nil && containsString(jsonStrings(load, "paths"), pluginDir(env, o.Key())) &&
		containsString(jsonStrings(pluginsObject, "allow"), "aap")
}

// entryConfig is plugins.entries.aap.
func (o openClaw) entryConfig(env Env) *jsonObject {
	config := newJSONObject()
	config.Set("binary", env.Binary)
	config.Set("configDir", env.ConfigDir)
	config.Set("approvalTimeoutMs", json.Number(fmt.Sprint(openClawApprovalTimeoutMs)))
	entry := newJSONObject()
	entry.Set("enabled", true)
	entry.Set("config", config)
	return entry
}

func (o openClaw) Install(env Env, _ Detection, plan HookPlan) (InstallResult, error) {
	if plan.Plugin != nil {
		return o.installPlugin(env, *plan.Plugin)
	}
	dir := pluginDir(env, o.Key())
	ed := newEditor(env, o.Key())
	if err := ed.writePlugin("openclaw"); err != nil {
		return InstallResult{}, fmt.Errorf("write plugin: %w", err)
	}
	path := o.configPath(env)
	content, existed, err := readFile(path)
	if err != nil {
		return InstallResult{}, err
	}
	doc, err := loadJSONObject(content, existed)
	if errors.Is(err, errNotStrictJSON) {
		result := ed.result(true, []string{openClawRestartNote}, []string{dir})
		result.Report.Manual = true
		result.Report.Message = fmt.Sprintf("%s is JSON5, which aap does not rewrite. Add this to it:", path)
		result.Report.Snippet = o.snippet(env, dir)
		return result, nil
	}
	if err != nil {
		return InstallResult{}, err
	}
	root := doc.Root
	pluginsObject := root.Object("plugins")
	allow, _ := pluginsObject.Array("allow")
	if !containsString(jsonStrings(pluginsObject, "allow"), "aap") {
		pluginsObject.Set("allow", append(allow, "aap"))
	}
	load := pluginsObject.Object("load")
	paths, _ := load.Array("paths")
	if !containsString(jsonStrings(load, "paths"), dir) {
		load.Set("paths", append(paths, dir))
	}
	pluginsObject.Object("entries").Set("aap", o.entryConfig(env))
	if err := ed.write(path, doc.Bytes()); err != nil {
		return InstallResult{}, err
	}
	return ed.result(true, []string{openClawRestartNote}, []string{dir}), nil
}

func (o openClaw) installPlugin(env Env, plugin Plugin) (InstallResult, error) {
	if err := o.ValidatePlugin(plugin); err != nil {
		return InstallResult{}, err
	}
	dir := o.callerPluginDir(env, plugin.Name)
	ed := newEditor(env, o.Key())
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
	restart := fmt.Sprintf("Restart the OpenClaw Gateway so it loads the %s plugin.", plugin.Name)
	path := o.configPath(env)
	content, existed, err := readFile(path)
	if err != nil {
		return InstallResult{}, err
	}
	doc, err := loadJSONObject(content, existed)
	if errors.Is(err, errNotStrictJSON) {
		result := ed.result(true, []string{restart}, nil)
		result.Report.Manual = true
		result.Report.Message = fmt.Sprintf("%s is JSON5, which aap does not rewrite. Add this to it:", path)
		result.Report.Snippet = o.pluginSnippet(plugin.Name, dir)
		return result, nil
	}
	if err != nil {
		return InstallResult{}, err
	}
	pluginsObject := doc.Root.Object("plugins")
	// An allowlist restricts which plugins load, so join one that exists.
	// Without one, a plugin on a load path loads already.
	if allow, ok := pluginsObject.Array("allow"); ok && len(allow) > 0 && !containsString(jsonStrings(pluginsObject, "allow"), plugin.Name) {
		pluginsObject.Set("allow", append(allow, plugin.Name))
	}
	if deny, ok := pluginsObject.Array("deny"); ok {
		if kept, removed := withoutString(deny, plugin.Name); removed {
			pluginsObject.Set("deny", kept)
		}
	}
	load := pluginsObject.Object("load")
	paths, _ := load.Array("paths")
	if !containsString(jsonStrings(load, "paths"), dir) {
		load.Set("paths", append(paths, dir))
	}
	// Keep settings the person or the plugin saved in the entry.
	pluginsObject.Object("entries").Object(plugin.Name).Set("enabled", true)
	// The caller's plugin replaces the embedded one.
	o.stripEmbedded(env, pluginsObject)
	if err := ed.write(path, doc.Bytes()); err != nil {
		return InstallResult{}, err
	}
	return ed.result(true, []string{restart}, nil), nil
}

// stripEmbedded removes the embedded plugin's wiring and reports whether
// any was present.
func (o openClaw) stripEmbedded(env Env, pluginsObject *jsonObject) bool {
	return o.stripPlugin(pluginsObject, "aap", pluginDir(env, o.Key()), true)
}

// stripPlugin removes one plugin's allowlist entry, load path and, when
// entry is set, its entry. It reports whether anything changed.
func (openClaw) stripPlugin(pluginsObject *jsonObject, name, dir string, entry bool) bool {
	changed := false
	if allow, ok := pluginsObject.Array("allow"); ok {
		if kept, removed := withoutString(allow, name); removed {
			changed = true
			pluginsObject.Set("allow", kept)
		}
	}
	if load, ok := pluginsObject.ObjectIfPresent("load"); ok {
		if paths, ok := load.Array("paths"); ok {
			if kept, removed := withoutString(paths, dir); removed {
				changed = true
				load.Set("paths", kept)
			}
		}
	}
	if entries, ok := pluginsObject.ObjectIfPresent("entries"); ok && entry {
		if _, ok := entries.Get(name); ok {
			entries.Delete(name)
			changed = true
		}
	}
	return changed
}

// pluginSnippet is the JSON5 for a caller's plugin.
func (openClaw) pluginSnippet(name, dir string) string {
	return fmt.Sprintf(`plugins: {
  load: { paths: [%s] },
  entries: {
    %s: { enabled: true },
  },
},`, jsonQuote(dir), jsonQuote(name))
}

// snippet is the JSON5 a person pastes when the file cannot be edited.
func (o openClaw) snippet(env Env, dir string) string {
	return fmt.Sprintf(`plugins: {
  allow: ["aap"],
  load: { paths: [%s] },
  entries: {
    aap: {
      enabled: true,
      config: { binary: %s, configDir: %s, approvalTimeoutMs: %d },
    },
  },
},`, jsonQuote(dir), jsonQuote(env.Binary), jsonQuote(env.ConfigDir), openClawApprovalTimeoutMs)
}

func (o openClaw) Eject(env Env, entry ManifestEntry) error {
	// A caller's plugin is known by the files recorded under its directory.
	plugins := map[string]bool{}
	for _, edit := range entry.Files {
		if insideDir(edit.Path, filepath.Join(env.ConfigDir, "plugins")) {
			rel, _ := filepath.Rel(filepath.Join(env.ConfigDir, "plugins"), edit.Path)
			if name, _, _ := strings.Cut(filepath.ToSlash(rel), "/"); name != string(o.Key()) {
				plugins[name] = true
			}
		}
	}
	err := ejectFiles(env, entry, func(path string, content []byte) ([]byte, bool, error) {
		if path != o.configPath(env) {
			return content, false, nil
		}
		doc, err := loadJSONObject(content, true)
		if err != nil {
			return nil, false, err
		}
		pluginsObject, ok := doc.Root.ObjectIfPresent("plugins")
		if !ok {
			return nil, false, nil
		}
		changed := o.stripEmbedded(env, pluginsObject)
		for name := range plugins {
			// The entry keeps the person's settings; disable it instead.
			if o.stripPlugin(pluginsObject, name, o.callerPluginDir(env, name), false) {
				changed = true
			}
			if entries, ok := pluginsObject.ObjectIfPresent("entries"); ok {
				if pluginEntry, ok := entries.ObjectIfPresent(name); ok {
					pluginEntry.Delete("enabled")
					if pluginEntry.Len() == 0 {
						entries.Delete(name)
					}
					changed = true
				}
			}
		}
		if !changed {
			return nil, false, nil
		}
		return doc.Bytes(), true, nil
	})
	if err != nil {
		return err
	}
	// Remove each plugin's directories once our files are gone. Other
	// files keep them.
	for name := range plugins {
		root := o.callerPluginDir(env, name)
		var dirs []string
		_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err == nil && entry.IsDir() {
				dirs = append(dirs, path)
			}
			return nil
		})
		for i := len(dirs) - 1; i >= 0; i-- {
			_ = os.Remove(dirs[i])
		}
	}
	return nil
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// withoutString removes every string equal to want from a JSON array.
func withoutString(array []jsonValue, want string) ([]jsonValue, bool) {
	kept := make([]jsonValue, 0, len(array))
	removed := false
	for _, item := range array {
		if s, ok := item.(string); ok && s == want {
			removed = true
			continue
		}
		kept = append(kept, item)
	}
	return kept, removed
}

func jsonQuote(value string) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}
