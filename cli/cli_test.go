package cli_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/adapters"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/cli"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/testprovider"
)

func cliFixture(t *testing.T) (home, config string) {
	t.Helper()
	home, config = t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("AAP_CONFIG_DIR", config)
	t.Setenv("PATH", t.TempDir())
	t.Setenv("DSH_HOME", "")
	return home, config
}

func runCLI(t *testing.T, args []string, input string, wantCode int) (string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := cli.Run(context.Background(), "test", args, strings.NewReader(input), &stdout, &stderr)
	if code != wantCode {
		t.Fatalf("%v: exit %d, want %d; stdout=%q stderr=%q", args, code, wantCode, &stdout, &stderr)
	}
	return stdout.String(), stderr.String()
}

func writeCLIFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func readCLIFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestCLIUsage(t *testing.T) {
	_, config := cliFixture(t)
	for _, args := range [][]string{
		{"help"}, {"--help"}, {"-h"}, {"agent", "help"}, {"agent", "--help"}, {"agent", "-h"},
		{"agent", "discover", "--help"}, {"agent", "install", "--help"}, {"agent", "eject", "--help"},
		{"agent", "install", "claude-code", "-h"}, {"agent", "eject", "claude-code", "-h"},
	} {
		out, errOut := runCLI(t, args, "", 0)
		if errOut != "" || !strings.Contains(out, "aap agent discover [--json]") || !strings.Contains(out, "aap agent install <runtime>") || !strings.Contains(out, "aap agent eject <runtime> [--yes]") {
			t.Fatalf("help: stdout=%q stderr=%q", out, errOut)
		}
		for _, info := range adapters.All() {
			if !strings.Contains(out, info.Key) {
				t.Fatalf("help omitted runtime %s", info.Key)
			}
		}
	}
	for _, arg := range []string{"version", "--version", "-v"} {
		out, errOut := runCLI(t, []string{arg}, "", 0)
		if out != "aap test\n" || errOut != "" {
			t.Fatalf("version: stdout=%q stderr=%q", out, errOut)
		}
	}
	for _, args := range [][]string{
		nil, {"unknown"}, {"version", "extra"}, {"--version", "extra"}, {"-v", "extra"},
		{"adapters"}, {"install", "claude-code"}, {"status"}, {"status", "claude-code"}, {"uninstall", "claude-code"},
		{"agent"}, {"agent", "unknown"}, {"agent", "adapters"}, {"agent", "status"}, {"agent", "uninstall", "claude-code"},
		{"agent", "discover", "claude-code"}, {"agent", "discover", "--bad"}, {"agent", "discover", "--json=bad"},
		{"agent", "install"}, {"agent", "install", "--instance-token", "secret"}, {"agent", "install", "unknown"},
		{"agent", "install", "claude-code", "--instance-token"}, {"agent", "install", "claude-code", "extra"},
		{"agent", "eject"}, {"agent", "eject", "--yes"}, {"agent", "eject", "unknown", "--yes"},
		{"agent", "eject", "claude-code", "extra"}, {"agent", "eject", "claude-code", "--bad"},
		{"hook"}, {"hook", "claude-code", "extra"}, {"hook", "unknown"},
	} {
		out, errOut := runCLI(t, args, "yes\n", 2)
		if out != "" || errOut == "" {
			t.Fatalf("invalid arguments: stdout=%q stderr=%q", out, errOut)
		}
	}
	entries, err := os.ReadDir(config)
	if err != nil || len(entries) != 0 {
		t.Fatalf("help or invalid arguments changed configuration: %v %v", entries, err)
	}
}

func TestCLIRedaction(t *testing.T) {
	cliFixture(t)
	for _, tc := range []struct {
		args []string
		code int
	}{
		{[]string{"--instance-token", "TOP_SECRET", "--base-url", "bad"}, 1},
		{[]string{"--base-url", "https://provider.example"}, 1},
		{[]string{"--instance-token", "TOP_SECRET"}, 1},
		{[]string{"--instance-token", "TOP_SECRET", "--base-url", "https://provider.example", "--tool-glob", "[TOP_SECRET"}, 1},
		{[]string{"--bad=TOP_SECRET"}, 2},
		{[]string{"--instance-token", "TOP_SECRET", "extra"}, 2},
	} {
		out, errOut := runCLI(t, append([]string{"agent", "install", "claude-code"}, tc.args...), "", tc.code)
		if strings.Contains(out+errOut, "TOP_SECRET") || strings.Contains(out, "Installed") {
			t.Fatal("secret leaked")
		}
	}
}

func TestDiscoverEmpty(t *testing.T) {
	_, config := cliFixture(t)
	out, errOut := runCLI(t, []string{"agent", "discover"}, "", 0)
	if out != "No supported runtimes found.\n" || errOut != "" {
		t.Fatalf("empty discovery: %q %q", out, errOut)
	}
	out, errOut = runCLI(t, []string{"agent", "discover", "--json"}, "", 0)
	if out != "[]\n" || errOut != "" {
		t.Fatalf("empty JSON discovery: %q %q", out, errOut)
	}
	entries, err := os.ReadDir(config)
	if err != nil || len(entries) != 0 {
		t.Fatalf("discovery changed configuration: %v %v", entries, err)
	}
}

