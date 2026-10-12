package aap

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/tool"
	"github.com/google/uuid"
)

type Client struct {
	BaseURL, Token, ToolGlob string
	// CacheDir is where hooks keep local caches they can rebuild, such as
	// the Codex tool name listings; empty disables them.
	CacheDir string
	// EjectCommand removes this adapter from its runtime. Deny reasons
	// quote it when the provider refuses the credential.
	EjectCommand string
	HTTP         *http.Client
}

func ValidateConfig(token, baseURL, glob string) error {
	if strings.TrimSpace(token) == "" || strings.ContainsAny(token, "\r\n") {
		return errors.New("instance token is required and must not contain newlines")
	}
	u, err := url.Parse(baseURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("base URL must be an absolute AAP URL without credentials, query or fragment")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return errors.New("base URL requires HTTPS, except on localhost")
	}
	if _, err := path.Match(glob, ""); err != nil {
		return errors.New("invalid tool glob")
	}
	return nil
}
func NewClient(baseURL, token string) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), Token: token, HTTP: &http.Client{Timeout: 35 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func IdempotencyKey(attempt string, call tool.Identity, args map[string]any) string {
	raw, _ := json.Marshal(args)
	return digest(attempt + "\x00" + call.Server + "\x00" + call.Tool + "\x00" + string(raw))
}
func digest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

// Decide runs one execution attempt. It never grants permission after abandonment.
func (c *Client) Decide(ctx context.Context, in CreateInput) (Decision, error) {
	if err := ValidateConfig(c.Token, c.BaseURL, c.ToolGlob); err != nil {
		return Decision{}, err
	}
	if c.ToolGlob != "" {
		matched, _ := path.Match(c.ToolGlob, in.Tool)
		if !matched {
			return Decision{Status: StatusApproved, Bypassed: true}, nil
		}
	}
	// Include the full immutable submission, runtime and MCP server in the key.
	// Without a stable call ID every invocation requires a fresh approval.
	if id, _ := in.Context["call_id"].(string); id == "" {
		in.IdempotencyKey = uuid.NewString()
	}
	body, err := json.Marshal(in)
	if err != nil {
		return Decision{}, errors.New("invalid tool call")
	}
	// Canonical JSON with preserved numbers is also used for response comparisons.
	if err := Decode(body, &in); err != nil {
		return Decision{}, err
	}
	key := digest(in.IdempotencyKey + "\x00" + string(body))
	// Decode intentionally does not change the non-wire key field.
	window, err := time.ParseDuration(in.Timeout)
	if err != nil || window <= 0 {
		return Decision{}, errors.New("invalid approval timeout")
	}
	work, cancel := context.WithTimeout(ctx, window+10*time.Second)
	defer cancel()
	req, err := c.exchange(work, http.MethodPost, "/v1/requests", body, key, in, nil)
	if err != nil {
		return Decision{}, err
	}
	abandoned := true
	defer func() {
		if abandoned {
			c.cancel(req.ID)
		}
	}()
	deadline, _ := time.Parse(time.RFC3339Nano, req.DeadlineAt)
	pollUntil := deadline.Add(10 * time.Second)
	if outer, ok := work.Deadline(); ok && outer.Before(pollUntil) {
		pollUntil = outer
	}
	pollCtx, pollCancel := context.WithDeadline(work, pollUntil)
	defer pollCancel()
	for req.Status == StatusPending {
		if pollCtx.Err() != nil {
			if ctx.Err() != nil {
				return Decision{Status: StatusCancelled}, nil
			}
			return Decision{Status: StatusExpired}, nil
		}
		wait := max(1, min(25, int(time.Until(pollUntil).Seconds())))
		pollStarted := time.Now()
		req, err = c.exchange(pollCtx, http.MethodGet, "/v1/requests/"+req.ID+"?wait="+strconv.Itoa(wait)+"s", nil, "", in, req)
		if err != nil {
			if ctx.Err() != nil {
				return Decision{Status: StatusCancelled}, nil
			}
			if pollCtx.Err() != nil {
				return Decision{Status: StatusExpired}, nil
			}
			return Decision{}, err
		}
		if req.Status == StatusPending && time.Since(pollStarted) < 100*time.Millisecond {
			_ = pause(pollCtx, 100*time.Millisecond)
		}
	}
	if work.Err() != nil {
		return Decision{Status: StatusCancelled}, nil
	}
	abandoned = false
	d := Decision{Status: req.Status, Note: req.Decision.Note}
	if req.Status != StatusApproved {
		return d, nil
	}
	d.ExpiresAt, _ = time.Parse(time.RFC3339Nano, req.Decision.ExpiresAt)
	if !d.Allows() {
		return Decision{Status: StatusExpired}, nil
	}
	if req.Consumption != nil {
		return Decision{Status: StatusConsumed}, nil
	}
	// Consume before emitting any permission. The provider records it once,
	// so neither a crash nor another replica can start the call again. The
	// key is fresh for this attempt and reused only for transport retries.
	consumeCtx, consumeCancel := context.WithDeadline(work, d.ExpiresAt)
	defer consumeCancel()
	consumed, err := c.exchange(consumeCtx, http.MethodPost, "/v1/requests/"+req.ID+"/consume", nil, uuid.NewString(), in, req)
	var conflict *ConflictError
	switch {
	case errors.As(err, &conflict) && conflict.Code == "already_consumed":
		return Decision{Status: StatusConsumed}, nil
	case errors.As(err, &conflict) && conflict.Code == "approval_expired":
		return Decision{Status: StatusExpired}, nil
	case err != nil && ctx.Err() != nil:
		return Decision{Status: StatusCancelled}, nil
	case err != nil && consumeCtx.Err() != nil:
		return Decision{Status: StatusExpired}, nil
	case err != nil:
		return Decision{}, err
	case consumed.Status != StatusApproved || consumed.Consumption == nil:
		return Decision{}, errors.New("invalid AAP response")
	}
	if ctx.Err() != nil {
		return Decision{Status: StatusCancelled}, nil
	}
	if !d.Allows() {
		return Decision{Status: StatusExpired}, nil
	}
	return d, nil
}
func (c *Client) exchange(ctx context.Context, method, endpoint string, body []byte, key string, in CreateInput, prev *Request) (*Request, error) {
	delay := 100 * time.Millisecond
	for {
		resp, err := c.do(ctx, method, endpoint, body, key)
		if err != nil {
			if ctx.Err() != nil {
				return prev, ctx.Err()
			}
			if err := pause(ctx, delay); err != nil {
				return prev, err
			}
			delay = min(delay*2, 2*time.Second)
			continue
		}
		retry := resp.StatusCode == 429 || resp.StatusCode >= 500
		if retry {
			retryAfter := resp.Header.Get("Retry-After")
			resp.Body.Close()
			wait := delay
			if retryAfter != "" {
				if n, e := strconv.Atoi(retryAfter); e == nil && n >= 0 && n <= int((1<<63-1)/int64(time.Second)) {
					wait = max(wait, time.Duration(n)*time.Second)
				} else if date, e := http.ParseTime(retryAfter); e == nil {
					wait = max(wait, time.Until(date))
				} else {
					return prev, errors.New("invalid Retry-After")
				}
			}
			if err := pause(ctx, wait); err != nil {
				return prev, err
			}
			delay = min(delay*2, 2*time.Second)
			continue
		}
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			resp.Body.Close()
			return prev, fmt.Errorf("%w (HTTP %d)", ErrCredentialRefused, resp.StatusCode)
		}
		if resp.StatusCode == http.StatusConflict {
			var envelope struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
			resp.Body.Close()
			if json.Unmarshal(raw, &envelope) != nil || envelope.Error.Code == "" {
				return prev, errors.New("AAP request failed (HTTP 409)")
			}
			return prev, &ConflictError{Code: envelope.Error.Code}
		}
		validCode := resp.StatusCode == http.StatusOK || (method == http.MethodPost && resp.StatusCode == http.StatusCreated)
		if !validCode {
			resp.Body.Close()
			return prev, fmt.Errorf("AAP request failed (HTTP %d)", resp.StatusCode)
		}
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, (8<<20)+1))
		resp.Body.Close()
		if readErr != nil || len(raw) > 8<<20 {
			return prev, errors.New("invalid AAP response")
		}
		out, decodeErr := decodeRequest(raw)
		if decodeErr != nil {
			return prev, errors.New("invalid AAP response")
		}

		if err = validate(out, in, prev); err != nil {
			return prev, err
		}
		return out, nil
	}
}

// ConflictError is a 409 answer, identified by the provider's error code,
// such as already_consumed or approval_expired.
type ConflictError struct{ Code string }

func (e *ConflictError) Error() string { return "AAP request conflict: " + e.Code }

func (c *Client) do(ctx context.Context, method, endpoint string, body []byte, key string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("invalid AAP URL")
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	return c.HTTP.Do(req)
}
func (c *Client) cancel(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, err := c.do(ctx, http.MethodDelete, "/v1/requests/"+id, nil, "")
	if err == nil {
		resp.Body.Close()
	}
}
func pause(ctx context.Context, wait time.Duration) error {
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
