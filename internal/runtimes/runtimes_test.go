package runtimes

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

var update = flag.Bool("update", false, "rewrite golden files")

const testBinary = "/opt/aap/bin/aap"

// scenario is one runtime's golden case: a fixture home under
// testdata/<name>/before, the files an install is expected to leave under
// testdata/<name>/after (relative to the home, or under config/ for files
// in aap's own directory), and a tamper step that edits a file the
// way a person might after setup so eject has to strip rather than
// restore.
type scenario struct {
	name    string
	key     catalog.Key
	plan    HookPlan
	files   []string
	created []string
	tamper  func(t *testing.T, env Env)
	manual  bool
}

var scenarios = []scenario{
	{
		name: "claude-code", key: catalog.ClaudeCode,
		plan:  HookPlan{Matcher: ".*"},
		files: []string{".claude/settings.json"},
		tamper: func(t *testing.T, env Env) {
			appendJSONKey(t, filepath.Join(env.Home, ".claude", "settings.json"), "theme", "dark")
		},
	},
	{
		name: "codex", key: catalog.Codex,
		plan:  HookPlan{Matcher: ".*"},
		files: []string{".codex/config.toml"},
		tamper: func(t *testing.T, env Env) {
			appendLine(t, filepath.Join(env.Home, ".codex", "config.toml"), "\n[profiles.fast]\nmodel = \"gpt-5-mini\"\n")
		},
	},
	{
		name: "openclaw", key: catalog.OpenClaw,
		plan:  HookPlan{},
		files: []string{".openclaw/openclaw.json", "config/plugins/openclaw/index.js"},
		tamper: func(t *testing.T, env Env) {
			appendJSONKey(t, filepath.Join(env.Home, ".openclaw", "openclaw.json"), "theme", "dark")
		},
	},
	{
		name: "openclaw-json5", key: catalog.OpenClaw,
		plan:   HookPlan{},
		files:  []string{".openclaw/openclaw.json", "config/plugins/openclaw/index.js"},
		manual: true,
	},
	{
		name: "pi", key: catalog.Pi,
		plan:    HookPlan{},
		files:   []string{"config/plugins/pi/aap.json", "config/plugins/pi/index.js"},
		created: []string{"config/plugins/pi/aap.json"},
	},
	{
		name: "hermes", key: catalog.Hermes,
		plan:  HookPlan{},
		files: []string{".hermes/config.yaml"},
		tamper: func(t *testing.T, env Env) {
			appendLine(t, filepath.Join(env.Home, ".hermes", "config.yaml"), "verbose: true\n")
		},
	},
	{
		name: "deepseek", key: catalog.DeepSeek,
		plan:    HookPlan{Matcher: ".*"},
		files:   []string{".dsh/profiles/default/cordis.patch.yml", "config/deepseek/hooks.json"},
		created: []string{"config/deepseek/hooks.json"},
		tamper: func(t *testing.T, env Env) {
			appendLine(t, filepath.Join(env.Home, ".dsh", "profiles", "default", "cordis.patch.yml"), "- id: telemetry\n  name: '@deepseek-ai/dsh-telemetry'\n")
		},
	},
}

