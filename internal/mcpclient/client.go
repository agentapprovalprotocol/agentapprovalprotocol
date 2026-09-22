// Package mcpclient lists the tools an MCP server advertises. The Codex
// hook uses it to recover a tool's server-defined name from the sanitised
// spelling Codex hands it; it speaks just enough of the protocol for that
// (initialize, initialized, tools/list with cursor pagination) over stdio
// or streamable HTTP.
package mcpclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/jsonrpc"
)

// Timeout bounds one server end to end: spawn, handshake, and every page
// of the listing.
const Timeout = 10 * time.Second

// ProtocolVersion is the MCP revision the client announces.
const ProtocolVersion = "2025-06-18"

// Spec says how to reach one server. Command selects stdio; URL selects
// streamable HTTP. Exactly one must be set.
type Spec struct {
	Name    string
	Command string
	Args    []string
	Env     map[string]string
	Cwd     string
	URL     string
	Headers map[string]string
}

// Tool is one advertised tool. Only the name matters to the hook; the
// rest is kept so a caller can show what it found.
type Tool struct {
	Title       string          `json:"title,omitempty"`
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// ListTools connects to the server, completes the handshake, and pages
// through tools/list. The whole exchange is bounded by Timeout and by ctx.
func ListTools(ctx context.Context, spec Spec) ([]Tool, error) {
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()

	var t transport
	var err error
	switch {
	case spec.Command != "" && spec.URL != "":
		return nil, errors.New("server has both a command and a url")
	case spec.Command != "":
		t, err = startStdio(ctx, spec)
	case spec.URL != "":
		t = &httpTransport{url: spec.URL, headers: spec.Headers, http: &http.Client{}}
	default:
		return nil, errors.New("server has neither a command nor a url")
	}
	if err != nil {
		return nil, err
	}
	defer t.close()

	tools, err := list(ctx, t)
	if err != nil {
		return nil, t.decorate(err)
	}
	return tools, nil
}

func list(ctx context.Context, t transport) ([]Tool, error) {
	if _, err := t.call(ctx, "initialize", map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "aap", "version": "hook"},
	}); err != nil {
		return nil, fmt.Errorf("initialize: %w", err)
	}
	if err := t.notify(ctx, "notifications/initialized", nil); err != nil {
		return nil, fmt.Errorf("initialized: %w", err)
	}
	var tools []Tool
	cursor := ""
	for page := 0; page < 100; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := t.call(ctx, "tools/list", params)
		if err != nil {
			return nil, fmt.Errorf("tools/list: %w", err)
		}
		var result struct {
			Tools      []Tool `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			return nil, fmt.Errorf("tools/list: %w", err)
		}
		tools = append(tools, result.Tools...)
		if result.NextCursor == "" || result.NextCursor == cursor {
			return tools, nil
		}
		cursor = result.NextCursor
	}
	return nil, errors.New("tools/list: cursor never ended")
}

// transport is one connection to a server. call sends a request and waits
// for the matching response; notify sends a one-way message.
type transport interface {
	call(ctx context.Context, method string, params any) (json.RawMessage, error)
	notify(ctx context.Context, method string, params any) error
	decorate(err error) error
	close()
}

// stdioTransport talks to a child process over its pipes.
type stdioTransport struct{ *jsonrpc.Process }

func startStdio(ctx context.Context, spec Spec) (stdioTransport, error) {
	cmd := exec.CommandContext(ctx, spec.Command, spec.Args...)
	cmd.Dir = spec.Cwd
	cmd.Env = mergeEnv(os.Environ(), spec.Env)
	process, err := jsonrpc.StartProcess(cmd)
	if err != nil {
		return stdioTransport{}, err
	}
	return stdioTransport{process}, nil
}

func (t stdioTransport) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	return t.Call(ctx, method, params)
}

func (t stdioTransport) notify(ctx context.Context, method string, params any) error {
	return t.Notify(ctx, method, params)
}

func (t stdioTransport) decorate(err error) error { return t.Decorate(err) }
func (t stdioTransport) close()                   { t.Close() }

// httpTransport POSTs each message to a streamable-HTTP endpoint.
type httpTransport struct {
	url       string
	headers   map[string]string
	http      *http.Client
	nextID    int
	sessionID string
}

func (t *httpTransport) post(ctx context.Context, frame any) (*http.Response, error) {
	body, err := json.Marshal(frame)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", ProtocolVersion)
	if t.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", t.sessionID)
	}
	for k, v := range t.headers {
		req.Header.Set(k, v)
	}
	resp, err := t.http.Do(req)
	if err != nil {
		return nil, err
	}
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		t.sessionID = sid
	}
	return resp, nil
}

func (t *httpTransport) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	t.nextID++
	id := t.nextID
	resp, err := t.post(ctx, jsonrpc.Request(id, method, params))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var answer *jsonrpc.Message
	consider := func(payload []byte) {
		var msg jsonrpc.Message
		var gotID int
		if json.Unmarshal(payload, &msg) == nil && msg.IsRequest() && json.Unmarshal(msg.ID, &gotID) == nil && gotID == id {
			answer = &msg
		}
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		jsonrpc.ScanSSE(io.LimitReader(resp.Body, jsonrpc.MaxFrame), consider)
	} else {
		body, err := io.ReadAll(io.LimitReader(resp.Body, jsonrpc.MaxFrame))
		if err != nil {
			return nil, err
		}
		consider(bytes.TrimSpace(body))
	}
	if answer == nil {
		return nil, errors.New("no response with the request id")
	}
	if answer.Error != nil {
		return nil, answer.Error
	}
	return answer.Result, nil
}

func (t *httpTransport) notify(ctx context.Context, method string, params any) error {
	resp, err := t.post(ctx, jsonrpc.Notification(method, params))
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func (t *httpTransport) decorate(err error) error { return err }
func (t *httpTransport) close()                   {}

// mergeEnv lays overrides over a base environment, replacing same-named
// variables so a server's configured env wins over the process's.
func mergeEnv(base []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		return base
	}
	merged := make([]string, 0, len(base)+len(overrides))
	for _, kv := range base {
		key, _, _ := strings.Cut(kv, "=")
		if _, replaced := overrides[key]; !replaced {
			merged = append(merged, kv)
		}
	}
	keys := make([]string, 0, len(overrides))
	for key := range overrides {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		merged = append(merged, key+"="+overrides[key])
	}
	return merged
}
