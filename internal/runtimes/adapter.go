// Package runtimes wires AAP into each agent runtime on the machine:
// detect it, install the
// hook that sends gated calls through the approval provider, and take
// that hook out again. Every adapter works through an injectable Env so
// tests run against a fixture home directory and a fake PATH.
package runtimes

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/credential"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/plugins"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/storage"
)

// Env is everything an adapter reads from the machine. Zero-value
// function fields fall back to the real process environment.
type Env struct {
	Record  func(ManifestEntry) error
	Changed func(FileChange)
	// Home is the user's home directory; runtime homes hang off it.
	Home string
	// Path is the executable search path used when LookPath is nil.
	Path []string
	// ConfigDir is aap's own configuration directory.
	ConfigDir string
	// Binary is the absolute path written into every hook.
	Binary string
	// LookPath finds an executable by name.
	LookPath func(name string) (string, error)
	// Run executes a command and returns its combined output.
	Run func(ctx context.Context, name string, args ...string) ([]byte, error)
	// Getenv reads an environment variable.
	Getenv func(key string) string
}

func (e Env) lookPath(name string) (string, error) {
	if e.LookPath != nil {
		return e.LookPath(name)
	}
	for _, dir := range e.Path {
		candidate := filepath.Join(dir, name)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%s not found on PATH", name)
}

func (e Env) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if e.Run != nil {
		return e.Run(ctx, name, args...)
	}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "PATH="+strings.Join(e.Path, string(os.PathListSeparator)))
	return cmd.CombinedOutput()
}

func (e Env) getenv(key string) string {
	if e.Getenv != nil {
		return e.Getenv(key)
	}
	return os.Getenv(key)
}

// hookCommand is the shell command a runtime runs for its hook. Every hook
// a setup installs names its own credential.
func (e Env) hookCommand(key catalog.Key) string {
	return fmt.Sprintf("AAP_CONFIG_DIR=%s %s hook %s", shellQuote(e.ConfigDir), shellQuote(e.Binary), key)
}

// hookCommandMarker identifies our hook entries whatever binary path they
// carry, so eject and re-install find entries an older setup wrote.
func hookCommandMarker(key catalog.Key) string { return " hook " + string(key) }

// isOurHookCommand reports whether a configured command is an AAP
// hook for the runtime.
func isOurHookCommand(command string, key catalog.Key) bool {
	return strings.HasSuffix(command, hookCommandMarker(key)) && strings.HasPrefix(command, "AAP_CONFIG_DIR=")
}

