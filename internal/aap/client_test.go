package aap_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/testprovider"
)

func input() aap.CreateInput {
	return aap.CreateInput{Tool: "create_refund", Arguments: map[string]any{"amount": json.Number("9007199254740993")}, Timeout: "5s", Context: map[string]any{"runtime": "pi", "session_id": "s", "call_id": "c"}, IdempotencyKey: "attempt"}
}
func TestImmediatePollingAndOutcomes(t *testing.T) {
	for _, status := range []aap.Status{aap.StatusApproved, aap.StatusDenied, aap.StatusCancelled, aap.StatusExpired} {
		t.Run(string(status), func(t *testing.T) {
			p := testprovider.New(t)
			p.Status = status
			d, err := p.Client(t).Decide(context.Background(), input())
			if err != nil || d.Status != status {
				t.Fatalf("decision %+v: %v", d, err)
			}
		})
	}
	t.Run("poll", func(t *testing.T) {
		p := testprovider.New(t)
		p.Pending = true
		c := p.Client(t)
		time.AfterFunc(20*time.Millisecond, p.Approve)
		d, err := c.Decide(context.Background(), input())
		if err != nil || !d.Allows() {
			t.Fatalf("decision %+v: %v", d, err)
		}
	})
}
func TestInvalidDecisionsFailClosed(t *testing.T) {
	cases := map[string]func(*aap.Request){
		"missing decision":    func(r *aap.Request) { r.Decision = nil },
		"unknown status":      func(r *aap.Request) { r.Status = "unknown" },
		"mismatched decision": func(r *aap.Request) { r.Decision.Status = aap.StatusDenied },
		"wrong tool":          func(r *aap.Request) { r.Tool = "delete_account" },
		"wrong arguments":     func(r *aap.Request) { r.Arguments = map[string]any{"amount": json.Number("9007199254740992")} },
		"wrong context":       func(r *aap.Request) { r.Context = nil },
		"invalid id":          func(r *aap.Request) { r.ID = "../wrong" },
		"missing timeout":     func(r *aap.Request) { r.Timeout = "" },
		"missing expiry":      func(r *aap.Request) { r.Decision.ExpiresAt = "" },
		"bad expiry":          func(r *aap.Request) { r.Decision.ExpiresAt = r.CreatedAt },
		"non utc": func(r *aap.Request) {
			r.Decision.ExpiresAt = time.Now().Add(time.Hour).Format("2006-01-02T15:04:05-07:00")
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			p := testprovider.New(t)
			p.Mutate = mutate
			d, err := p.Client(t).Decide(context.Background(), input())
			if err == nil || d.Allows() {
				t.Fatalf("invalid decision permitted: %+v %v", d, err)
			}
		})
	}
	t.Run("expired permission", func(t *testing.T) {
		p := testprovider.New(t)
		p.Mutate = func(r *aap.Request) {
			r.CreatedAt = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
			r.Decision.DecidedAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
			r.Decision.ExpiresAt = time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
		}
		d, err := p.Client(t).Decide(context.Background(), input())
		if err != nil || d.Status != aap.StatusExpired {
			t.Fatalf("%+v %v", d, err)
		}
	})
}
func TestConcurrentAndRestartReplay(t *testing.T) {
	p := testprovider.New(t)
	c := p.Client(t)
	var allowed atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			d, _ := c.Decide(context.Background(), input())
			if d.Allows() {
				allowed.Add(1)
			}
		}()
	}
	wg.Wait()
	if allowed.Load() != 1 {
		t.Fatalf("granted %d times", allowed.Load())
	}
	next := p.Client(t)
	next.StateDir = c.StateDir
	d, err := next.Decide(context.Background(), input())
	if err == nil || d.Allows() {
		t.Fatal("replayed across clients")
	}
	fresh := input()
	fresh.Context["call_id"] = "another-call"
	fresh.IdempotencyKey = "another-attempt"
	d, err = c.Decide(context.Background(), fresh)
	if err != nil || !d.Allows() {
		t.Fatalf("fresh attempt blocked: %v", err)
	}
}
func TestMissingCallIDRequestsFreshApproval(t *testing.T) {
	p := testprovider.New(t)
	c := p.Client(t)
	in := input()
	delete(in.Context, "call_id")
	for i := 0; i < 2; i++ {
		d, err := c.Decide(context.Background(), in)
		if err != nil || !d.Allows() {
			t.Fatalf("fresh approval: %v", err)
		}
	}
}
func TestConsumptionFailureBlocks(t *testing.T) {
	p := testprovider.New(t)
	c := p.Client(t)
	c.StateDir = filepath.Join(t.TempDir(), "file")
	os.WriteFile(c.StateDir, []byte("x"), 0600)
	d, err := c.Decide(context.Background(), input())
	if err == nil || d.Allows() {
		t.Fatal("storage failure permitted execution")
	}
}
func TestGlobAndURL(t *testing.T) {
	p := testprovider.New(t)
	c := p.Client(t)
	c.ToolGlob = "read_*"
	d, err := c.Decide(context.Background(), input())
	if err != nil || !d.Bypassed {
		t.Fatalf("filter: %+v %v", d, err)
	}
	n, _ := p.Counts()
	if n != 0 {
		t.Fatal("nonmatching call contacted provider")
	}
	c.ToolGlob = "["
	if _, err = c.Decide(context.Background(), input()); err == nil {
		t.Fatal("invalid glob accepted")
	}
	for _, url := range []string{"http://example.com/aap", "https://u:p@example.com", "https://example.com?x=1", "relative"} {
		if aap.ValidateConfig("token", url, "") == nil {
			t.Fatalf("accepted %s", url)
		}
	}
}
func TestCancellationWithdrawsAndCannotApprove(t *testing.T) {
	p := testprovider.New(t)
	p.Pending = true
	c := p.Client(t)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(20*time.Millisecond, cancel)
	d, err := c.Decide(ctx, input())
	if err != nil || d.Status != aap.StatusCancelled {
		t.Fatalf("%+v %v", d, err)
	}
	_, cancelled := p.Counts()
	if cancelled != 1 {
		t.Fatalf("cancel calls: %d", cancelled)
	}
}
func TestRetryPreservesSubmissionAndKey(t *testing.T) {
	p := testprovider.New(t)
	var keys, bodies []string
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		bodies = append(bodies, string(raw))
		if len(keys) == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(503)
			return
		}
		req, _ := http.NewRequest("POST", p.Server.URL+r.URL.Path, strings.NewReader(string(raw)))
		req.Header = r.Header
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		defer resp.Body.Close()
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	}))
	defer proxy.Close()
	c := aap.NewClient(proxy.URL+"/custom/aap", "test-token")
	c.StateDir = t.TempDir()
	d, err := c.Decide(context.Background(), input())
	if err != nil || !d.Allows() {
		t.Fatalf("%+v %v", d, err)
	}
	if len(keys) != 2 || keys[0] == "" || keys[0] != keys[1] || bodies[0] != bodies[1] {
		t.Fatal("retry changed submission")
	}
}
func TestPollCannotSubstituteRequest(t *testing.T) {
	p := testprovider.New(t)
	p.Pending = true
	var calls atomic.Int32
	p.Mutate = func(r *aap.Request) {
		if calls.Add(1) > 1 {
			r.ID = "11111111-1111-4111-8111-111111111111"
		}
	}
	d, err := p.Client(t).Decide(context.Background(), input())
	if err == nil || d.Allows() {
		t.Fatal("changed poll request accepted")
	}
	_, cancels := p.Counts()
	if cancels != 1 {
		t.Fatalf("cancelled %d", cancels)
	}
}

