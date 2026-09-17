package runtimes

import (
	"bytes"
	"fmt"
	"strconv"

	"gopkg.in/yaml.v3"
)

// loadYAMLMapping decodes a YAML document into a node tree whose root is
// a mapping, so edits keep the person's comments and key order. A missing
// or empty file is an empty mapping.
func loadYAMLMapping(content []byte, existed bool) (*yaml.Node, error) {
	if !existed || len(bytes.TrimSpace(content)) == 0 {
		return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}, nil
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(content, &doc); err != nil {
		return nil, fmt.Errorf("parse yaml: %w", err)
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 {
		return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}, nil
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("parse yaml: root is not a mapping")
	}
	return root, nil
}

// loadYAMLSequence decodes a YAML document whose root is a sequence (the
// dsh Cordis patch). A missing or empty file is an empty sequence.
func loadYAMLSequence(content []byte, existed bool) (*yaml.Node, error) {
	if !existed || len(bytes.TrimSpace(content)) == 0 {
		return &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}, nil
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(content, &doc); err != nil {
		return nil, fmt.Errorf("parse yaml: %w", err)
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 {
		return &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}, nil
	}
	root := doc.Content[0]
	if root.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("parse yaml: root is not a sequence")
	}
	return root, nil
}

// formatYAML renders a root node with two-space indentation.
func formatYAML(root *yaml.Node) ([]byte, error) {
	var buf bytes.Buffer
	encoder := yaml.NewEncoder(&buf)
	encoder.SetIndent(2)
	if err := encoder.Encode(root); err != nil {
		return nil, err
	}
	if err := encoder.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// yamlGet returns the value node for key in a mapping.
func yamlGet(mapping *yaml.Node, key string) *yaml.Node {
	if mapping == nil || mapping.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			return mapping.Content[i+1]
		}
	}
	return nil
}

// yamlEnsure returns the value node for key, creating a node of kind at
// the end of the mapping when absent. A present node of another kind is
// replaced.
func yamlEnsure(mapping *yaml.Node, key string, kind yaml.Kind) *yaml.Node {
	tag := map[yaml.Kind]string{yaml.MappingNode: "!!map", yaml.SequenceNode: "!!seq", yaml.ScalarNode: "!!str"}[kind]
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			if mapping.Content[i+1].Kind != kind {
				mapping.Content[i+1] = &yaml.Node{Kind: kind, Tag: tag}
			}
			return mapping.Content[i+1]
		}
	}
	value := &yaml.Node{Kind: kind, Tag: tag}
	mapping.Content = append(mapping.Content, yamlScalar(key), value)
	return value
}

// yamlSetInt sets an integer scalar under key.
func yamlSetInt(mapping *yaml.Node, key string, value int) {
	node := yamlEnsure(mapping, key, yaml.ScalarNode)
	node.Tag = "!!int"
	node.Value = strconv.Itoa(value)
	node.Style = 0
}

// yamlInt reads an integer scalar, or 0.
func yamlInt(node *yaml.Node) int {
	if node == nil || node.Kind != yaml.ScalarNode {
		return 0
	}
	value, _ := strconv.Atoi(node.Value)
	return value
}

// yamlScalar builds a plain string scalar.
func yamlScalar(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}

// yamlMapping builds a mapping from key/value pairs in order.
func yamlMapping(pairs ...*yaml.Node) *yaml.Node {
	return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: pairs}
}

// yamlBool builds a boolean scalar.
func yamlBool(value bool) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(value)}
}

// yamlIntNode builds an integer scalar.
func yamlIntNode(value int) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(value)}
}

// yamlString reads a string scalar under key, or "".
func yamlString(mapping *yaml.Node, key string) string {
	node := yamlGet(mapping, key)
	if node == nil || node.Kind != yaml.ScalarNode {
		return ""
	}
	return node.Value
}

// yamlStrings reads a sequence of scalars under key.
func yamlStrings(mapping *yaml.Node, key string) []string {
	node := yamlGet(mapping, key)
	if node == nil || node.Kind != yaml.SequenceNode {
		return nil
	}
	out := make([]string, 0, len(node.Content))
	for _, item := range node.Content {
		if item.Kind == yaml.ScalarNode {
			out = append(out, item.Value)
		}
	}
	return out
}

// yamlStringMap reads a mapping of scalars under key.
func yamlStringMap(mapping *yaml.Node, key string) map[string]string {
	node := yamlGet(mapping, key)
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	out := map[string]string{}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i+1].Kind == yaml.ScalarNode {
			out[node.Content[i].Value] = node.Content[i+1].Value
		}
	}
	return out
}

// yamlDeleteKey removes key from a mapping.
func yamlDeleteKey(mapping *yaml.Node, key string) {
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			mapping.Content = append(mapping.Content[:i], mapping.Content[i+2:]...)
			return
		}
	}
}
