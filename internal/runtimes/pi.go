package runtimes

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

// pi wires Pi: the embedded extension package is written under our config
// directory with a aap.json naming the binary and credential, and
// `pi install <dir>` registers it. Pi has no MCP client, so there is
// nothing to discover beyond the built-ins.
type pi struct{}

func (pi) Key() catalog.Key { return catalog.Pi }

// installTimeout bounds `pi install`, which may resolve dependencies.
const piInstallTimeout = 60 * time.Second

func (p pi) Detect(env Env) (Detection, error) {
	runtime, _ := catalog.Lookup(p.Key())
	det := Detection{Runtime: string(p.Key())}
	binary, version := detectBinary(env, runtime)
	homeDir := filepath.Join(env.Home, runtime.HomeDir)
	det.Installed = binary != "" || exists(homeDir)
	if !det.Installed {
		return det, nil
	}
	det.BinaryPath, det.Version, det.ConfigPath = binary, version, homeDir
	det.AlreadyHooked = p.installed(env)
	return det, nil
}

func (p pi) configFile(env Env) string {
	return filepath.Join(pluginDir(env, p.Key()), "aap.json")
}

// installed reports whether the written extension names this binary.
func (p pi) installed(env Env) bool {
	content, existed, err := readFile(p.configFile(env))
	if err != nil || !existed {
		return false
	}
	var config struct {
		Binary string `json:"binary"`
	}
	return json.Unmarshal(content, &config) == nil && config.Binary == env.Binary && exists(filepath.Join(pluginDir(env, p.Key()), "index.js"))
}

func (p pi) Install(env Env, det Detection, _ HookPlan) (InstallResult, error) {
	dir := pluginDir(env, p.Key())
	ed := newEditor(env, p.Key())
	if err := ed.writePlugin("pi"); err != nil {
		return InstallResult{}, err
	}
	config, _ := json.MarshalIndent(map[string]any{"binary": env.Binary, "configDir": env.ConfigDir}, "", "  ")
	if err := ed.write(p.configFile(env), append(config, '\n')); err != nil {
		return InstallResult{}, err
	}
	if len(ed.changes) == 0 && det.AlreadyHooked {
		return ed.result(true, nil, []string{dir}), nil // nothing changed: Pi already has this package
	}
	installCommand := fmt.Sprintf("pi install %s", shellQuote(dir))
	binary := det.BinaryPath
	if binary == "" {
		binary, _ = env.lookPath("pi")
	}
	if binary == "" {
		result := ed.result(true, nil, []string{dir})
		result.Report.Manual = true
		result.Report.Message = "The pi executable was not found on PATH. Register the extension yourself:"
		result.Report.Snippet = installCommand
		return result, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), piInstallTimeout)
	defer cancel()
	out, err := env.run(ctx, binary, "install", dir)
	if err != nil {
		result := ed.result(true, nil, []string{dir})
		result.Report.Manual = true
		result.Report.Message = fmt.Sprintf("%s failed (%s). Run it yourself:", installCommand, strings.TrimSpace(firstLine(string(out), err.Error())))
		result.Report.Snippet = installCommand
		return result, nil
	}
	ed.changes = append(ed.changes, domainChange(dir, "installed"))
	return ed.result(true, []string{"A fresh Pi session loads the AAP extension."}, []string{dir}), nil
}

func (p pi) Eject(env Env, entry ManifestEntry) error {
	dir := pluginDir(env, p.Key())
	if binary, err := env.lookPath("pi"); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), piInstallTimeout)
		defer cancel()
		if _, err := env.run(ctx, binary, "uninstall", dir); err != nil {
			return fmt.Errorf("unregister Pi extension: %w", err)
		}
	} else {
		return fmt.Errorf("Pi executable is required to unregister the extension: %w", err)
	}
	return ejectFiles(env, entry, func(string, []byte) ([]byte, bool, error) { return nil, true, nil })
}

func firstLine(text, fallback string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return fallback
	}
	line, _, _ := strings.Cut(text, "\n")
	return line
}
