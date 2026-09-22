// Package codextools recovers the server-defined identity of a Codex MCP
// tool call. Codex sanitises server and tool names to [A-Za-z0-9_] before
// its hooks see them, so mcp__google_mail__gmail_send_email could have
// come from gmail.send_email on the server "google-mail". The server is
// recovered from Codex's config, and the tool by listing that server's
// tools once and remembering which sanitised spelling each real name
// takes. Anything that cannot be recovered keeps the sanitised spelling,
// so a request is only ever improved, never denied, by this package.
package codextools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	toml "github.com/pelletier/go-toml/v2"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/mcpclient"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/storage"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/tool"
)

// cacheFile holds the sanitised-to-real tool names per server alias.
const cacheFile = "codex-tools.json"

// relistAfter is how soon a server whose cache lacks a name is listed
// again. A name that truly does not exist would otherwise cost a listing
// on every call.
const relistAfter = time.Minute

// Home is Codex's home directory: CODEX_HOME when set, else ~/.codex. The
// hook runs as a child of Codex, so it inherits the same variable.
func Home(getenv func(string) string) string {
	if home := strings.TrimSpace(getenv("CODEX_HOME")); home != "" {
		return home
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(userHome, ".codex")
}

// Sanitize mirrors Codex: anything outside ASCII letters, digits, and
// underscore becomes an underscore (codex-mcp sanitize_responses_api_tool_name).
// Codex additionally appends a hash suffix when two names collide after
// sanitising or the name exceeds 128 bytes; those names miss the cache and
// keep their sanitised spelling.
func Sanitize(value string) string {
	var out strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' {
			out.WriteRune(r)
		} else {
			out.WriteByte('_')
		}
	}
	return out.String()
}

// HookName is the spelling Codex hands its hook for one server-defined
// tool: the sanitised alias and name joined with the mcp__ marker, with
// underscores trimmed at the seam.
func HookName(server, name string) string {
	return "mcp__" + strings.TrimRight(Sanitize(server), "_") + "__" + strings.TrimLeft(Sanitize(name), "_")
}

// Resolver recovers identities for one Codex installation.
type Resolver struct {
	// Home is Codex's home directory, where config.toml lives.
	Home string
	// CacheDir is where the listing cache is kept; empty disables listing,
	// so only the server alias is recovered.
	CacheDir string
	// List lists a server's tools; nil uses the MCP client.
	List func(context.Context, mcpclient.Spec) ([]mcpclient.Tool, error)
	// Now is the clock; nil uses time.Now.
	Now func() time.Time
}

// Resolve turns the identity split from a hook name into the one the
// request should carry. A built-in tool (no server) is returned as is,
// as is a server Codex's config does not name (Codex Apps, for one).
func (r Resolver) Resolve(ctx context.Context, id tool.Identity) tool.Identity {
	if id.Server == "" || r.Home == "" {
		return id
	}
	servers, err := Servers(filepath.Join(r.Home, "config.toml"))
	if err != nil {
		return id
	}
	var server *mcpclient.Spec
	for i := range servers {
		if strings.TrimRight(Sanitize(servers[i].Name), "_") == id.Server {
			server = &servers[i]
			break
		}
	}
	if server == nil {
		return id
	}
	resolved := tool.Identity{Tool: id.Tool, Server: server.Name}
	if r.CacheDir == "" {
		return resolved
	}
	cache := r.load()
	entry := cache[server.Name]
	if name, ok := entry.Tools[id.Tool]; ok {
		resolved.Tool = name
		return resolved
	}
	now := r.now()
	if !entry.ListedAt.IsZero() && now.Sub(entry.ListedAt) < relistAfter {
		return resolved
	}
	list := r.List
	if list == nil {
		list = mcpclient.ListTools
	}
	tools, err := list(ctx, *server)
	if err != nil {
		return resolved
	}
	entry = cacheEntry{ListedAt: now, Tools: map[string]string{}}
	for _, t := range tools {
		key := strings.TrimLeft(Sanitize(t.Name), "_")
		if _, taken := entry.Tools[key]; !taken {
			entry.Tools[key] = t.Name
		}
	}
	cache[server.Name] = entry
	r.save(cache)
	if name, ok := entry.Tools[id.Tool]; ok {
		resolved.Tool = name
	}
	return resolved
}

type cacheEntry struct {
	ListedAt time.Time         `json:"listed_at"`
	Tools    map[string]string `json:"tools"`
}

func (r Resolver) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r Resolver) load() map[string]cacheEntry {
	cache := map[string]cacheEntry{}
	raw, err := os.ReadFile(filepath.Join(r.CacheDir, cacheFile))
	if err != nil {
		return cache
	}
	if json.Unmarshal(raw, &cache) != nil {
		return map[string]cacheEntry{}
	}
	return cache
}

func (r Resolver) save(cache map[string]cacheEntry) {
	raw, err := json.MarshalIndent(cache, "", "  ")
	if err != nil {
		return
	}
	_ = storage.Write(filepath.Join(r.CacheDir, cacheFile), raw, 0o600)
}

// Servers reads the [mcp_servers.<name>] tables of a Codex config:
// command, args, env and cwd for stdio; url with http_headers,
// env_http_headers (header names mapped to the environment variables
// holding their values) and bearer_token_env_var for streamable HTTP. A
// table with enabled = false is one Codex itself will not start. A
// missing file is an empty list.
func Servers(configPath string) ([]mcpclient.Spec, error) {
	return servers(configPath, os.Getenv)
}

func servers(configPath string, getenv func(string) string) ([]mcpclient.Spec, error) {
	content, err := os.ReadFile(configPath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var table struct {
		Servers map[string]map[string]any `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal(content, &table); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(table.Servers))
	for name := range table.Servers {
		names = append(names, name)
	}
	sort.Strings(names)
	var servers []mcpclient.Spec
	for _, name := range names {
		entry := table.Servers[name]
		if enabled, ok := entry["enabled"].(bool); ok && !enabled {
			continue
		}
		spec := mcpclient.Spec{Name: name}
		if url := asString(entry["url"]); url != "" {
			spec.URL = url
			spec.Headers = asStringMap(entry["http_headers"])
			for header, variable := range asStringMap(entry["env_http_headers"]) {
				if value := getenv(variable); value != "" {
					if spec.Headers == nil {
						spec.Headers = map[string]string{}
					}
					spec.Headers[header] = value
				}
			}
			if variable := asString(entry["bearer_token_env_var"]); variable != "" {
				if token := getenv(variable); token != "" {
					if spec.Headers == nil {
						spec.Headers = map[string]string{}
					}
					spec.Headers["Authorization"] = "Bearer " + token
				}
			}
		} else {
			spec.Command = asString(entry["command"])
			spec.Args = asStrings(entry["args"])
			spec.Env = asStringMap(entry["env"])
			spec.Cwd = asString(entry["cwd"])
		}
		if spec.Command == "" && spec.URL == "" {
			continue
		}
		servers = append(servers, spec)
	}
	return servers, nil
}

func asString(value any) string {
	s, _ := value.(string)
	return s
}

func asStrings(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func asStringMap(value any) map[string]string {
	table, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]string{}
	for key, item := range table {
		if s, ok := item.(string); ok {
			out[key] = s
		}
	}
	return out
}
