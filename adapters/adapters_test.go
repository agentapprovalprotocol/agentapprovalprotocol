package adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/testprovider"
)

func manager(t *testing.T, run func(context.Context, string, ...string) ([]byte, error)) *Manager {
	t.Helper()
	e := Environment{Home: t.TempDir(), ConfigDir: t.TempDir(), Executable: "/opt/provider/bin/provider", LookPath: func(name string) (string, error) { return "/fake/" + name, nil }, Getenv: func(string) string { return "" }, Run: run}
	if e.Run == nil {
		e.Run = func(context.Context, string, ...string) ([]byte, error) { return []byte("v1"), nil }
	}
	m, err := NewWithEnvironment(e)
	if err != nil {
		t.Fatal(err)
	}
	return m
}
func TestLifecycleForEveryAdapter(t *testing.T) {
	for _, info := range All() {
		t.Run(info.Key, func(t *testing.T) {
			m := manager(t, nil)
			a, _ := m.Lookup(info.Key)
			result, err := a.Install("private-token", "https://provider.example/custom/aap", WithToolGlob("create_*"))
			if err != nil || !result.Complete {
				t.Fatalf("install %+v %v", result, err)
			}
			raw, err := os.ReadFile(a.settingsPath())
			if err != nil {
				t.Fatal(err)
			}
			stat, _ := os.Stat(a.settingsPath())
			if stat.Mode().Perm() != 0600 || !bytes.Contains(raw, []byte("private-token")) {
				t.Fatal("credentials not stored privately")
			}
			status, err := a.Status()
			if err != nil || !status.Complete || status.ToolGlob != "create_*" {
				t.Fatalf("status %+v %v", status, err)
			}
			encoded, _ := json.Marshal(struct {
				R InstallResult
				S Status
			}{result, status})
			if bytes.Contains(encoded, []byte("private-token")) {
				t.Fatal("token in public result")
			}
			again, err := a.Install("replacement", "https://provider.example/other")
			if err != nil || !again.Complete || len(again.Changes) != 0 {
				t.Fatalf("repeat %+v %v", again, err)
			}
			cfg, _ := a.load()
			if cfg.Token != "replacement" || cfg.ToolGlob != "" || cfg.BaseURL != "https://provider.example/other" {
				t.Fatal("config not replaced")
			}
			if err = a.Uninstall(); err != nil {
				t.Fatal(err)
			}
			status, err = a.Status()
			if err != nil || status.Configured || status.AlreadyHooked {
				t.Fatalf("uninstall %+v %v", status, err)
			}
			if err = a.Uninstall(); err != nil {
				t.Fatal("repeat uninstall:", err)
			}
		})
	}
}
func TestInvalidInstallDoesNotMutate(t *testing.T) {
	m := manager(t, nil)
	a, _ := m.Lookup("claude-code")
	for _, test := range []struct{ token, url, glob string }{{"", "https://provider.example", ""}, {"secret", "http://provider.example", ""}, {"secret", "https://provider.example", "["}} {
		if _, err := a.Install(test.token, test.url, WithToolGlob(test.glob)); err == nil {
			t.Fatal("invalid install accepted")
		}
	}
	entries, _ := os.ReadDir(m.env.ConfigDir)
	if len(entries) != 0 {
		t.Fatalf("invalid input wrote files: %v", entries)
	}
}
func TestPartialInstallAndUninstall(t *testing.T) {
	m := manager(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "install" {
			return nil, errors.New("registration failed")
		}
		return []byte("ok"), nil
	})
	a, _ := m.Lookup("pi")
	result, err := a.Install("secret", "https://provider.example")
	if err == nil || result.Complete || len(result.Notes) == 0 {
		t.Fatalf("partial install %+v %v", result, err)
	}
	status, _ := a.Status()
	if status.Complete {
		t.Fatal("partial reported complete")
	}
	if err = a.Uninstall(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(m.env.ConfigDir, "plugins", "pi", "index.js")); !os.IsNotExist(err) {
		t.Fatal("partial assets remain")
	}
}
func TestJournalCleansEarlierWritesAfterFailure(t *testing.T) {
	m := manager(t, nil)
	a, _ := m.Lookup("deepseek")
	patch := filepath.Join(m.env.Home, ".dsh", "profiles", "default", "cordis.patch.yml")
	os.MkdirAll(filepath.Dir(patch), 0755)
	os.WriteFile(patch, []byte("invalid: mapping"), 0600)
	if result, err := a.Install("secret", "https://provider.example"); err == nil || result.Complete {
		t.Fatal("bad config passed")
	}
	hookPath := filepath.Join(m.env.ConfigDir, "deepseek", "hooks.json")
	if _, err := os.Stat(hookPath); err != nil {
		t.Fatal("test did not exercise partial write")
	}
	if err := a.Uninstall(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(hookPath); !os.IsNotExist(err) {
		t.Fatal("journal did not undo partial write")
	}
	raw, _ := os.ReadFile(patch)
	if string(raw) != "invalid: mapping" {
		t.Fatal("user config changed")
	}
}
func TestUserAddedPluginFileSurvivesUninstall(t *testing.T) {
	m := manager(t, nil)
	a, _ := m.Lookup("openclaw")
	if _, err := a.Install("secret", "https://provider.example"); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(m.env.ConfigDir, "plugins", "openclaw", "my-notes.txt")
	os.WriteFile(file, []byte("keep"), 0600)
	if err := a.Uninstall(); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(file)
	if string(raw) != "keep" {
		t.Fatal("user asset removed")
	}
}
func TestHermesPluginLifecycle(t *testing.T) {
	m := manager(t, nil)
	a, _ := m.Lookup("hermes")
	config := filepath.Join(m.env.Home, ".hermes", "config.yaml")
	os.MkdirAll(filepath.Dir(config), 0755)
	shellHook := "/usr/bin/env AAP_CONFIG_DIR=/old/config /old/provider hook hermes"
	before := "model: hermes-4\nplugins:\n  enabled: [notes]\n  disabled: [example]\nhooks:\n  pre_tool_call:\n    - command: audit --pre\n    - command: " + shellHook + "\n"
	os.WriteFile(config, []byte(before), 0600)
	files := fstest.MapFS{"plugin.yaml": {Data: []byte("name: example\n")}, "__init__.py": {Data: []byte("def register(ctx):\n    pass\n")}}
	result, err := a.Install("secret", "https://provider.example", WithPlugin("example", files))
	if err != nil || !result.Complete {
		t.Fatalf("install %+v %v", result, err)
	}
	dir := filepath.Join(m.env.Home, ".hermes", "plugins", "example")
	raw, _ := os.ReadFile(filepath.Join(dir, "aap.json"))
	var written struct{ Binary, ConfigDir string }
	if json.Unmarshal(raw, &written) != nil || written.Binary != m.env.Binary || written.ConfigDir != m.env.ConfigDir {
		t.Fatalf("aap.json = %s", raw)
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "plugin.yaml")); string(raw) != "name: example\n" {
		t.Fatalf("plugin.yaml = %q", raw)
	}
	raw, _ = os.ReadFile(config)
	want := "model: hermes-4\nplugins:\n  enabled: [notes, example]\n  hook_callback_timeout: 0\nhooks:\n  pre_tool_call:\n    - command: audit --pre\n"
	if string(raw) != want {
		t.Fatalf("config.yaml =\n%s\nwant\n%s", raw, want)
	}
	if status, err := a.Status(); err != nil || !status.Complete {
		t.Fatalf("status %+v %v", status, err)
	}
	// Hermes rewrites its own config between sessions.
	os.WriteFile(config, append(raw, []byte("display:\n  compact: true\n")...), 0600)
	os.MkdirAll(filepath.Join(dir, "__pycache__"), 0755)
	os.WriteFile(filepath.Join(dir, "__pycache__", "x.pyc"), []byte("x"), 0600)
	if err := a.Uninstall(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("plugin directory remains: %v", err)
	}
	raw, _ = os.ReadFile(config)
	if strings.Contains(string(raw), "example") || strings.Contains(string(raw), "hook_callback_timeout") || !strings.Contains(string(raw), "notes") || !strings.Contains(string(raw), "compact") {
		t.Fatalf("ejected config.yaml =\n%s", raw)
	}
}
func TestOpenClawPluginLifecycle(t *testing.T) {
	m := manager(t, nil)
	a, _ := m.Lookup("openclaw")
	config := filepath.Join(m.env.Home, ".openclaw", "openclaw.json")
	os.MkdirAll(filepath.Dir(config), 0755)
	embedded := filepath.Join(m.env.ConfigDir, "plugins", "openclaw")
	before := `{
  "gateway": { "mode": "local" },
  "plugins": {
    "allow": ["notes", "aap"],
    "deny": ["example"],
    "load": { "paths": ["/opt/notes", "` + embedded + `"] },
    "entries": {
      "aap": { "enabled": true, "config": { "binary": "/old/provider" } },
      "example": { "config": { "url": "https://provider.example" } }
    }
  }
}
`
	os.WriteFile(config, []byte(before), 0600)
	files := fstest.MapFS{
		"openclaw.plugin.json": {Data: []byte(`{"id": "example"}`)},
		"index.js":             {Data: []byte("export default {};\n")},
		"assets/icon.png":      {Data: []byte("png")},
	}
	result, err := a.Install("secret", "https://provider.example", WithPlugin("example", files))
	if err != nil || !result.Complete {
		t.Fatalf("install %+v %v", result, err)
	}
	dir := filepath.Join(m.env.ConfigDir, "plugins", "example")
	raw, _ := os.ReadFile(filepath.Join(dir, "aap.json"))
	var written struct{ Binary, ConfigDir string }
	if json.Unmarshal(raw, &written) != nil || written.Binary != m.env.Binary || written.ConfigDir != m.env.ConfigDir {
		t.Fatalf("aap.json = %s", raw)
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "assets", "icon.png")); string(raw) != "png" {
		t.Fatalf("icon = %q", raw)
	}
	var got struct {
		Gateway map[string]any
		Plugins struct {
			Allow, Deny []string
			Load        struct{ Paths []string }
			Entries     map[string]map[string]any
		}
	}
	raw, _ = os.ReadFile(config)
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("openclaw.json = %s: %v", raw, err)
	}
	// The plugin joins the allowlist, leaves the denylist, and replaces
	// the embedded plugin; the entry keeps the plugin's saved settings.
	plugins := got.Plugins
	if strings.Join(plugins.Allow, ",") != "notes,example" || len(plugins.Deny) != 0 ||
		strings.Join(plugins.Load.Paths, ",") != "/opt/notes,"+dir ||
		plugins.Entries["aap"] != nil || plugins.Entries["example"]["enabled"] != true ||
		plugins.Entries["example"]["config"] == nil || got.Gateway["mode"] != "local" {
		t.Fatalf("openclaw.json =\n%s", raw)
	}
	if status, err := a.Status(); err != nil || !status.Complete {
		t.Fatalf("status %+v %v", status, err)
	}
	// The plugin saves its settings after install.
	edited := strings.Replace(string(raw), `"url": "https://provider.example"`, `"url": "https://provider.example", "agentKey": "k"`, 1)
	os.WriteFile(config, []byte(edited), 0600)
	if err := a.Uninstall(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("plugin directory remains: %v", err)
	}
	raw, _ = os.ReadFile(config)
	got.Plugins.Entries = nil
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	plugins = got.Plugins
	if strings.Contains(strings.Join(plugins.Load.Paths, ","), dir) || strings.Join(plugins.Allow, ",") != "notes" ||
		plugins.Entries["example"]["enabled"] != nil || plugins.Entries["example"]["config"] == nil {
		t.Fatalf("ejected openclaw.json =\n%s", raw)
	}
}

