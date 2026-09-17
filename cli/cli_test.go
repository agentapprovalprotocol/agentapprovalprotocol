package cli_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/cli"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/testprovider"
)

func TestCLIUsageAndRedaction(t *testing.T) {
	t.Setenv("AAP_CONFIG_DIR", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	for _, args := range [][]string{{"version"}, {"adapters"}, {"--help"}} {
		var out, err bytes.Buffer
		if cli.Run(context.Background(), "test", args, strings.NewReader(""), &out, &err) != 0 || out.Len() == 0 {
			t.Fatal(args, out.String(), err.String())
		}
	}
	for _, args := range [][]string{{"install", "claude-code", "--instance-token", "TOP_SECRET", "--base-url", "bad"}, {"install", "claude-code", "--bad=TOP_SECRET"}} {
		var out, err bytes.Buffer
		if cli.Run(context.Background(), "test", args, strings.NewReader(""), &out, &err) == 0 {
			t.Fatal("bad arguments passed")
		}
		if strings.Contains(out.String()+err.String(), "TOP_SECRET") {
			t.Fatal("secret leaked")
		}
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
	install := exec.Command(binary, "install", "claude-code", "--instance-token", "test-token", "--base-url", p.Server.URL+"/custom/aap")
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
	if !strings.Contains(command, binary) || strings.Contains(command, "test-token") {
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
