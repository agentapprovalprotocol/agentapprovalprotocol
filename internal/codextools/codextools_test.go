package codextools

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/mcpclient"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/mcpclient/mcptest"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/tool"
)

func TestMain(m *testing.M) {
	mcptest.MaybeServe()
	os.Exit(m.Run())
}

func TestSanitizeAndHookName(t *testing.T) {
	for name, want := range map[string]string{"gmail.send_email": "gmail_send_email", "get-balance": "get_balance", "Plain_Name9": "Plain_Name9", "a b/c": "a_b_c"} {
		if got := Sanitize(name); got != want {
			t.Errorf("Sanitize(%q) = %q, want %q", name, got, want)
		}
	}
	if got := HookName("google-mail", "_get.balance"); got != "mcp__google_mail__get_balance" {
		t.Fatalf("HookName = %q", got)
	}
}

func writeConfig(t *testing.T, home, body string) {
	t.Helper()
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func fixtureConfig(alias string) string {
	command, env := mcptest.Command()
	body := "[mcp_servers." + strconv.Quote(alias) + "]\ncommand = " + strconv.Quote(command) + "\n[mcp_servers." + strconv.Quote(alias) + ".env]\n"
	for key, value := range env {
		body += key + " = " + strconv.Quote(value) + "\n"
	}
	return body
}

func TestResolveRecoversServerAndToolThroughStdioListing(t *testing.T) {
	home := filepath.Join(t.TempDir(), ".codex")
	writeConfig(t, home, fixtureConfig("google-mail")+"\n[mcp_servers.parked]\ncommand = \"parked-mcp\"\nenabled = false\n")
	r := Resolver{Home: home, CacheDir: t.TempDir()}
	for hook, want := range map[string]tool.Identity{
		"mcp__google_mail__gmail_send_email": {Tool: "gmail.send_email", Server: "google-mail"},
		"mcp__google_mail__get_balance":      {Tool: "get-balance", Server: "google-mail"},
		"mcp__google_mail__list_charges":     {Tool: "_list.charges", Server: "google-mail"},
		"mcp__google_mail__create_refund":    {Tool: "create_refund", Server: "google-mail"},
		// A name the server does not advertise keeps its sanitised spelling
		// under the recovered alias.
		"mcp__google_mail__unknown_tool": {Tool: "unknown_tool", Server: "google-mail"},
		// A server Codex's config does not name is left alone.
		"mcp__codex_apps__gmail__send_email": {Tool: "gmail__send_email", Server: "codex_apps"},
		// Built-in tools never reach the config.
		"Bash": {Tool: "Bash"},
	} {
		got := r.Resolve(context.Background(), tool.Identify(hook, tool.NamingMCPPrefixed))
		if got != want {
			t.Errorf("%s: got %+v, want %+v", hook, got, want)
		}
	}
}

func TestResolveUsesTheCacheBeforeListingAgain(t *testing.T) {
	home := filepath.Join(t.TempDir(), ".codex")
	writeConfig(t, home, fixtureConfig("stripe"))
	cache := t.TempDir()
	listings := 0
	now := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	r := Resolver{Home: home, CacheDir: cache, Now: func() time.Time { return now }, List: func(ctx context.Context, spec mcpclient.Spec) ([]mcpclient.Tool, error) {
		listings++
		return mcpclient.ListTools(ctx, spec)
	}}
	first := r.Resolve(context.Background(), tool.Identity{Tool: "gmail_send_email", Server: "stripe"})
	second := r.Resolve(context.Background(), tool.Identity{Tool: "get_balance", Server: "stripe"})
	if first.Tool != "gmail.send_email" || second.Tool != "get-balance" || listings != 1 {
		t.Fatalf("first %+v second %+v listings %d", first, second, listings)
	}
	// A miss within the relist window does not list again; after it, it does.
	r.Resolve(context.Background(), tool.Identity{Tool: "missing", Server: "stripe"})
	if listings != 1 {
		t.Fatalf("listed again within the window: %d", listings)
	}
	now = now.Add(2 * relistAfter)
	r.Resolve(context.Background(), tool.Identity{Tool: "missing", Server: "stripe"})
	if listings != 2 {
		t.Fatalf("did not relist after the window: %d", listings)
	}
	// The cache outlives the process: a fresh resolver with no way to list
	// still answers from it.
	fresh := Resolver{Home: home, CacheDir: cache, List: func(context.Context, mcpclient.Spec) ([]mcpclient.Tool, error) {
		return nil, errors.New("must not list")
	}}
	if got := fresh.Resolve(context.Background(), tool.Identity{Tool: "gmail_send_email", Server: "stripe"}); got.Tool != "gmail.send_email" {
		t.Fatalf("cache miss: %+v", got)
	}
}

func TestResolveOverHTTPAndUnauthorizedFallsBackToTheAlias(t *testing.T) {
	open := httptest.NewServer(mcptest.HTTPHandler(""))
	defer open.Close()
	locked := httptest.NewServer(mcptest.HTTPHandler("secret"))
	defer locked.Close()
	home := filepath.Join(t.TempDir(), ".codex")
	writeConfig(t, home, "[mcp_servers.remote]\nurl = "+strconv.Quote(open.URL)+"\n[mcp_servers.remote.http_headers]\nX-Test = \"1\"\n\n[mcp_servers.locked]\nurl = "+strconv.Quote(locked.URL)+"\n")
	r := Resolver{Home: home, CacheDir: t.TempDir()}
	if got := r.Resolve(context.Background(), tool.Identity{Tool: "gmail_send_email", Server: "remote"}); got != (tool.Identity{Tool: "gmail.send_email", Server: "remote"}) {
		t.Fatalf("http listing: %+v", got)
	}
	// Codex holds the OAuth token for this server in its keychain, so the
	// direct listing is refused: the alias is still recovered, the tool
	// keeps Codex's spelling.
	if got := r.Resolve(context.Background(), tool.Identity{Tool: "gmail_send_email", Server: "locked"}); got != (tool.Identity{Tool: "gmail_send_email", Server: "locked"}) {
		t.Fatalf("unauthorized listing: %+v", got)
	}
}

func TestResolveWithoutCacheDirRecoversOnlyTheAlias(t *testing.T) {
	home := filepath.Join(t.TempDir(), ".codex")
	writeConfig(t, home, fixtureConfig("google-mail"))
	r := Resolver{Home: home, List: func(context.Context, mcpclient.Spec) ([]mcpclient.Tool, error) {
		t.Fatal("listed without a cache directory")
		return nil, nil
	}}
	if got := r.Resolve(context.Background(), tool.Identity{Tool: "gmail_send_email", Server: "google_mail"}); got != (tool.Identity{Tool: "gmail_send_email", Server: "google-mail"}) {
		t.Fatalf("got %+v", got)
	}
	if got := (Resolver{}).Resolve(context.Background(), tool.Identity{Tool: "x", Server: "y"}); got != (tool.Identity{Tool: "x", Server: "y"}) {
		t.Fatalf("no home: %+v", got)
	}
}

func TestHomeHonoursCodexHome(t *testing.T) {
	if got := Home(func(string) string { return "/opt/codex" }); got != "/opt/codex" {
		t.Fatalf("Home = %q", got)
	}
	if got := Home(func(string) string { return "" }); filepath.Base(got) != ".codex" {
		t.Fatalf("Home = %q", got)
	}
}
