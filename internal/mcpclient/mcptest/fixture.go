// Package mcptest is a small MCP server tests run as a helper process by
// re-executing their own test binary, and as an HTTP handler.
package mcptest

import (
	"encoding/json"
	"io"
	"net/http"
	"os"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/jsonrpc"
)

// FixtureEnv is the environment variable that turns a test binary into
// the fixture server. Tests call MaybeServe from TestMain.
const FixtureEnv = "AAP_TEST_MCP_FIXTURE"

// MaybeServe serves the fixture over stdio and exits when the process was
// started as a helper, and returns at once otherwise.
func MaybeServe() {
	if os.Getenv(FixtureEnv) != "1" {
		return
	}
	ServeStdio(os.Stdin, os.Stdout)
	os.Exit(0)
}

// Command is the stdio command a test writes into a runtime's MCP
// configuration to reach the fixture: the test binary itself with the
// helper variable set.
func Command() (command string, env map[string]string) {
	exe, err := os.Executable()
	if err != nil {
		exe = os.Args[0]
	}
	return exe, map[string]string{FixtureEnv: "1"}
}

// Tools is the fixture's catalog: names Codex would sanitise, served in
// two pages so clients must follow nextCursor.
var Tools = []map[string]any{
	{"name": "gmail.send_email", "description": "Send a message.", "inputSchema": map[string]any{"type": "object"}},
	{"name": "get-balance", "description": "Read the balance.", "inputSchema": map[string]any{"type": "object"}},
	{"name": "_list.charges", "description": "List charges.", "inputSchema": map[string]any{"type": "object"}},
	{"name": "create_refund", "description": "Refund a charge.", "inputSchema": map[string]any{"type": "object"}},
}

type request struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params struct {
		ProtocolVersion string `json:"protocolVersion"`
		Cursor          string `json:"cursor"`
	} `json:"params"`
}

func result(id json.RawMessage, res any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": res}
}

// Handle answers one fixture request, or nil for a notification.
func Handle(msg request) map[string]any {
	switch msg.Method {
	case "initialize":
		return result(msg.ID, map[string]any{
			"protocolVersion": msg.Params.ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "aap-fixture", "version": "0.0.1"},
		})
	case "tools/list":
		if msg.Params.Cursor == "" {
			return result(msg.ID, map[string]any{"tools": Tools[:2], "nextCursor": "page-2"})
		}
		return result(msg.ID, map[string]any{"tools": Tools[2:]})
	default:
		if msg.ID != nil {
			return result(msg.ID, map[string]any{})
		}
		return nil
	}
}

// ServeStdio runs the fixture over newline-delimited JSON-RPC until stdin
// closes.
func ServeStdio(stdin io.Reader, stdout io.Writer) {
	out := jsonrpc.NewLineWriter(stdout)
	scanner := jsonrpc.NewScanner(stdin)
	for scanner.Scan() {
		var msg request
		if json.Unmarshal(scanner.Bytes(), &msg) != nil {
			continue
		}
		if resp := Handle(msg); resp != nil {
			_ = out.WriteJSON(resp)
		}
	}
}

// HTTPHandler serves the fixture as a streamable-HTTP MCP endpoint: one
// JSON response per POST, no SSE. A non-empty token turns away requests
// without that bearer token, the way an OAuth-protected endpoint does.
func HTTPHandler(token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token != "" && r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var msg request
		if err := json.Unmarshal(body, &msg); err != nil {
			http.Error(w, "bad json-rpc", http.StatusBadRequest)
			return
		}
		resp := Handle(msg)
		if resp == nil {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
}