// Without an allowlist, a plugin on a load path loads already; adding one
// would turn every other plugin off.
func TestOpenClawPluginLeavesNoAllowlist(t *testing.T) {
	m := manager(t, nil)
	a, _ := m.Lookup("openclaw")
	config := filepath.Join(m.env.Home, ".openclaw", "openclaw.json")
	os.MkdirAll(filepath.Dir(config), 0755)
	os.WriteFile(config, []byte("{}\n"), 0600)
	files := fstest.MapFS{"openclaw.plugin.json": {Data: []byte(`{"id": "example"}`)}}
	if result, err := a.Install("secret", "https://provider.example", WithPlugin("example", files)); err != nil || !result.Complete {
		t.Fatalf("install %+v %v", result, err)
	}
	raw, _ := os.ReadFile(config)
	if strings.Contains(string(raw), "allow") {
		t.Fatalf("openclaw.json =\n%s", raw)
	}
	if err := a.Uninstall(); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(config); string(raw) != "{}\n" {
		t.Fatalf("ejected openclaw.json =\n%s", raw)
	}
}

func TestOnlyPluginHostsAcceptAPlugin(t *testing.T) {
	m := manager(t, nil)
	a, _ := m.Lookup("claude-code")
	if _, err := a.Install("secret", "https://provider.example", WithPlugin("example", fstest.MapFS{})); err == nil {
		t.Fatal("claude-code accepted a plugin")
	}
	a, _ = m.Lookup("hermes")
	if _, err := a.Install("secret", "https://provider.example", WithPlugin("../escape", fstest.MapFS{})); err == nil {
		t.Fatal("hermes accepted an invalid plugin name")
	}
	a, _ = m.Lookup("openclaw")
	for name, files := range map[string]fstest.MapFS{
		"../escape": {"openclaw.plugin.json": {Data: []byte(`{"id": "../escape"}`)}},
		"aap":       {"openclaw.plugin.json": {Data: []byte(`{"id": "aap"}`)}},
		"other":     {"openclaw.plugin.json": {Data: []byte(`{"id": "example"}`)}},
		"bare":      {"index.js": {Data: []byte("export default {};\n")}},
	} {
		if _, err := a.Install("secret", "https://provider.example", WithPlugin(name, files)); err == nil {
			t.Fatalf("openclaw accepted plugin %q", name)
		}
	}
	if entries, _ := os.ReadDir(m.env.ConfigDir); len(entries) != 0 {
		t.Fatalf("a refused plugin wrote files: %v", entries)
	}
}