func TestMalformedWireObjectsRejected(t *testing.T) {
	for name, change := range map[string]func(string) string{
		"unknown field":   func(s string) string { return strings.TrimSuffix(s, "}") + `,"reviewer":"private"}` },
		"wrong case":      func(s string) string { return strings.Replace(s, `"tool":`, `"Tool":`, 1) },
		"duplicate field": func(s string) string { return strings.TrimSuffix(s, "}") + `,"tool":"create_refund"}` },
		"null context": func(s string) string {
			return strings.Replace(s, `"context":{"call_id":"c","runtime":"pi","session_id":"s"}`, `"context":null`, 1)
		},
	} {
		t.Run(name, func(t *testing.T) {
			p := testprovider.New(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				req, _ := http.NewRequest(r.Method, p.Server.URL+r.URL.Path, r.Body)
				req.Header = r.Header
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					w.WriteHeader(500)
					return
				}
				defer resp.Body.Close()
				raw, _ := io.ReadAll(resp.Body)
				raw = []byte(strings.TrimSpace(string(raw)))
				w.WriteHeader(resp.StatusCode)
				io.WriteString(w, change(string(raw)))
			}))
			defer server.Close()
			c := aap.NewClient(server.URL+"/custom/aap", "test-token")
			c.StateDir = t.TempDir()
			d, err := c.Decide(context.Background(), input())
			if err == nil || d.Allows() {
				t.Fatal("malformed response accepted")
			}
		})
	}
}
func TestRedirectDoesNotSendCredential(t *testing.T) {
	var leaked atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true) }))
	defer destination.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	c := aap.NewClient(server.URL, "test-token")
	c.StateDir = t.TempDir()
	if d, err := c.Decide(context.Background(), input()); err == nil || d.Allows() {
		t.Fatal("redirect accepted")
	}
	if leaked.Load() {
		t.Fatal("credential followed redirect")
	}
}