func TestAdaptersInstallIdempotentlyAndEject(t *testing.T) {
	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			adapter, ok := Lookup(sc.key)
			if !ok {
				t.Fatalf("no adapter for %s", sc.key)
			}
			env, runs := fixtureEnv(t, sc.name, sc.key)
			before := snapshot(t, env.Home)

			det, err := adapter.Detect(env)
			if err != nil {
				t.Fatalf("Detect: %v", err)
			}
			if !det.Installed || det.AlreadyHooked {
				t.Fatalf("Detect = %+v, want installed and not hooked", det)
			}

			result, err := adapter.Install(env, det, sc.plan)
			if err != nil {
				t.Fatalf("Install: %v", err)
			}
			if !result.Report.OK || result.Report.Runtime != string(sc.key) {
				t.Fatalf("report = %+v", result.Report)
			}
			if result.Report.Manual != sc.manual {
				t.Fatalf("manual = %v, want %v (report %+v)", result.Report.Manual, sc.manual, result.Report)
			}
			for _, rel := range sc.files {
				compareGolden(t, sc.name, rel, resolve(env, rel), env)
			}
			if sc.key == catalog.Pi {
				if last := (*runs)[len(*runs)-1]; last != "/fake/bin/pi install "+pluginDir(env, sc.key) {
					t.Fatalf("pi install not run: %v", *runs)
				}
			}

			det, err = adapter.Detect(env)
			if err != nil {
				t.Fatalf("Detect after install: %v", err)
			}
			if det.AlreadyHooked == sc.manual {
				t.Fatalf("already_hooked after install = %v (manual %v)", det.AlreadyHooked, sc.manual)
			}

			after := snapshot(t, env.Home)
			again, err := adapter.Install(env, det, sc.plan)
			if err != nil {
				t.Fatalf("second Install: %v", err)
			}
			if len(again.Report.Changes) != 0 {
				t.Fatalf("second install reported changes: %+v", again.Report.Changes)
			}
			if diff := diffSnapshots(after, snapshot(t, env.Home)); diff != "" {
				t.Fatalf("second install changed files:\n%s", diff)
			}
			if len(again.Record.Files) != len(result.Record.Files) {
				t.Fatalf("second install recorded %d files, first %d", len(again.Record.Files), len(result.Record.Files))
			}

			if err := adapter.Eject(env, result.Record); err != nil {
				t.Fatalf("Eject: %v", err)
			}
			if diff := diffSnapshots(before, snapshot(t, env.Home)); diff != "" {
				t.Fatalf("eject did not restore the home byte for byte:\n%s", diff)
			}
			for _, rel := range sc.created {
				if exists(resolve(env, rel)) {
					t.Fatalf("%s should be gone after eject", rel)
				}
			}
			for _, dir := range result.Record.Dirs {
				if exists(dir) {
					t.Fatalf("%s should be gone after eject", dir)
				}
			}
			det, err = adapter.Detect(env)
			if err != nil {
				t.Fatalf("Detect after eject: %v", err)
			}
			if det.AlreadyHooked {
				t.Fatal("still hooked after eject")
			}
		})
	}
}

func TestEjectStripsOnlyOurEntriesWhenTheFileChanged(t *testing.T) {
	for _, sc := range scenarios {
		if sc.tamper == nil {
			continue
		}
		t.Run(sc.name, func(t *testing.T) {
			adapter, _ := Lookup(sc.key)
			env, _ := fixtureEnv(t, sc.name, sc.key)
			det, err := adapter.Detect(env)
			if err != nil {
				t.Fatal(err)
			}
			result, err := adapter.Install(env, det, sc.plan)
			if err != nil {
				t.Fatal(err)
			}
			sc.tamper(t, env)
			if err := adapter.Eject(env, result.Record); err != nil {
				t.Fatalf("Eject: %v", err)
			}
			compareGolden(t, sc.name, "ejected/"+sc.files[0], resolve(env, sc.files[0]), env)
			det, err = adapter.Detect(env)
			if err != nil {
				t.Fatal(err)
			}
			if det.AlreadyHooked {
				t.Fatal("still hooked after eject")
			}
		})
	}
}

func TestDetectReportsAbsentRuntimes(t *testing.T) {
	env := Env{Home: t.TempDir(), ConfigDir: t.TempDir(), Binary: testBinary, LookPath: func(name string) (string, error) {
		return "", fmt.Errorf("%s: not found", name)
	}}
	detections, err := DetectAll(env)
	if err != nil {
		t.Fatal(err)
	}
	if len(detections) != len(catalog.All()) {
		t.Fatalf("got %d detections, want %d", len(detections), len(catalog.All()))
	}
	for _, det := range detections {
		if det.Installed || det.AlreadyHooked || det.Version != "" {
			t.Fatalf("%s should be absent: %+v", det.Runtime, det)
		}
	}
}

func TestHookCommandQuotesPaths(t *testing.T) {
	env := Env{Binary: "/Applications/with human/aap"}
	got := env.hookCommand(catalog.ClaudeCode)
	want := "AAP_CONFIG_DIR='' '/Applications/with human/aap' hook claude-code"
	if got != want {
		t.Fatalf("hookCommand = %q, want %q", got, want)
	}
	if !isOurHookCommand(got, catalog.ClaudeCode) || isOurHookCommand(got, catalog.Codex) {
		t.Fatal("isOurHookCommand misidentified the command")
	}
}