// shellQuote quotes a path for a shell command line only when it needs it.
func shellQuote(value string) string {
	if value != "" && !strings.ContainsAny(value, " \t\n'\"\\$`&|;<>()*?[]#~") {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// Detection describes a runtime and its local hook registration.
type Detection struct {
	Runtime       string `json:"runtime"`
	Installed     bool   `json:"installed"`
	BinaryPath    string `json:"binary_path,omitempty"`
	Version       string `json:"version,omitempty"`
	ConfigPath    string `json:"config_path,omitempty"`
	AlreadyHooked bool   `json:"already_hooked"`
}
type FileChange struct {
	Path   string `json:"path"`
	Action string `json:"action"`
}
type InstallReport struct {
	Runtime string       `json:"runtime"`
	OK      bool         `json:"ok"`
	Changes []FileChange `json:"changes,omitempty"`
	Notes   []string     `json:"notes,omitempty"`
	Manual  bool         `json:"manual,omitempty"`
	Message string       `json:"message,omitempty"`
	Snippet string       `json:"snippet,omitempty"`
}
type ManifestEntry = credential.RuntimeInstall
type HookPlan struct {
	Matcher string
}

// InstallResult is one install: the report for the provider and the
// record eject needs.
type InstallResult struct {
	Report InstallReport
	Record ManifestEntry
}

// Adapter is one runtime's integration.
type Adapter interface {
	Key() catalog.Key
	Detect(env Env) (Detection, error)
	Install(env Env, det Detection, plan HookPlan) (InstallResult, error)
	Eject(env Env, entry ManifestEntry) error
}

// All returns every adapter in catalog order.
func All() []Adapter {
	return []Adapter{claudeCode{}, codex{}, openClaw{}, pi{}, hermes{}, deepSeek{}}
}

// Lookup finds an adapter by runtime key.
func Lookup(key catalog.Key) (Adapter, bool) {
	for _, adapter := range All() {
		if adapter.Key() == key {
			return adapter, true
		}
	}
	return nil, false
}

// DetectAll runs every adapter's detection in catalog order.
func DetectAll(env Env) ([]Detection, error) {
	detections := make([]Detection, 0, len(All()))
	for _, adapter := range All() {
		det, err := adapter.Detect(env)
		if err != nil {
			return nil, fmt.Errorf("detect %s: %w", adapter.Key(), err)
		}
		detections = append(detections, det)
	}
	return detections, nil
}

// versionTimeout bounds the `--version` probe: a runtime that hangs on it
// is still detected, just without a version.
const versionTimeout = 5 * time.Second

// detectBinary finds a runtime's executable and asks it for a version.
func detectBinary(env Env, runtime catalog.Runtime) (path, version string) {
	path, err := env.lookPath(runtime.Binary)
	if err != nil {
		return "", ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), versionTimeout)
	defer cancel()
	out, err := env.run(ctx, path, "--version")
	if err != nil && len(bytes.TrimSpace(out)) == 0 {
		return path, ""
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	if len(line) > 80 {
		line = line[:80]
	}
	return path, strings.TrimSpace(line)
}

// exists reports whether a path exists.
func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func jsonStrings(object *jsonObject, key string) []string {
	array, ok := object.Array(key)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(array))
	for _, item := range array {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// editor performs a runtime's file edits, taking a backup before the first
// write to each pre-existing file and recording every touched file for
// the manifest.
type editor struct {
	env     Env
	runtime string
	edits   []credential.FileEdit
	changes []FileChange
	index   map[string]int
}

func newEditor(env Env, key catalog.Key) *editor {
	return &editor{env: env, runtime: string(key), index: map[string]int{}}
}

// write installs content at path. Unchanged content is recorded without a
// write or a change so a re-run reports nothing.
func (e *editor) write(path string, content []byte) error {
	current, existed, err := readFile(path)
	if err != nil {
		return err
	}
	if existed && bytes.Equal(current, content) {
		e.record(credential.FileEdit{Path: path, Kind: credential.FileModified, AfterSHA256: credential.SHA256(content)})
		return nil
	}
	edit := credential.FileEdit{Path: path, Kind: credential.FileCreated, AfterSHA256: credential.SHA256(content)}
	action := "created"
	if existed {
		backup, err := credential.Backup(e.env.ConfigDir, e.runtime, path, current)
		if err != nil {
			return fmt.Errorf("back up %s: %w", path, err)
		}
		edit.Kind = credential.FileModified
		edit.Backup = backup
		action = "modified"
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	e.record(edit)
	if e.env.Record != nil {
		if err := e.env.Record(e.result(false, nil, nil).Record); err != nil {
			return err
		}
	}
	mode := os.FileMode(0644)
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	if err := storage.Write(path, content, mode); err != nil {
		return err
	}
	change := FileChange{Path: path, Action: action}
	e.changes = append(e.changes, change)
	if e.env.Changed != nil {
		e.env.Changed(change)
	}
	return nil
}

func (e *editor) record(edit credential.FileEdit) {
	if i, ok := e.index[edit.Path]; ok {
		e.edits[i] = edit
		return
	}
	e.index[edit.Path] = len(e.edits)
	e.edits = append(e.edits, edit)
}

// result assembles the install outcome.
func (e *editor) result(ok bool, notes []string, dirs []string) InstallResult {
	return InstallResult{
		Report: InstallReport{Runtime: e.runtime, OK: ok, Changes: e.changes, Notes: notes},
		Record: ManifestEntry{InstalledAt: time.Now().UTC(), Files: e.edits, Dirs: dirs},
	}
}

// stripFunc removes a runtime's aap entries from one file's content
// and reports whether anything changed. A nil result deletes the file.
type stripFunc func(path string, content []byte) ([]byte, bool, error)

// ejectFiles reverses a manifest entry. A file the setup left untouched
// since is restored byte for byte from its backup (or deleted when the
// setup created it); a file something else changed since has only the
// aap entries removed.
func ejectFiles(env Env, entry ManifestEntry, strip stripFunc) error {
	for i := len(entry.Files) - 1; i >= 0; i-- {
		edit := entry.Files[i]
		current, existed, err := readFile(edit.Path)
		if err != nil {
			return err
		}
		if !existed {
			continue
		}
		mode := os.FileMode(0644)
		if st, err := os.Stat(edit.Path); err == nil {
			mode = st.Mode().Perm()
		}
		switch {
		case credential.SHA256(current) == edit.AfterSHA256 && edit.Kind == credential.FileCreated:
			if err := os.Remove(edit.Path); err != nil {
				return err
			}
		case credential.SHA256(current) == edit.AfterSHA256 && edit.Backup != "":
			backup, err := os.ReadFile(edit.Backup)
			if err != nil {
				return fmt.Errorf("read backup for %s: %w", edit.Path, err)
			}
			if err := storage.Write(edit.Path, backup, mode); err != nil {
				return err
			}
		default:
			if insideDir(edit.Path, filepath.Join(env.ConfigDir, "plugins")) {
				continue
			}
			stripped, changed, err := strip(edit.Path, current)
			if err != nil {
				return fmt.Errorf("strip %s: %w", edit.Path, err)
			}
			if !changed {
				continue
			}
			if stripped == nil {
				if err := os.Remove(edit.Path); err != nil {
					return err
				}
				continue
			}
			if err := storage.Write(edit.Path, stripped, mode); err != nil {
				return err
			}
		}
	}
	for _, dir := range entry.Dirs {
		if !insideDir(dir, env.ConfigDir) {
			return fmt.Errorf("refusing to remove %s: outside %s", dir, env.ConfigDir)
		}
		// Remove only empty directories. User-added or edited assets survive.
		_ = os.Remove(dir)
	}
	return nil
}

// insideDir reports whether path is under root.
func insideDir(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != "." && !strings.HasPrefix(rel, "..")
}

// pluginDir is where a setup writes an embedded runtime plugin.
func pluginDir(env Env, key catalog.Key) string {
	return filepath.Join(env.ConfigDir, "plugins", string(key))
}

// DefaultEnv describes the real machine: the user's home, the process
// PATH, and the given config directory and binary.
func DefaultEnv(configDir, binary string) Env {
	home, _ := os.UserHomeDir()
	return Env{
		Home: home, Path: filepath.SplitList(os.Getenv("PATH")), ConfigDir: configDir, Binary: binary,
		LookPath: exec.LookPath,
	}
}

// MergeRecord folds a re-install's record into the manifest's existing
// one: a file the first setup backed up keeps that backup (the true
// pre-setup state), directories are unioned, and the first install time
// stands.
func MergeRecord(existing, fresh ManifestEntry) ManifestEntry {
	if existing.InstalledAt.IsZero() {
		return fresh
	}
	merged := ManifestEntry{InstalledAt: existing.InstalledAt}
	byPath := map[string]credential.FileEdit{}
	for _, edit := range existing.Files {
		byPath[edit.Path] = edit
	}
	seen := map[string]bool{}
	for _, edit := range fresh.Files {
		if old, ok := byPath[edit.Path]; ok && old.Backup != "" && edit.Backup == "" {
			edit.Backup, edit.Kind = old.Backup, old.Kind
		}
		if old, ok := byPath[edit.Path]; ok && old.Kind == credential.FileCreated {
			edit.Kind, edit.Backup = credential.FileCreated, ""
		}
		merged.Files = append(merged.Files, edit)
		seen[edit.Path] = true
	}
	for _, edit := range existing.Files {
		if !seen[edit.Path] {
			merged.Files = append(merged.Files, edit)
		}
	}
	dirs := map[string]bool{}
	for _, dir := range append(append([]string(nil), existing.Dirs...), fresh.Dirs...) {
		if !dirs[dir] {
			dirs[dir] = true
			merged.Dirs = append(merged.Dirs, dir)
		}
	}
	return merged
}

func (e *editor) writePlugin(name string) error {
	names, err := plugins.Files(name)
	if err != nil {
		return err
	}
	for _, nameInPlugin := range names {
		raw, err := plugins.Read(name, nameInPlugin)
		if err != nil {
			return err
		}
		if err = e.write(filepath.Join(e.env.ConfigDir, "plugins", name, nameInPlugin), raw); err != nil {
			return err
		}
	}
	return nil
}