// A runtime plugin that keeps the token in the runtime's own secret store
// passes it to the hook; nothing is saved by an install.
func TestHookUsesAPassedInCredential(t *testing.T) {
	p := testprovider.New(t)
	passed := map[string]string{"AAP_INSTANCE_TOKEN": "test-token", "AAP_BASE_URL": p.Server.URL + "/custom/aap/"}
	m, err := NewWithEnvironment(Environment{Home: t.TempDir(), ConfigDir: t.TempDir(), Executable: "/opt/provider/bin/provider", Getenv: func(key string) string { return passed[key] }})
	if err != nil {
		t.Fatal(err)
	}
	a, _ := m.Lookup("hermes")
	var out bytes.Buffer
	payload := `{"hook_event_name":"pre_tool_call","tool_name":"terminal","tool_input":{"command":"ls"},"session_id":"s","extra":{"tool_call_id":"c1"}}`
	if err := a.RunHook(context.Background(), strings.NewReader(payload), &out); err != nil || !strings.Contains(out.String(), `"modify"`) {
		t.Fatalf("%s %v", out.String(), err)
	}
	if len(p.Inputs()) != 1 || p.Inputs()[0].Tool != "terminal" {
		t.Fatalf("requests %+v", p.Inputs())
	}
	passed["AAP_BASE_URL"] = "http://provider.example/aap"
	out.Reset()
	if err := a.RunHook(context.Background(), strings.NewReader(payload), &out); err == nil || !strings.Contains(out.String(), `"block"`) {
		t.Fatalf("insecure passed-in URL accepted: %s %v", out.String(), err)
	}
}
func TestHermesFollowsHermesHome(t *testing.T) {
	hermesHome := filepath.Join(t.TempDir(), "data")
	os.MkdirAll(hermesHome, 0755)
	os.WriteFile(filepath.Join(hermesHome, "config.yaml"), []byte("model: hermes-4\n"), 0600)
	m, err := NewWithEnvironment(Environment{Home: t.TempDir(), ConfigDir: t.TempDir(), Executable: "/opt/provider/bin/provider", LookPath: func(string) (string, error) { return "", os.ErrNotExist }, Getenv: func(key string) string {
		if key == "HERMES_HOME" {
			return hermesHome
		}
		return ""
	}})
	if err != nil {
		t.Fatal(err)
	}
	a, _ := m.Lookup("hermes")
	files := fstest.MapFS{"plugin.yaml": {Data: []byte("name: example\n")}}
	if result, err := a.Install("secret", "https://provider.example", WithPlugin("example", files)); err != nil || !result.Complete {
		t.Fatalf("install %+v %v", result, err)
	}
	if _, err := os.Stat(filepath.Join(hermesHome, "plugins", "example", "aap.json")); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(hermesHome, "config.yaml"))
	if !strings.Contains(string(raw), "example") {
		t.Fatalf("config.yaml = %s", raw)
	}
}
func TestMissingCredentialsDeny(t *testing.T) {
	m := manager(t, nil)
	for _, info := range All() {
		a, _ := m.Lookup(info.Key)
		var out bytes.Buffer
		err := a.RunHook(context.Background(), strings.NewReader(`{"hook_event_name":"PermissionRequest"}`), &out)
		if err == nil || (!strings.Contains(out.String(), "deny") && !strings.Contains(out.String(), "block")) {
			t.Fatalf("%s: %s %v", info.Key, out.String(), err)
		}
	}
}
func TestLibraryRunsNormalizedFilter(t *testing.T) {
	p := testprovider.New(t)
	m := manager(t, nil)
	a, _ := m.Lookup("claude-code")
	if _, err := a.Install("test-token", p.Server.URL+"/custom/aap", WithToolGlob("create_*")); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := a.RunHook(context.Background(), strings.NewReader(`{"hook_event_name":"PreToolUse","session_id":"s","tool_use_id":"1","tool_name":"mcp__stripe__create_refund","tool_input":{"amount":1}}`), &out)
	if err != nil || out.Len() != 0 {
		t.Fatalf("%s %v", out.String(), err)
	}
	if len(p.Inputs()) != 1 || p.Inputs()[0].Tool != "create_refund" {
		t.Fatal("wrong request")
	}
}

