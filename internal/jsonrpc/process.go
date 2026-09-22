package jsonrpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Process is a JSON-RPC peer reached over a child process's pipes: one
// newline-delimited frame per message on stdin and stdout, responses
// paired with waiting calls by id.
type Process struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	out     *LineWriter
	stderr  *boundedBuffer
	nextID  int
	mu      sync.Mutex
	pending map[int]chan Message
	done    chan struct{}
	reaped  sync.Once
}

// StartProcess launches cmd with its stdio wired to a session. The
// caller sets up everything else on cmd (arguments, environment, working
// directory) and leaves Stdin, Stdout and Stderr unset.
func StartProcess(cmd *exec.Cmd) (*Process, error) {
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &boundedBuffer{limit: 8 * 1024}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", cmd.Path, err)
	}
	p := &Process{
		cmd: cmd, stdin: stdin, out: NewLineWriter(stdin), stderr: stderr,
		pending: map[int]chan Message{}, done: make(chan struct{}),
	}
	go p.read(stdout)
	return p, nil
}

func (p *Process) read(stdout io.Reader) {
	defer close(p.done)
	scanner := NewScanner(stdout)
	for scanner.Scan() {
		var msg Message
		if json.Unmarshal(scanner.Bytes(), &msg) != nil || !msg.IsRequest() || msg.Method != "" {
			continue // notifications and the child's own requests are not answers
		}
		var id int
		if json.Unmarshal(msg.ID, &id) != nil {
			continue
		}
		p.mu.Lock()
		ch, ok := p.pending[id]
		delete(p.pending, id)
		p.mu.Unlock()
		if ok {
			ch <- msg
		}
	}
}

// Call sends a request and waits for the matching response.
func (p *Process) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	p.mu.Lock()
	p.nextID++
	id := p.nextID
	ch := make(chan Message, 1)
	p.pending[id] = ch
	p.mu.Unlock()
	if err := p.out.WriteJSON(Request(id, method, params)); err != nil {
		return nil, err
	}
	select {
	case msg := <-ch:
		if msg.Error != nil {
			return nil, msg.Error
		}
		return msg.Result, nil
	case <-p.done:
		return nil, errors.New("process closed its output before answering")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Notify sends a one-way message.
func (p *Process) Notify(_ context.Context, method string, params any) error {
	return p.out.WriteJSON(Notification(method, params))
}

// Decorate folds captured stderr into an error so a crashing child
// explains itself. os/exec copies the child's stderr into the buffer on
// its own goroutine and only Wait joins it, so once the child's output
// has closed the child is reaped first; otherwise the buffer could still
// be missing the crash message.
func (p *Process) Decorate(err error) error {
	select {
	case <-p.done:
		p.reap()
	default:
	}
	if text := strings.TrimSpace(p.stderr.String()); text != "" {
		return fmt.Errorf("%w (stderr: %s)", err, text)
	}
	return err
}

// reap waits for the child once, giving a well-behaved child a moment
// to exit on its own and then making sure.
func (p *Process) reap() {
	p.reaped.Do(func() {
		waited := make(chan struct{})
		go func() {
			_ = p.cmd.Wait()
			close(waited)
		}()
		select {
		case <-waited:
		case <-time.After(500 * time.Millisecond):
			_ = p.cmd.Process.Kill()
			<-waited
		}
	})
}

// Close ends the session: the child's stdin closes and the child is
// reaped.
func (p *Process) Close() {
	_ = p.stdin.Close()
	p.reap()
}

// boundedBuffer keeps the first limit bytes written to it.
type boundedBuffer struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	limit int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if room := b.limit - b.buf.Len(); room > 0 {
		if len(p) > room {
			b.buf.Write(p[:room])
		} else {
			b.buf.Write(p)
		}
	}
	return len(p), nil
}

func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
