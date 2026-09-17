// Package cli provides the embeddable aap command dispatcher.
package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/adapters"
)

const usage = `aap: approval adapters for agent tool calls

Usage:
  aap agent discover [--json]
  aap agent install <runtime> --instance-token <token> --base-url <url> [--tool-glob <pattern>]
  aap agent eject <runtime> [--yes]
  aap version

Runtimes: claude-code, codex, openclaw, pi, hermes, deepseek
Configuration: AAP_CONFIG_DIR or the operating system user configuration directory plus aap.
The base URL is the complete AAP root; API paths start at /v1 beneath it.
`

// Main handles process signals and returns an exit code without calling os.Exit.
func Main(version string, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return Run(ctx, version, args, stdin, stdout, stderr)
}

// Run dispatches commands. Hosts can also call adapters.RunHook directly.
func Run(ctx context.Context, version string, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		return usageError(stderr)
	}
	if len(args) == 1 && isHelp(args[0]) {
		return showHelp(stdout, stderr)
	}
	switch args[0] {
	case "version", "--version", "-v":
		if len(args) != 1 {
			return usageError(stderr)
		}
		fmt.Fprintln(stdout, "aap", version)
		return 0
	case "agent":
		return runAgent(args[1:], stdin, stdout, stderr)
	case "hook":
		if len(args) != 2 {
			return usageError(stderr)
		}
		manager, err := adapters.New()
		if err != nil {
			return fail(stderr, err, 1)
		}
		adapter, err := manager.Lookup(args[1])
		if err != nil {
			return fail(stderr, err, 2)
		}
		if err = adapter.RunHook(ctx, stdin, stdout); err != nil {
			return fail(stderr, err, 1)
		}
		return 0
	default:
		return usageError(stderr)
	}
}

func runAgent(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		return usageError(stderr)
	}
	if len(args) == 1 && isHelp(args[0]) {
		return showHelp(stdout, stderr)
	}
	fs := flag.NewFlagSet("aap agent "+args[0], flag.ContinueOnError)
	// Flag errors can contain supplied credentials. Print static usage instead.
	fs.SetOutput(io.Discard)
	var token, url, glob, runtime string
	var asJSON, yes bool
	flags := args[1:]
	switch args[0] {
	case "discover":
		fs.BoolVar(&asJSON, "json", false, "emit JSON")
	case "install", "eject":
		if len(args) == 2 && isHelp(args[1]) {
			return showHelp(stdout, stderr)
		}
		if len(args) < 2 || strings.HasPrefix(args[1], "-") {
			return usageError(stderr)
		}
		runtime, flags = args[1], args[2:]
		if args[0] == "install" {
			fs.StringVar(&token, "instance-token", "", "instance token")
			fs.StringVar(&url, "base-url", "", "AAP base URL")
			fs.StringVar(&glob, "tool-glob", "", "normalized tool-name glob")
		} else {
			fs.BoolVar(&yes, "yes", false, "remove without prompting")
		}
	default:
		return usageError(stderr)
	}
	if err := fs.Parse(flags); errors.Is(err, flag.ErrHelp) {
		return showHelp(stdout, stderr)
	} else if err != nil || fs.NArg() != 0 {
		return usageError(stderr)
	}
	manager, err := adapters.New()
	if err != nil {
		return fail(stderr, err, 1)
	}
	if args[0] == "discover" {
		return discover(manager, asJSON, stdout, stderr)
	}
	adapter, err := manager.Lookup(runtime)
	if err != nil {
		return fail(stderr, err, 2)
	}
	switch args[0] {
	case "install":
		result, err := adapter.Install(token, url, adapters.WithToolGlob(glob))
		for _, change := range result.Changes {
			if _, writeErr := fmt.Fprintf(stdout, "%s: %s\n", change.Action, change.Path); writeErr != nil {
				return fail(stderr, writeErr, 1)
			}
		}
		for _, note := range result.Notes {
			if _, writeErr := fmt.Fprintln(stdout, note); writeErr != nil {
				return fail(stderr, writeErr, 1)
			}
		}
		if err != nil {
			return fail(stderr, err, 1)
		}
		if !result.Complete {
			return fail(stderr, errors.New("adapter registration is incomplete"), 1)
		}
		_, err = fmt.Fprintf(stdout, "Installed %s.\n", adapter.Key())
		if err != nil {
			return fail(stderr, err, 1)
		}
	case "eject":
		if !yes {
			if _, err := fmt.Fprintf(stdout, "Remove the %s adapter and local credentials? [y/N] ", adapter.Key()); err != nil {
				return fail(stderr, err, 1)
			}
			line, err := bufio.NewReader(stdin).ReadString('\n')
			answer := strings.ToLower(strings.TrimSpace(line))
			if err != nil || (answer != "y" && answer != "yes") {
				return fail(stderr, errors.New("eject cancelled"), 1)
			}
		}
		if err = adapter.Uninstall(); err != nil {
			return fail(stderr, err, 1)
		}
		_, err = fmt.Fprintf(stdout, "Removed %s. Revoke its instance token with your provider if it will no longer be used.\n", adapter.Key())
		if err != nil {
			return fail(stderr, err, 1)
		}
	}
	return 0
}

func discover(manager *adapters.Manager, asJSON bool, stdout, stderr io.Writer) int {
	statuses := []adapters.Status{}
	var errs []error
	for _, info := range adapters.All() {
		adapter, _ := manager.Lookup(info.Key)
		status, err := adapter.Status()
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", info.Key, err))
			continue
		}
		if status.Installed {
			statuses = append(statuses, status)
		}
	}
	if asJSON {
		if code := emit(stdout, stderr, statuses); code != 0 {
			return code
		}
	} else {
		for _, status := range statuses {
			state := "not installed"
			if status.Complete {
				state = "installed"
			} else if status.Configured {
				state = "incomplete"
			}
			if _, err := fmt.Fprintf(stdout, "%s: runtime found; adapter %s\n", status.Runtime, state); err != nil {
				return fail(stderr, err, 1)
			}
		}
		if len(statuses) == 0 {
			if _, err := fmt.Fprintln(stdout, "No supported runtimes found."); err != nil {
				return fail(stderr, err, 1)
			}
		}
	}
	if err := errors.Join(errs...); err != nil {
		return fail(stderr, err, 1)
	}
	return 0
}

func isHelp(arg string) bool { return arg == "help" || arg == "--help" || arg == "-h" }
func showHelp(stdout, stderr io.Writer) int {
	if _, err := fmt.Fprint(stdout, usage); err != nil {
		return fail(stderr, err, 1)
	}
	return 0
}
func usageError(stderr io.Writer) int {
	fmt.Fprint(stderr, usage)
	return 2
}
func emit(out, stderr io.Writer, value any) int {
	enc := json.NewEncoder(out)
	enc.SetIndent("", "  ")
	if err := enc.Encode(value); err != nil {
		return fail(stderr, err, 1)
	}
	return 0
}
func fail(out io.Writer, err error, code int) int { fmt.Fprintln(out, "aap:", err); return code }
