package runtimes

import (
	"bytes"
	"fmt"

	toml "github.com/pelletier/go-toml/v2"
)

// tomlNote is the caveat every TOML edit carries: go-toml rewrites the
// document from its parsed form, so comments and blank lines are lost.
const tomlNote = "config.toml was rewritten from its parsed form: comments and formatting were not preserved (a backup was kept)."

// loadTOML decodes a TOML document into nested maps. A missing or empty
// file is an empty table.
func loadTOML(content []byte, existed bool) (map[string]any, error) {
	table := map[string]any{}
	if !existed || len(bytes.TrimSpace(content)) == 0 {
		return table, nil
	}
	if err := toml.Unmarshal(content, &table); err != nil {
		return nil, fmt.Errorf("parse toml: %w", err)
	}
	return table, nil
}

// formatTOML renders nested maps back to TOML.
func formatTOML(table map[string]any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := toml.NewEncoder(&buf)
	encoder.SetIndentTables(false)
	if err := encoder.Encode(table); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// tomlTable returns a nested table, creating it when absent.
func tomlTable(parent map[string]any, key string) map[string]any {
	if child, ok := parent[key].(map[string]any); ok {
		return child
	}
	child := map[string]any{}
	parent[key] = child
	return child
}

// tomlTableIfPresent returns a nested table without creating it.
func tomlTableIfPresent(parent map[string]any, key string) (map[string]any, bool) {
	child, ok := parent[key].(map[string]any)
	return child, ok
}

// tomlTables returns an array of tables as a slice of maps, tolerating
// the []any go-toml produces on decode and the []map[string]any adapters
// build.
func tomlTables(value any) []map[string]any {
	switch v := value.(type) {
	case []map[string]any:
		return v
	case []any:
		out := make([]map[string]any, 0, len(v))
		for _, item := range v {
			if table, ok := item.(map[string]any); ok {
				out = append(out, table)
			}
		}
		return out
	default:
		return nil
	}
}

// tomlString reads a string member.
func tomlString(table map[string]any, key string) string {
	value, _ := table[key].(string)
	return value
}

// tomlStrings reads an array of strings.
func tomlStrings(value any) []string {
	switch v := value.(type) {
	case []string:
		return v
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

// tomlStringMap reads a table of strings.
func tomlStringMap(value any) map[string]string {
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
