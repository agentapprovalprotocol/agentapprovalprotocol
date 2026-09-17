package credential

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/storage"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Manifest is <config>/install.json: the binary a setup wired into the
// runtimes and, per runtime, every file it touched, so eject can put each
// one back.
type Manifest struct {
	Binary   string                    `json:"binary"`
	Runtimes map[string]RuntimeInstall `json:"runtimes"`
}

// RuntimeInstall is one runtime's record.
type RuntimeInstall struct {
	InstalledAt time.Time  `json:"installed_at"`
	Files       []FileEdit `json:"files"`
	// Dirs are directories the install created outright (embedded plugin
	// copies); eject removes them whole.
	Dirs []string `json:"dirs,omitempty"`
}

// FileEditKind says whether an edit created a file or changed one.
type FileEditKind string

const (
	FileCreated  FileEditKind = "created"
	FileModified FileEditKind = "modified"
)

// FileEdit is one file a setup wrote. Backup is the copy taken before the
// first edit (empty for a created file) and AfterSHA256 the content the
// setup left, so eject can tell whether anything else changed the file
// since and either restore the backup byte for byte or strip only its
// own entries.
type FileEdit struct {
	Path        string       `json:"path"`
	Kind        FileEditKind `json:"kind"`
	Backup      string       `json:"backup,omitempty"`
	AfterSHA256 string       `json:"after_sha256"`
}

// ManifestPath is the manifest file under a config directory.
func ManifestPath(configDir string) string { return filepath.Join(configDir, "install.json") }

// BackupDir is where pre-edit copies live.
func BackupDir(configDir string) string { return filepath.Join(configDir, "backups") }

// LoadManifest reads the manifest; a missing file is an empty manifest.
func LoadManifest(configDir string) (*Manifest, error) {
	raw, err := os.ReadFile(ManifestPath(configDir))
	if errors.Is(err, fs.ErrNotExist) {
		return &Manifest{Runtimes: map[string]RuntimeInstall{}}, nil
	}
	if err != nil {
		return nil, err
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("install manifest: %w", err)
	}
	if manifest.Runtimes == nil {
		manifest.Runtimes = map[string]RuntimeInstall{}
	}
	return &manifest, nil
}

// SaveManifest writes the manifest, or removes it when nothing is left.
func SaveManifest(configDir string, manifest *Manifest) error {
	path := ManifestPath(configDir)
	if len(manifest.Runtimes) == 0 {
		err := os.Remove(path)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return storage.Write(path, append(raw, '\n'), 0600)
}

// Installed reports the runtimes in the manifest sorted by install time,
// which is the order eject reverses.
func (m *Manifest) Installed() []string {
	keys := make([]string, 0, len(m.Runtimes))
	for key := range m.Runtimes {
		keys = append(keys, key)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0; j-- {
			a, b := m.Runtimes[keys[j-1]], m.Runtimes[keys[j]]
			if a.InstalledAt.After(b.InstalledAt) || (a.InstalledAt.Equal(b.InstalledAt) && keys[j-1] > keys[j]) {
				keys[j-1], keys[j] = keys[j], keys[j-1]
			}
		}
	}
	return keys
}

// BackupPath names the pre-edit copy for one file of one runtime. The
// path is flattened so the backup directory stays one level deep.
func BackupPath(configDir, runtime, path string) string {
	flat := strings.NewReplacer("/", "__", `\`, "__", ":", "").Replace(strings.TrimPrefix(filepath.ToSlash(path), "/"))
	return filepath.Join(BackupDir(configDir), runtime, flat)
}

// Backup copies content to the backup location for path, once: an
// existing backup is the pre-setup state and is never overwritten by a
// re-run, otherwise a second setup would back up the first setup's edits.
func Backup(configDir, runtime, path string, content []byte) (string, error) {
	backup := BackupPath(configDir, runtime, path)
	if _, err := os.Stat(backup); err == nil {
		return backup, nil
	}
	if err := os.MkdirAll(filepath.Dir(backup), 0o700); err != nil {
		return "", err
	}
	return backup, storage.Write(backup, content, 0o600)
}

// SHA256 is the hex digest eject compares files against.
func SHA256(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}