func discoverClaude(t *testing.T, state, baseURL, glob string) {
	t.Helper()
	out, errOut := runCLI(t, []string{"agent", "discover"}, "", 0)
	if out != "claude-code: runtime found; adapter "+state+"\n" || errOut != "" {
		t.Fatalf("discovery: %q %q", out, errOut)
	}
	out, errOut = runCLI(t, []string{"agent", "discover", "--json"}, "", 0)
	var statuses []adapters.Status
	if err := json.Unmarshal([]byte(out), &statuses); err != nil || len(statuses) != 1 {
		t.Fatalf("JSON discovery: %s %v", out, err)
	}
	s := statuses[0]
	if s.Runtime != "claude-code" || !s.Installed || s.Configured != (state != "not installed") || s.Complete != (state == "installed") || s.BaseURL != baseURL || s.ToolGlob != glob || errOut != "" || strings.Contains(out, "TOP_SECRET") {
		t.Fatalf("wrong discovery status: %s %s", out, errOut)
	}
}

func TestInstallAndDiscoveryLifecycle(t *testing.T) {
	home, config := cliFixture(t)
	provider := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("installation or discovery contacted the provider")
	}))
	defer provider.Close()
	url := provider.URL + "/custom/aap"
	settings := filepath.Join(home, ".claude", "settings.json")
	writeCLIFile(t, settings, `{"userChoice":true}`)
	discoverClaude(t, "not installed", "", "")
	args := []string{"agent", "install", "claude-code", "--instance-token", "TOP_SECRET", "--base-url", url, "--tool-glob", "create_*"}
	out, errOut := runCLI(t, args, "", 0)
	if errOut != "" || !strings.Contains(out, settings) || !strings.Contains(out, "restart") || !strings.HasSuffix(out, "Installed claude-code.\n") || strings.Contains(out, "TOP_SECRET") {
		t.Fatalf("install output: %q %q", out, errOut)
	}
	discoverClaude(t, "installed", url, "create_*")
	hooks := readCLIFile(t, settings)
	// Repeating installation updates credentials without duplicating hooks.
	args = []string{"agent", "install", "claude-code", "--instance-token", "replacement", "--base-url", url + "/other"}
	runCLI(t, args, "", 0)
	if readCLIFile(t, settings) != hooks {
		t.Fatal("repeat installation changed hooks")
	}
	credential := readCLIFile(t, filepath.Join(config, "credentials", "claude-code.json"))
	if !strings.Contains(credential, "replacement") || strings.Contains(credential, "TOP_SECRET") {
		t.Fatal("repeat installation did not replace the token")
	}
	discoverClaude(t, "installed", url+"/other", "")
	writeCLIFile(t, settings, `{"userChoice":true}`)
	discoverClaude(t, "incomplete", url+"/other", "")
	runCLI(t, args, "", 0)
	discoverClaude(t, "installed", url+"/other", "")
}

func TestIncompleteInstallPrintsNotes(t *testing.T) {
	home, _ := cliFixture(t)
	if err := os.MkdirAll(filepath.Join(home, ".pi"), 0700); err != nil {
		t.Fatal(err)
	}
	out, errOut := runCLI(t, []string{"agent", "install", "pi", "--instance-token", "TOP_SECRET", "--base-url", "https://provider.example"}, "", 1)
	if !strings.Contains(out, "pi install ") || !strings.Contains(out, "not found on PATH") || strings.Contains(out, "Installed pi.") || !strings.Contains(errOut, "incomplete") || strings.Contains(out+errOut, "TOP_SECRET") {
		t.Fatalf("incomplete installation notes: %q %q", out, errOut)
	}
	out, _ = runCLI(t, []string{"agent", "discover"}, "", 0)
	if out != "pi: runtime found; adapter incomplete\n" {
		t.Fatal(out)
	}
}

