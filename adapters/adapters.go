// Package adapters installs and runs provider-independent AAP runtime adapters.
// Importing CLIs must route `hook <adapter>` to RunHook in their own executable.
package adapters

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/credential"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/hook"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/runtimes"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/storage"
)

type Info struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}
type Detection = runtimes.Detection
type FileChange = runtimes.FileChange
type InstallResult struct {
	Adapter  string       `json:"adapter"`
	Complete bool         `json:"complete"`
	Changes  []FileChange `json:"changes,omitempty"`
	Notes    []string     `json:"notes,omitempty"`
}
type Status struct {
	Detection
	Configured bool   `json:"configured"`
	Complete   bool   `json:"complete"`
	BaseURL    string `json:"base_url,omitempty"`
	ToolGlob   string `json:"tool_glob,omitempty"`
}

// Environment supplies machine locations and process execution for embedding and tests.
// Empty location fields use the operating system's defaults.
type Environment struct {
	Home, ConfigDir, Executable string
	LookPath                    func(string) (string, error)
	Run                         func(context.Context, string, ...string) ([]byte, error)
	Getenv                      func(string) string
}
type Manager struct{ env runtimes.Env }
type Adapter struct {
	manager *Manager
	runtime runtimes.Adapter
}
type installOptions struct{ glob string }
type InstallOption func(*installOptions)

// WithToolGlob selects normalized AAP tool names using case-sensitive path.Match syntax.
func WithToolGlob(pattern string) InstallOption { return func(o *installOptions) { o.glob = pattern } }

func All() []Info {
	var out []Info
	for _, r := range catalog.All() {
		out = append(out, Info{Key: string(r.Key), Name: r.DisplayName})
	}
	return out
}
func ConfigDir() (string, error) {
	dir := os.Getenv("AAP_CONFIG_DIR")
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(base, "aap")
	}
	return filepath.Abs(dir)
}
func New() (*Manager, error) { return NewWithEnvironment(Environment{}) }
func NewWithEnvironment(e Environment) (*Manager, error) {
	var err error
	if e.Home == "" {
		e.Home, err = os.UserHomeDir()
		if err != nil {
			return nil, err
		}
	}
	if e.ConfigDir == "" {
		e.ConfigDir, err = ConfigDir()
		if err != nil {
			return nil, err
		}
	}
	if e.Executable == "" {
		e.Executable, err = os.Executable()
		if err != nil {
			return nil, err
		}
	}
	e.Home, err = filepath.Abs(e.Home)
	if err != nil {
		return nil, err
	}
	e.ConfigDir, err = filepath.Abs(e.ConfigDir)
	if err != nil {
		return nil, err
	}
	e.Executable, err = filepath.Abs(e.Executable)
	if err != nil {
		return nil, err
	}
	env := runtimes.DefaultEnv(e.ConfigDir, e.Executable)
	env.Home = e.Home
	if e.LookPath != nil {
		env.LookPath = e.LookPath
	}
	if e.Run != nil {
		env.Run = e.Run
	}
	if e.Getenv != nil {
		env.Getenv = e.Getenv
	}
	return &Manager{env: env}, nil
}
func Lookup(key string) (*Adapter, error) {
	m, err := New()
	if err != nil {
		return nil, err
	}
	return m.Lookup(key)
}
func (m *Manager) Lookup(key string) (*Adapter, error) {
	r, ok := runtimes.Lookup(catalog.Key(key))
	if !ok {
		return nil, fmt.Errorf("unknown adapter %q", key)
	}
	return &Adapter{manager: m, runtime: r}, nil
}
func (m *Manager) Detect() ([]Detection, error) { return runtimes.DetectAll(m.env) }
func (a *Adapter) Key() string                  { return string(a.runtime.Key()) }
func (a *Adapter) Detect() (Detection, error)   { return a.runtime.Detect(a.manager.env) }

// Installation owns no provider enrollment state. Token is deliberately absent from public results.
type installation struct {
	Executable string `json:"executable"`
	Token      string `json:"instance_token"`
	BaseURL    string `json:"base_url"`
	ToolGlob   string `json:"tool_glob,omitempty"`
	Complete   bool   `json:"complete"`
}

func (a *Adapter) settingsPath() string {
	return filepath.Join(a.manager.env.ConfigDir, "credentials", a.Key()+".json")
}
func (a *Adapter) load() (installation, error) {
	raw, err := os.ReadFile(a.settingsPath())
	if err != nil {
		return installation{}, err
	}
	var c installation
	if json.Unmarshal(raw, &c) != nil {
		return c, errors.New("invalid adapter configuration")
	}
	if err = aap.ValidateConfig(c.Token, c.BaseURL, c.ToolGlob); err != nil {
		return installation{}, errors.New("invalid adapter configuration")
	}
	return c, nil
}
func (a *Adapter) save(c installation) error {
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return storage.Write(a.settingsPath(), append(raw, '\n'), 0600)
}

