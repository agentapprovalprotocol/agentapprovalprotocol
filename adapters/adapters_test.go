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
