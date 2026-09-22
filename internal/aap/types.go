// Package aap implements the synchronous adapter side of the AAP wire contract.
package aap

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"reflect"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Status string

const (
	StatusPending   Status = "pending"
	StatusApproved  Status = "approved"
	StatusDenied    Status = "denied"
	StatusExpired   Status = "expired"
	StatusCancelled Status = "cancelled"
)

type CreateInput struct {
	Tool           string         `json:"tool"`
	Server         string         `json:"server,omitempty"`
	Arguments      map[string]any `json:"arguments"`
	Timeout        string         `json:"timeout"`
	AgentReasoning string         `json:"agent_reasoning,omitempty"`
	Context        map[string]any `json:"context,omitempty"`
	IdempotencyKey string         `json:"-"`
}
type Request struct {
	ID             string         `json:"id"`
	Tool           string         `json:"tool"`
	Server         string         `json:"server,omitempty"`
	Arguments      map[string]any `json:"arguments"`
	Timeout        string         `json:"timeout"`
	AgentReasoning string         `json:"agent_reasoning,omitempty"`
	Context        map[string]any `json:"context,omitempty"`
	Status         Status         `json:"status"`
	CreatedAt      string         `json:"created_at"`
	DeadlineAt     string         `json:"deadline_at"`
	Decision       *WireDecision  `json:"decision,omitempty"`
}
type WireDecision struct {
	Status    Status `json:"status"`
	Note      string `json:"note,omitempty"`
	DecidedAt string `json:"decided_at"`
	ExpiresAt string `json:"expires_at,omitempty"`
}
type Decision struct {
	Status    Status
	Note      string
	ExpiresAt time.Time
	Bypassed  bool
}

func (d Decision) Allows() bool {
	return d.Status == StatusApproved && (d.Bypassed || time.Now().Before(d.ExpiresAt))
}

// Decode preserves integer precision in tool arguments and rejects trailing JSON.
func Decode(raw []byte, out any) error {
	if err := uniqueKeys(raw); err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil {
		return err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}
func equalJSON(a, b any) bool {
	if an, ok := a.(json.Number); ok {
		bn, ok := b.(json.Number)
		if !ok {
			return false
		}
		ar, aok := new(big.Rat).SetString(string(an))
		br, bok := new(big.Rat).SetString(string(bn))
		return aok && bok && ar.Cmp(br) == 0
	}
	switch av := a.(type) {
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for k, v := range av {
			w, ok := bv[k]
			if !ok || !equalJSON(v, w) {
				return false
			}
		}
		return true
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for i, v := range av {
			if !equalJSON(v, bv[i]) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(a, b)
	}
}
func validate(r *Request, in CreateInput, previous *Request) error {
	bad := errors.New("invalid AAP response")
	if _, err := uuid.Parse(r.ID); err != nil {
		return bad
	}
	if r.Tool != in.Tool || r.Server != in.Server || r.Arguments == nil || !equalJSON(r.Arguments, in.Arguments) || r.Timeout != in.Timeout || r.AgentReasoning != in.AgentReasoning || !equalJSON(r.Context, in.Context) {
		return bad
	}
	created, e1 := time.Parse(time.RFC3339Nano, r.CreatedAt)
	deadline, e2 := time.Parse(time.RFC3339Nano, r.DeadlineAt)
	if e1 != nil || e2 != nil || !strings.HasSuffix(r.CreatedAt, "Z") || !strings.HasSuffix(r.DeadlineAt, "Z") || !deadline.After(created) {
		return bad
	}
	if previous != nil && (r.ID != previous.ID || r.CreatedAt != previous.CreatedAt || r.DeadlineAt != previous.DeadlineAt) {
		return bad
	}
	if r.Status == StatusPending {
		if r.Decision != nil {
			return bad
		}
		return nil
	}
	switch r.Status {
	case StatusApproved, StatusDenied, StatusExpired, StatusCancelled:
	default:
		return bad
	}
	if r.Decision == nil || r.Decision.Status != r.Status {
		return bad
	}
	decided, err := time.Parse(time.RFC3339Nano, r.Decision.DecidedAt)
	if err != nil || !strings.HasSuffix(r.Decision.DecidedAt, "Z") || decided.Before(created) {
		return bad
	}
	if r.Status == StatusApproved {
		expiry, err := time.Parse(time.RFC3339Nano, r.Decision.ExpiresAt)
		if err != nil || !strings.HasSuffix(r.Decision.ExpiresAt, "Z") || !expiry.After(decided) {
			return bad
		}
	} else if r.Decision.ExpiresAt != "" {
		return bad
	}
	return nil
}

const FailClosedText = "The approval adapter could not obtain a valid AAP decision. The call was not run."

func BoundaryText(d Decision) string {
	switch d.Status {
	case StatusDenied:
		if d.Note != "" {
			return "The provider denied this call: " + d.Note
		}
		return "The provider denied this call."
	case StatusCancelled:
		return "The call was cancelled before execution."
	case StatusExpired:
		return "The approval window or permission to start this call expired. The call was not run."
	default:
		return FailClosedText
	}
}