// Install configures this adapter for a supplied instance. Repeating it updates the
// credentials and filter. It does not create an instance or contact the provider.
func (a *Adapter) Install(instanceToken, aapBaseURL string, options ...InstallOption) (InstallResult, error) {
	result := InstallResult{Adapter: a.Key()}
	var opts installOptions
	for _, option := range options {
		if option != nil {
			option(&opts)
		}
	}
	if err := aap.ValidateConfig(instanceToken, aapBaseURL, opts.glob); err != nil {
		return result, err
	}
	env := a.manager.env
	unlock, err := storage.Lock(env.ConfigDir)
	if err != nil {
		return result, err
	}
	defer unlock()
	manifest, err := credential.LoadManifest(env.ConfigDir)
	if err != nil {
		return result, err
	}
	det, err := a.runtime.Detect(env)
	if err != nil {
		return result, err
	}
	if !det.Installed {
		return result, errors.New("runtime not found; install and configure it before installing the adapter")
	}
	cfg := installation{Executable: env.Binary, Token: instanceToken, BaseURL: strings.TrimRight(aapBaseURL, "/"), ToolGlob: opts.glob}
	if err = a.save(cfg); err != nil {
		return result, err
	}
	manifest.Binary = env.Binary
	// Journal before each write so failed or interrupted installation can be uninstalled.
	env.Record = func(record runtimes.ManifestEntry) error {
		manifest.Runtimes[a.Key()] = runtimes.MergeRecord(manifest.Runtimes[a.Key()], record)
		return credential.SaveManifest(env.ConfigDir, manifest)
	}
	env.Changed = func(change FileChange) { result.Changes = append(result.Changes, change) }
	installed, err := a.runtime.Install(env, det, runtimes.HookPlan{Matcher: ".*"})
	if len(installed.Report.Changes) > 0 {
		result.Changes = installed.Report.Changes
	}
	result.Notes = installed.Report.Notes
	if installed.Report.Message != "" {
		result.Notes = append(result.Notes, installed.Report.Message)
	}
	if installed.Report.Snippet != "" {
		result.Notes = append(result.Notes, installed.Report.Snippet)
	}
	if !installed.Record.InstalledAt.IsZero() {
		if saveErr := env.Record(installed.Record); saveErr != nil {
			return result, errors.Join(err, saveErr)
		}
	}
	if err != nil {
		return result, err
	}
	if !installed.Report.OK || installed.Report.Manual {
		return result, errors.New("adapter registration is incomplete; follow the installation notes and rerun install")
	}
	after, err := a.runtime.Detect(env)
	if err != nil {
		return result, err
	}
	if !after.AlreadyHooked {
		return result, errors.New("adapter registration could not be verified")
	}
	cfg.Complete = true
	if err = a.save(cfg); err != nil {
		return result, err
	}
	result.Complete = true
	return result, nil
}
func (a *Adapter) Status() (Status, error) {
	cfg, err := a.load()
	if err != nil && !os.IsNotExist(err) {
		return Status{}, err
	}
	env := a.manager.env
	if cfg.Executable != "" {
		env.Binary = cfg.Executable
	}
	det, detectErr := a.runtime.Detect(env)
	if detectErr != nil {
		return Status{}, detectErr
	}
	s := Status{Detection: det}
	if os.IsNotExist(err) {
		return s, nil
	}
	s.Configured = true
	s.BaseURL = cfg.BaseURL
	s.ToolGlob = cfg.ToolGlob
	s.Complete = cfg.Complete && det.AlreadyHooked
	return s, nil
}

// Uninstall removes recorded local integration and credentials. Provider revocation is separate.
func (a *Adapter) Uninstall() error {
	env := a.manager.env
	unlock, err := storage.Lock(env.ConfigDir)
	if err != nil {
		return err
	}
	defer unlock()
	manifest, err := credential.LoadManifest(env.ConfigDir)
	if err != nil {
		return err
	}
	if record, ok := manifest.Runtimes[a.Key()]; ok {
		if err = a.runtime.Eject(env, record); err != nil {
			return err
		}
		delete(manifest.Runtimes, a.Key())
		if err = credential.SaveManifest(env.ConfigDir, manifest); err != nil {
			return err
		}
	}
	if err = os.Remove(a.settingsPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.RemoveAll(filepath.Join(credential.BackupDir(env.ConfigDir), a.Key()))
}

// RunHook is the entry point importing CLIs route their hook subcommand to.
func RunHook(ctx context.Context, key string, stdin io.Reader, stdout io.Writer) error {
	a, err := Lookup(key)
	if err != nil {
		return err
	}
	return a.RunHook(ctx, stdin, stdout)
}
func (a *Adapter) RunHook(ctx context.Context, stdin io.Reader, stdout io.Writer) error {
	// Keep a copy for the correct native failure response if configuration is missing.
	raw, err := io.ReadAll(io.LimitReader(stdin, 8<<20+1))
	if err != nil || len(raw) > 8<<20 {
		hook.Deny(a.Key(), raw, stdout)
		return errors.New("invalid hook payload")
	}
	cfg, err := a.load()
	if err != nil {
		hook.Deny(a.Key(), raw, stdout)
		return errors.New("adapter credentials unavailable or invalid")
	}
	client := aap.NewClient(cfg.BaseURL, cfg.Token)
	client.ToolGlob = cfg.ToolGlob
	client.StateDir = filepath.Join(a.manager.env.ConfigDir, "consumed")
	client.CacheDir = filepath.Join(a.manager.env.ConfigDir, "cache")
	err = hook.Run(ctx, a.Key(), client, raw, stdout)
	if err != nil {
		hook.Deny(a.Key(), raw, stdout)
		return errors.New("adapter hook failed")
	}
	return nil
}