// fixtureEnv copies testdata/<name>/before into a temporary home and
// returns an Env whose PATH holds the runtime's binary and whose Run
// records every command it is asked to execute.
func fixtureEnv(t *testing.T, name string, key catalog.Key) (Env, *[]string) {
	t.Helper()
	home := t.TempDir()
	copyTree(t, filepath.Join("testdata", name, "before"), home)
	runtime, _ := catalog.Lookup(key)
	var runs []string
	env := Env{
		Home: home, ConfigDir: filepath.Join(t.TempDir(), "aap"), Binary: testBinary,
		LookPath: func(binary string) (string, error) {
			if binary == runtime.Binary {
				return "/fake/bin/" + binary, nil
			}
			return "", fmt.Errorf("%s: not found", binary)
		},
		Run: func(_ context.Context, command string, args ...string) ([]byte, error) {
			runs = append(runs, strings.Join(append([]string{command}, args...), " "))
			if len(args) == 1 && args[0] == "--version" {
				return []byte(runtime.Binary + " 1.2.3\n"), nil
			}
			return []byte("ok\n"), nil
		},
		Getenv: func(string) string { return "" },
	}
	return env, &runs
}

func resolve(env Env, rel string) string {
	if strings.HasPrefix(rel, "config/") {
		return filepath.Join(env.ConfigDir, strings.TrimPrefix(rel, "config/"))
	}
	return filepath.Join(env.Home, rel)
}

// compareGolden checks an actual file against testdata/<name>/after/<rel>
// with the machine-specific paths replaced by placeholders.
func compareGolden(t *testing.T, name, rel, actualPath string, env Env) {
	t.Helper()
	actual, err := os.ReadFile(actualPath)
	if err != nil {
		t.Fatalf("read %s: %v", actualPath, err)
	}
	normalised := normalise(actual, env)
	golden := filepath.Join("testdata", name, "after", rel)
	if strings.HasPrefix(rel, "ejected/") {
		golden = filepath.Join("testdata", name, rel)
	}
	if *update {
		if err := os.MkdirAll(filepath.Dir(golden), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(golden, normalised, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("missing golden %s (run with -update): %v", golden, err)
	}
	if !bytes.Equal(normalised, want) {
		t.Fatalf("%s differs from golden %s:\n--- want\n%s\n--- got\n%s", actualPath, golden, want, normalised)
	}
}

func normalise(content []byte, env Env) []byte {
	replacer := strings.NewReplacer(env.ConfigDir, "{{CONFIG}}", env.Home, "{{HOME}}", testBinary, "{{BINARY}}")
	normalized := replacer.Replace(string(content))
	normalized = regexp.MustCompile(`sha256:[0-9a-f]{64}`).ReplaceAllString(normalized, "sha256:{{TRUST_HASH}}")
	return []byte(normalized)
}

func copyTree(t *testing.T, from, to string) {
	t.Helper()
	err := filepath.WalkDir(from, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, path)
		target := filepath.Join(to, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, content, 0o644)
	})
	if err != nil {
		t.Fatalf("copy fixture: %v", err)
	}
}

func snapshot(t *testing.T, root string) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		files[rel] = content
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	return files
}

func diffSnapshots(before, after map[string][]byte) string {
	var lines []string
	for path, content := range before {
		got, ok := after[path]
		switch {
		case !ok:
			lines = append(lines, "missing: "+path)
		case !bytes.Equal(content, got):
			lines = append(lines, fmt.Sprintf("changed: %s\n--- before\n%s\n--- after\n%s", path, content, got))
		}
	}
	for path := range after {
		if _, ok := before[path]; !ok {
			lines = append(lines, "added: "+path)
		}
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

func appendLine(t *testing.T, path, text string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(content, text...), 0o644); err != nil {
		t.Fatal(err)
	}
}

func appendJSONKey(t *testing.T, path, key, value string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := loadJSONObject(content, true)
	if err != nil {
		t.Fatal(err)
	}
	doc.Root.Set(key, value)
	if err := os.WriteFile(path, doc.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}