func TestStatusRecognizesAnotherImportingExecutable(t *testing.T) {
	m := manager(t, nil)
	a, _ := m.Lookup("claude-code")
	if _, err := a.Install("secret", "https://provider.example"); err != nil {
		t.Fatal(err)
	}
	m.env.Binary = "/different/aap"
	status, err := a.Status()
	if err != nil || !status.Complete {
		t.Fatalf("status from another CLI: %+v %v", status, err)
	}
}

func TestManualOpenClawRegistrationIsReportedIncomplete(t *testing.T) {
	m := manager(t, nil)
	path := filepath.Join(m.env.Home, ".openclaw", "openclaw.json")
	os.MkdirAll(filepath.Dir(path), 0700)
	original := []byte("{ // user comment\n gateway: {port: 18789}\n}\n")
	os.WriteFile(path, original, 0600)
	a, _ := m.Lookup("openclaw")
	result, err := a.Install("secret", "https://provider.example")
	if err == nil || result.Complete || len(result.Notes) == 0 {
		t.Fatalf("JSON5 result %+v %v", result, err)
	}
	actual, _ := os.ReadFile(path)
	if !bytes.Equal(actual, original) {
		t.Fatal("JSON5 config was overwritten")
	}
	if err = a.Uninstall(); err != nil {
		t.Fatal(err)
	}
}
func TestRefusedCredentialNamesImportingExecutable(t *testing.T) {
	p := testprovider.New(t)
	m := manager(t, nil)
	a, _ := m.Lookup("claude-code")
	if _, err := a.Install("revoked-token", p.Server.URL+"/custom/aap"); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := a.RunHook(context.Background(), strings.NewReader(`{"hook_event_name":"PreToolUse","session_id":"s","tool_use_id":"1","tool_name":"Bash","tool_input":{"command":"ls"}}`), &out)
	if err != nil || !strings.Contains(out.String(), "provider agent eject claude-code") {
		t.Fatalf("%s %v", out.String(), err)
	}
}
