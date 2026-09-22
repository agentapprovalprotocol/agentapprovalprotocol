// Package jsonrpc holds the JSON-RPC line framing the MCP listing client
// uses: newline-delimited messages on a pipe, the subset of a frame worth
// routing on, and the SSE data-event framing a streamable-HTTP server
// answers with.
package jsonrpc

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"sync"
)

// MaxFrame bounds one newline-delimited message. Tool schemas and results
// can be large, so the ceiling is generous.
const MaxFrame = 32 * 1024 * 1024

// Message is the subset of a JSON-RPC frame both directions need: enough
// to pair a response with its request and to recognise a method.
type Message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`
}

// Error is the JSON-RPC error object.
type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Message }

// IsRequest reports whether the frame carries an id, which separates
// requests and responses from notifications.
func (m Message) IsRequest() bool {
	return len(m.ID) > 0 && string(m.ID) != "null"
}

// NewScanner frames newline-delimited messages from r with a buffer large
// enough for MaxFrame.
func NewScanner(r io.Reader) *bufio.Scanner {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1024*1024), MaxFrame)
	return scanner
}

// LineWriter serialises writes of whole frames onto one writer so
// concurrent goroutines never interleave bytes.
type LineWriter struct {
	mu sync.Mutex
	w  io.Writer
}

// NewLineWriter wraps w.
func NewLineWriter(w io.Writer) *LineWriter { return &LineWriter{w: w} }

// WriteLine writes one frame followed by a newline.
func (l *LineWriter) WriteLine(line []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.w.Write(line)
	_, _ = l.w.Write([]byte("\n"))
}

// WriteJSON marshals value and writes it as one frame.
func (l *LineWriter) WriteJSON(value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	l.WriteLine(raw)
	return nil
}

// Request builds a request frame.
func Request(id any, method string, params any) map[string]any {
	frame := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		frame["params"] = params
	}
	return frame
}

// Notification builds a notification frame.
func Notification(method string, params any) map[string]any {
	frame := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		frame["params"] = params
	}
	return frame
}

// ScanSSE reads a text/event-stream body and hands every event's joined
// data payload to emit. Events without data are skipped.
func ScanSSE(body io.Reader, emit func(payload []byte)) {
	scanner := NewScanner(body)
	var data []string
	flush := func() {
		if len(data) > 0 {
			emit([]byte(strings.Join(data, "\n")))
			data = nil
		}
	}
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		case line == "":
			flush()
		}
	}
	flush()
}
