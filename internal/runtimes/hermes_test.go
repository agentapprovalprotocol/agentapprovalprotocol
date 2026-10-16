package runtimes

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// hermesHookEnv returns an Env whose binary prints the AAP_CONFIG_DIR it
// receives and its arguments.
func hermesHookEnv(t *testing.T) Env {
	t.Helper()
	dir := t.TempDir()
	binary := filepath.Join(dir, "aap")
	script := "#!/bin/sh\nprintf '%s %s %s' \"$AAP_CONFIG_DIR\" \"$1\" \"$2\"\n"
	if err := os.WriteFile(binary, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return Env{Home: t.TempDir(), ConfigDir: filepath.Join(dir, "config"), Binary: binary}
}

func hermesHookCommands(t *testing.T, env Env) []string {
	t.Helper()
	root, err := hermes{}.load(env)
	if err != nil {
		t.Fatal(err)
	}
	var commands []string
	if seq := (hermes{}).preToolCall(root); seq != nil {
		for _, entry := range seq.Content {
			commands = append(commands, yamlString(entry, "command"))
		}
	}
	return commands
}

// Hermes splits a hook command into arguments and executes it without a
// shell, so the installed command must set AAP_CONFIG_DIR on its own.
func TestHermesHookRunsWithoutAShell(t *testing.T) {
	env := hermesHookEnv(t)
	if _, err := (hermes{}).Install(env, Detection{}, HookPlan{}); err != nil {
		t.Fatalf("Install: %v", err)
	}
	commands := hermesHookCommands(t, env)
	if len(commands) != 1 {
		t.Fatalf("pre_tool_call = %q, want one hook", commands)
	}
	argv := strings.Fields(commands[0])
	out, err := exec.Command(argv[0], argv[1:]...).Output()
	if err != nil {
		t.Fatalf("run %q without a shell: %v", commands[0], err)
	}
	if want := env.ConfigDir + " hook hermes"; string(out) != want {
		t.Fatalf("hook saw %q, want %q", out, want)
	}
}

func TestHermesInstallReplacesShellOnlyHook(t *testing.T) {
	env := hermesHookEnv(t)
	path := hermes{}.configPath(env)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	config := "hooks:\n  pre_tool_call:\n    - command: " + env.hookCommand("hermes") + "\n      timeout: 300\n      fail_closed: true\n"
	if err := os.WriteFile(path, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	det, err := hermes{}.Detect(env)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if det.AlreadyHooked {
		t.Fatal("a shell-only hook counts as installed")
	}
	if _, err := (hermes{}).Install(env, det, HookPlan{}); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if got, want := hermesHookCommands(t, env), []string{env.execHookCommand("hermes")}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("pre_tool_call = %q, want %q", got, want)
	}
}
