package runtimes

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

// openClaw wires OpenClaw: the embedded plugin is written under our config
// directory and openclaw.json points the Gateway at it. OpenClaw reads
// JSON5, so a file that is not strict JSON gets a snippet to paste instead
// of an edit that would flatten the person's comments.
type openClaw struct{}

func (openClaw) Key() catalog.Key { return catalog.OpenClaw }

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
	det.AlreadyHooked = o.installed(doc.Root, env)
	return det, nil
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

func (o openClaw) Install(env Env, _ Detection, _ HookPlan) (InstallResult, error) {
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
	dir := pluginDir(env, o.Key())
	return ejectFiles(env, entry, func(_ string, content []byte) ([]byte, bool, error) {
		doc, err := loadJSONObject(content, true)
		if err != nil {
			return nil, false, err
		}
		pluginsObject, ok := doc.Root.ObjectIfPresent("plugins")
		if !ok {
			return nil, false, nil
		}
		changed := false
		if allow, ok := pluginsObject.Array("allow"); ok {
			if kept, removed := withoutString(allow, "aap"); removed {
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
		if entries, ok := pluginsObject.ObjectIfPresent("entries"); ok {
			if _, ok := entries.Get("aap"); ok {
				entries.Delete("aap")
				changed = true
			}
		}
		if !changed {
			return nil, false, nil
		}
		return doc.Bytes(), true, nil
	})
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
