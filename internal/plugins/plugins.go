// Package plugins embeds the runtime-side halves of the OpenClaw and Pi
// adapters (plain ESM, no build step) and writes them to disk so a setup
// can point the runtime at a local directory.
package plugins

import (
	"bytes"
	"embed"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

//go:embed all:assets
var assets embed.FS

// WriteOpenClaw writes the OpenClaw plugin into dir and returns the files
// it wrote or refreshed. Unchanged files are left alone so a re-run is a
// no-op the runtime never notices.
func WriteOpenClaw(dir string) ([]string, error) { return write("assets/openclaw", dir) }

// WritePi writes the Pi extension package into dir.
func WritePi(dir string) ([]string, error) { return write("assets/pi", dir) }

// Files lists the relative paths one plugin ships, for callers that need
// to know which files are ours inside a directory.
func Files(plugin string) ([]string, error) {
	var names []string
	err := fs.WalkDir(assets, "assets/"+plugin, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		rel, _ := filepath.Rel("assets/"+plugin, path)
		names = append(names, rel)
		return nil
	})
	sort.Strings(names)
	return names, err
}

func write(root, dir string) ([]string, error) {
	var written []string
	err := fs.WalkDir(assets, root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		target := filepath.Join(dir, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		content, err := assets.ReadFile(path)
		if err != nil {
			return err
		}
		if existing, err := os.ReadFile(target); err == nil && bytes.Equal(existing, content) {
			return nil
		}
		if err := os.WriteFile(target, content, 0o644); err != nil {
			return err
		}
		written = append(written, target)
		return nil
	})
	sort.Strings(written)
	return written, err
}

func Read(plugin, name string) ([]byte, error) {
	return assets.ReadFile("assets/" + plugin + "/" + name)
}
