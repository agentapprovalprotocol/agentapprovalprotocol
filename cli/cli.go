// Package cli provides the embeddable aap command dispatcher.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/adapters"
)

const usage = `aap: approval adapters for agent tool calls

Usage:
  aap adapters
  aap install <adapter> --instance-token <token> --base-url <url> [--tool-glob <pattern>]
  aap status [<adapter>]
  aap uninstall <adapter>
  aap hook <adapter>
  aap version

Adapters: claude-code, codex, openclaw, pi, hermes, deepseek
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
		fmt.Fprint(stderr, usage)
		return 2
	}
	if args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprint(stdout, usage)
		return 0
	}
	if args[0] == "version" {
		fmt.Fprintln(stdout, "aap", version)
		return 0
	}
	if args[0] == "adapters" {
		if len(args) != 1 {
			return fail(stderr, errors.New("adapters takes no arguments"), 2)
		}
		return emit(stdout, stderr, adapters.All())
	}
	manager, err := adapters.New()
	if err != nil {
		return fail(stderr, err, 1)
	}
	if args[0] == "status" && len(args) == 1 {
		var statuses []adapters.Status
		for _, info := range adapters.All() {
			a, _ := manager.Lookup(info.Key)
			s, err := a.Status()
			if err != nil {
				return fail(stderr, err, 1)
			}
			statuses = append(statuses, s)
		}
		return emit(stdout, stderr, statuses)
	}
	if len(args) < 2 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	adapter, err := manager.Lookup(args[1])
	if err != nil {
		return fail(stderr, err, 2)
	}
	switch args[0] {
	case "install":
		fs := flag.NewFlagSet("aap install", flag.ContinueOnError)
		fs.SetOutput(io.Discard)
		token := fs.String("instance-token", "", "instance token")
		url := fs.String("base-url", "", "AAP base URL")
		glob := fs.String("tool-glob", "", "normalized tool-name glob")
		if err = fs.Parse(args[2:]); err != nil || fs.NArg() != 0 {
			fmt.Fprint(stderr, usage)
			return 2
		}
		result, err := adapter.Install(*token, *url, adapters.WithToolGlob(*glob))
		if code := emit(stdout, stderr, result); code != 0 {
			return code
		}
		if err != nil {
			return fail(stderr, err, 1)
		}
		return 0
	case "status":
		if len(args) != 2 {
			return fail(stderr, errors.New("status takes at most one adapter"), 2)
		}
		result, err := adapter.Status()
		if err != nil {
			return fail(stderr, err, 1)
		}
		return emit(stdout, stderr, result)
	case "uninstall":
		if len(args) != 2 {
			return fail(stderr, errors.New("uninstall takes one adapter"), 2)
		}
		if err = adapter.Uninstall(); err != nil {
			return fail(stderr, err, 1)
		}
		fmt.Fprintln(stdout, "Uninstalled", adapter.Key())
		return 0
	case "hook":
		if len(args) != 2 {
			return fail(stderr, errors.New("hook takes one adapter"), 2)
		}
		if err = adapter.RunHook(ctx, stdin, stdout); err != nil {
			return fail(stderr, err, 1)
		}
		return 0
	default:
		fmt.Fprint(stderr, usage)
		return 2
	}
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
