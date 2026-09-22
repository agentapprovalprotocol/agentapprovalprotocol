// Package testprovider is an in-memory AAP provider used only by tests.
package testprovider

import (
	"encoding/json"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type Provider struct {
	Server   *httptest.Server
	mu       sync.Mutex
	requests map[string]*aap.Request
	keys     map[string]string
	Calls    int
	Cancels  int
	Status   aap.Status
	Pending  bool
	Mutate   func(*aap.Request)
	Bodies   []aap.CreateInput
}

func New(t *testing.T) *Provider {
	t.Helper()
	p := &Provider{requests: map[string]*aap.Request{}, keys: map[string]string{}, Status: aap.StatusApproved}
	p.Server = httptest.NewServer(http.HandlerFunc(p.serve))
	t.Cleanup(p.Server.Close)
	return p
}
func (p *Provider) Counts() (int, int) { p.mu.Lock(); defer p.mu.Unlock(); return p.Calls, p.Cancels }
func (p *Provider) Inputs() []aap.CreateInput {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]aap.CreateInput(nil), p.Bodies...)
}
func (p *Provider) serve(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer test-token" {
		w.WriteHeader(401)
		return
	}
	const prefix = "/custom/aap/v1/requests"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		w.WriteHeader(404)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	var req *aap.Request
	switch r.Method {
	case "POST":
		var in aap.CreateInput
		dec := json.NewDecoder(r.Body)
		dec.UseNumber()
		if dec.Decode(&in) != nil {
			w.WriteHeader(400)
			return
		}
		p.Calls++
		p.Bodies = append(p.Bodies, in)
		key := r.Header.Get("Idempotency-Key")
		if key == "" {
			w.WriteHeader(400)
			return
		}
		id := p.keys[key]
		req = p.requests[id]
		if req == nil {
			now := time.Now().UTC()
			id = uuid.NewString()
			req = &aap.Request{ID: id, Tool: in.Tool, Server: in.Server, Arguments: in.Arguments, Timeout: in.Timeout, Context: in.Context, AgentReasoning: in.AgentReasoning, Status: aap.StatusPending, CreatedAt: now.Format(time.RFC3339Nano), DeadlineAt: now.Add(time.Minute).Format(time.RFC3339Nano)}
			p.keys[key] = id
			p.requests[id] = req
		}
		if !p.Pending {
			p.decide(req)
		}
		w.WriteHeader(201)
	case "GET":
		req = p.requests[strings.TrimPrefix(r.URL.Path, prefix+"/")]
		if req == nil {
			w.WriteHeader(404)
			return
		}
		if !p.Pending {
			p.decide(req)
		}
	case "DELETE":
		p.Cancels++
		req = p.requests[strings.TrimPrefix(r.URL.Path, prefix+"/")]
		if req == nil {
			w.WriteHeader(404)
			return
		}
		req.Status = aap.StatusCancelled
		req.Decision = &aap.WireDecision{Status: req.Status, DecidedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	default:
		w.WriteHeader(405)
		return
	}
	out := *req
	if req.Decision != nil {
		d := *req.Decision
		out.Decision = &d
	}
	if p.Mutate != nil {
		p.Mutate(&out)
	}
	json.NewEncoder(w).Encode(out)
}
func (p *Provider) decide(r *aap.Request) {
	if r.Status != aap.StatusPending {
		return
	}
	r.Status = p.Status
	now := time.Now().UTC()
	r.Decision = &aap.WireDecision{Status: r.Status, DecidedAt: now.Format(time.RFC3339Nano)}
	if r.Status == aap.StatusApproved {
		r.Decision.ExpiresAt = now.Add(time.Minute).Format(time.RFC3339Nano)
	}
}
func (p *Provider) Approve() { p.mu.Lock(); defer p.mu.Unlock(); p.Pending = false }
func (p *Provider) Client(t *testing.T) *aap.Client {
	c := aap.NewClient(p.Server.URL+"/custom/aap", "test-token")
	c.StateDir = t.TempDir()
	return c
}
