package credential

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestManifestRoundTripAndOrder(t *testing.T) {
	dir := t.TempDir()
	manifest, err := LoadManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Runtimes) != 0 {
		t.Fatalf("fresh manifest has runtimes: %v", manifest.Runtimes)
	}
	base := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	manifest.Binary = "/usr/local/bin/aap"
	manifest.Runtimes["hermes"] = RuntimeInstall{InstalledAt: base.Add(time.Minute)}
	manifest.Runtimes["claude-code"] = RuntimeInstall{InstalledAt: base, Files: []FileEdit{{Path: "/home/x/.claude/settings.json", Kind: FileModified, Backup: "b", AfterSHA256: "s"}}}
	manifest.Runtimes["codex"] = RuntimeInstall{InstalledAt: base.Add(2 * time.Minute)}
	if err := SaveManifest(dir, manifest); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := loaded.Installed()
	want := []string{"claude-code", "hermes", "codex"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Installed = %v, want %v", got, want)
		}
	}
	delete(loaded.Runtimes, "claude-code")
	delete(loaded.Runtimes, "hermes")
	delete(loaded.Runtimes, "codex")
	if err := SaveManifest(dir, loaded); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ManifestPath(dir)); !os.IsNotExist(err) {
		t.Fatalf("empty manifest should remove the file, stat = %v", err)
	}
}

func TestBackupKeepsTheFirstCopy(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join("/home", "x", ".claude", "settings.json")
	first, err := Backup(dir, "claude-code", path, []byte("original"))
	if err != nil {
		t.Fatal(err)
	}
	if first != filepath.Join(dir, "backups", "claude-code", "home__x__.claude__settings.json") {
		t.Fatalf("backup path = %s", first)
	}
	second, err := Backup(dir, "claude-code", path, []byte("after first setup"))
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("second backup path = %s, want %s", second, first)
	}
	content, err := os.ReadFile(first)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "original" {
		t.Fatalf("backup overwritten: %q", content)
	}
}
