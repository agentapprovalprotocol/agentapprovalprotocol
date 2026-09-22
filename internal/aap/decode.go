package aap

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// protocolObject rejects absent required fields, nulls, unknown keys and duplicate
// keys. Extensible context and tool arguments keep arbitrary nested JSON values.
func protocolObject(raw []byte, allowed, required []string) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, errors.New("invalid AAP object")
	}
	fields := map[string]bool{}
	for _, key := range allowed {
		fields[key] = true
	}
	for key, value := range object {
		if !fields[key] || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, errors.New("invalid AAP field")
		}
	}
	for _, key := range required {
		if _, ok := object[key]; !ok {
			return nil, errors.New("missing AAP field")
		}
	}
	return object, nil
}
func decodeRequest(raw []byte) (*Request, error) {
	if err := uniqueKeys(raw); err != nil {
		return nil, err
	}
	object, err := protocolObject(raw, []string{"id", "tool", "server", "arguments", "timeout", "agent_reasoning", "context", "status", "created_at", "deadline_at", "decision"}, []string{"id", "tool", "arguments", "timeout", "status", "created_at", "deadline_at"})
	if err != nil {
		return nil, err
	}
	var r Request
	if err := Decode(raw, &r); err != nil {
		return nil, err
	}
	if decision, ok := object["decision"]; ok {
		if r.Status == StatusPending {
			return nil, errors.New("pending request has a decision")
		}
		fields, err := protocolObject(decision, []string{"status", "note", "decided_at", "expires_at"}, []string{"status", "decided_at"})
		if err != nil {
			return nil, err
		}
		_, expiry := fields["expires_at"]
		if expiry != (r.Status == StatusApproved) {
			return nil, errors.New("invalid approval expiry")
		}
	}
	return &r, nil
}
func uniqueKeys(raw []byte) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		if depth > 100 {
			return errors.New("JSON nesting limit exceeded")
		}
		token, err := dec.Token()
		if err != nil {
			return err
		}
		switch token {
		case json.Delim('{'):
			seen := map[string]bool{}
			for dec.More() {
				key, err := dec.Token()
				if err != nil {
					return err
				}
				s, ok := key.(string)
				if !ok || seen[s] {
					return errors.New("duplicate JSON key")
				}
				seen[s] = true
				if err = value(depth + 1); err != nil {
					return err
				}
			}
			_, err = dec.Token()
			return err
		case json.Delim('['):
			for dec.More() {
				if err = value(depth + 1); err != nil {
					return err
				}
			}
			_, err = dec.Token()
			return err
		}
		return nil
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := dec.Token(); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