func TestDiscoverContinuesAfterErrors(t *testing.T) {
	home, config := cliFixture(t)
	for _, runtime := range []string{"claude-code", "codex"} {
		writeCLIFile(t, filepath.Join(config, "credentials", runtime+".json"), "invalid TOP_SECRET")
	}
	if err := os.MkdirAll(filepath.Join(home, ".pi"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, asJSON := range []bool{false, true} {
		args := []string{"agent", "discover"}
		if asJSON {
			args = append(args, "--json")
		}
		out, errOut := runCLI(t, args, "", 1)
		if !strings.Contains(errOut, "claude-code:") || !strings.Contains(errOut, "codex:") || strings.Contains(out+errOut, "TOP_SECRET") {
			t.Fatalf("missing or unsafe discovery errors: %q %q", out, errOut)
		}
		if asJSON {
			var statuses []adapters.Status
			if err := json.Unmarshal([]byte(out), &statuses); err != nil || len(statuses) != 1 || statuses[0].Runtime != "pi" || statuses[0].Configured {
				t.Fatalf("partial JSON discovery: %s %v", out, err)
			}
		} else if out != "pi: runtime found; adapter not installed\n" {
			t.Fatalf("partial discovery: %q", out)
		}
	}
}

func TestEjectConfirmation(t *testing.T) {
	for _, tc := range []struct {
		name, input string
		yes, remove bool
	}{
		{"yes", "yes\n", false, true}, {"uppercase", " Y \n", false, true}, {"mixed-case", "YeS\n", false, true},
		{"no", "no\n", false, false}, {"empty", "\n", false, false}, {"eof", "", false, false},
		{"unterminated", "yes", false, false}, {"other", "sure\n", false, false}, {"flag", "", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home, config := cliFixture(t)
			settings := filepath.Join(home, ".claude", "settings.json")
			original := "{\"userChoice\":true}\n"
			writeCLIFile(t, settings, original)
			runCLI(t, []string{"agent", "install", "claude-code", "--instance-token", "TOP_SECRET", "--base-url", "https://provider.example"}, "", 0)
			installed := readCLIFile(t, settings)
			credentialPath := filepath.Join(config, "credentials", "claude-code.json")
			credential := readCLIFile(t, credentialPath)
			args := []string{"agent", "eject", "claude-code"}
			if tc.yes {
				args = append(args, "--yes")
			}
			wantCode := 1
			if tc.remove {
				wantCode = 0
			}
			out, errOut := runCLI(t, args, tc.input, wantCode)
			if strings.Contains(out, "[y/N]") == tc.yes || strings.Contains(out+errOut, "TOP_SECRET") {
				t.Fatalf("eject prompt: %q %q", out, errOut)
			}
			if tc.remove {
				if errOut != "" || !strings.Contains(out, "Removed claude-code.") || !strings.Contains(out, "Revoke its instance token with your provider") || readCLIFile(t, settings) != original {
					t.Fatalf("eject failed: %q %q", out, errOut)
				}
				if _, err := os.Stat(credentialPath); !os.IsNotExist(err) {
					t.Fatalf("credentials remain: %v", err)
				}
			} else if !strings.Contains(errOut, "eject cancelled") || strings.Contains(out, "Removed") || readCLIFile(t, settings) != installed || readCLIFile(t, credentialPath) != credential {
				t.Fatal("cancelled eject changed the installation")
			}
		})
	}
}
func TestImportingExecutableInstallsAndRunsItsOwnHook(t *testing.T) {
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "host cli")
	mod := "module example.com/host\n\ngo 1.25.0\n\nrequire github.com/agentapprovalprotocol/agentapprovalprotocol v0.0.0\nreplace github.com/agentapprovalprotocol/agentapprovalprotocol => " + root + "\n"
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte(mod), 0600)
	source := `package main
import("os"; "github.com/agentapprovalprotocol/agentapprovalprotocol/cli")
func main(){os.Exit(cli.Main("test",os.Args[1:],os.Stdin,os.Stdout,os.Stderr))}`
	os.WriteFile(filepath.Join(dir, "main.go"), []byte(source), 0600)
	build := exec.Command("go", "build", "-mod=mod", "-o", binary, ".")
	build.Dir = dir
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("external build: %s %v", out, err)
	}
	home := t.TempDir()
	config := filepath.Join(t.TempDir(), "config with spaces")
	os.MkdirAll(filepath.Join(home, ".claude"), 0700)
	env := append(os.Environ(), "HOME="+home, "AAP_CONFIG_DIR="+config, "PATH=/usr/bin:/bin")
	p := testprovider.New(t)
	install := exec.Command(binary, "agent", "install", "claude-code", "--instance-token", "test-token", "--base-url", p.Server.URL+"/custom/aap")
	install.Env = env
	if out, err := install.CombinedOutput(); err != nil {
		t.Fatalf("install: %s %v", out, err)
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var settings struct {
		Hooks struct {
			PreToolUse []struct {
				Hooks []struct {
					Command string `json:"command"`
				} `json:"hooks"`
			} `json:"PreToolUse"`
		} `json:"hooks"`
	}
	if err = json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	command := settings.Hooks.PreToolUse[0].Hooks[0].Command
	if !strings.Contains(command, binary) || !strings.HasSuffix(command, " hook claude-code") || strings.Contains(command, "test-token") {
		t.Fatalf("bad hook: %s", command)
	}
	payload := `{"hook_event_name":"PreToolUse","session_id":"s","tool_use_id":"1","tool_name":"Bash","tool_input":{"command":"true"}}`
	run := func() string {
		t.Helper()
		cmd := exec.Command("/bin/sh", "-c", command)
		cmd.Env = append(env, "AAP_CONFIG_DIR="+t.TempDir())
		cmd.Stdin = strings.NewReader(payload)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("hook: %s %v", out, err)
		}
		return string(out)
	}
	if out := run(); out != "" {
		t.Fatalf("approval: %s", out)
	}
	if out := run(); !strings.Contains(out, "deny") {
		t.Fatalf("replay passed: %s", out)
	}
}
