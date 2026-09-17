package plugins

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteIsIdempotent(t *testing.T) {
	for name, write := range map[string]func(string) ([]string, error){"openclaw": WriteOpenClaw, "pi": WritePi} {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), name)
			first, err := write(dir)
			if err != nil {
				t.Fatalf("first write: %v", err)
			}
			if len(first) == 0 {
				t.Fatal("first write wrote nothing")
			}
			if _, err := os.Stat(filepath.Join(dir, "index.js")); err != nil {
				t.Fatalf("index.js missing: %v", err)
			}
			second, err := write(dir)
			if err != nil {
				t.Fatalf("second write: %v", err)
			}
			if len(second) != 0 {
				t.Fatalf("second write rewrote %v", second)
			}
			if err := os.WriteFile(filepath.Join(dir, "index.js"), []byte("tampered"), 0o644); err != nil {
				t.Fatal(err)
			}
			third, err := write(dir)
			if err != nil {
				t.Fatal(err)
			}
			if len(third) != 1 || filepath.Base(third[0]) != "index.js" {
				t.Fatalf("third write = %v, want only index.js", third)
			}
		})
	}
}
