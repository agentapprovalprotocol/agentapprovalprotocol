package runtimes

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
)

// jsonValue is one parsed JSON value: *jsonObject, []jsonValue, string,
// json.Number, bool, or nil. Objects keep their key order so a
// read-modify-write leaves a person's file looking the way they left it.
type jsonValue = any

// jsonObject is an insertion-ordered JSON object.
type jsonObject struct {
	keys   []string
	values map[string]jsonValue
}

func newJSONObject() *jsonObject { return &jsonObject{values: map[string]jsonValue{}} }

// Get returns a member.
func (o *jsonObject) Get(key string) (jsonValue, bool) {
	value, ok := o.values[key]
	return value, ok
}

// Set adds or replaces a member, keeping an existing key's position.
func (o *jsonObject) Set(key string, value jsonValue) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// Delete removes a member.
func (o *jsonObject) Delete(key string) {
	if _, ok := o.values[key]; !ok {
		return
	}
	delete(o.values, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

// Keys returns the member names in order.
func (o *jsonObject) Keys() []string { return append([]string(nil), o.keys...) }

// Len reports the member count.
func (o *jsonObject) Len() int { return len(o.keys) }

// Object returns the member as an object, creating it when absent. A
// member of another type is replaced, which is the only sane reading of
// "plugins.load.paths" when "load" was a string.
func (o *jsonObject) Object(key string) *jsonObject {
	if child, ok := o.values[key].(*jsonObject); ok {
		return child
	}
	child := newJSONObject()
	o.Set(key, child)
	return child
}

// ObjectIfPresent returns the member as an object without creating it.
func (o *jsonObject) ObjectIfPresent(key string) (*jsonObject, bool) {
	child, ok := o.values[key].(*jsonObject)
	return child, ok
}

// Array returns the member as an array (nil when absent or another type).
func (o *jsonObject) Array(key string) ([]jsonValue, bool) {
	array, ok := o.values[key].([]jsonValue)
	return array, ok
}

// String returns a string member.
func (o *jsonObject) String(key string) string {
	value, _ := o.values[key].(string)
	return value
}

// parseJSON decodes document into an ordered value tree.
func parseJSON(document []byte) (jsonValue, error) {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	value, err := parseJSONValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("trailing data after the JSON document")
	}
	return value, nil
}

func parseJSONValue(decoder *json.Decoder) (jsonValue, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	return parseJSONFrom(decoder, token)
}

func parseJSONFrom(decoder *json.Decoder, token json.Token) (jsonValue, error) {
	switch t := token.(type) {
	case json.Delim:
		switch t {
		case '{':
			object := newJSONObject()
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("object key %v is not a string", keyToken)
				}
				value, err := parseJSONValue(decoder)
				if err != nil {
					return nil, err
				}
				object.Set(key, value)
			}
			if _, err := decoder.Token(); err != nil { // consume '}'
				return nil, err
			}
			return object, nil
		case '[':
			array := []jsonValue{}
			for decoder.More() {
				value, err := parseJSONValue(decoder)
				if err != nil {
					return nil, err
				}
				array = append(array, value)
			}
			if _, err := decoder.Token(); err != nil { // consume ']'
				return nil, err
			}
			return array, nil
		}
		return nil, fmt.Errorf("unexpected delimiter %v", t)
	default:
		return t, nil // string, json.Number, bool, nil
	}
}

// formatJSON renders a value tree with the given indent and a trailing
// newline, in the layout encoding/json uses for indented output.
func formatJSON(value jsonValue, indent string) []byte {
	var buf bytes.Buffer
	writeJSON(&buf, value, indent, 0)
	buf.WriteByte('\n')
	return buf.Bytes()
}

func writeJSON(buf *bytes.Buffer, value jsonValue, indent string, depth int) {
	switch v := value.(type) {
	case *jsonObject:
		if v.Len() == 0 {
			buf.WriteString("{}")
			return
		}
		buf.WriteString("{\n")
		for i, key := range v.keys {
			buf.WriteString(strings.Repeat(indent, depth+1))
			writeJSONString(buf, key)
			buf.WriteString(": ")
			writeJSON(buf, v.values[key], indent, depth+1)
			if i < len(v.keys)-1 {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(strings.Repeat(indent, depth))
		buf.WriteByte('}')
	case []jsonValue:
		if len(v) == 0 {
			buf.WriteString("[]")
			return
		}
		buf.WriteString("[\n")
		for i, item := range v {
			buf.WriteString(strings.Repeat(indent, depth+1))
			writeJSON(buf, item, indent, depth+1)
			if i < len(v)-1 {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(strings.Repeat(indent, depth))
		buf.WriteByte(']')
	case string:
		writeJSONString(buf, v)
	case json.Number:
		buf.WriteString(v.String())
	case bool:
		if v {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case nil:
		buf.WriteString("null")
	default:
		// Values built by adapters (ints, plain maps) go through the
		// standard encoder.
		raw, err := json.Marshal(v)
		if err != nil {
			buf.WriteString("null")
			return
		}
		buf.Write(raw)
	}
}

// writeJSONString escapes like JSON.stringify, without HTML escaping, so
// a path containing "&" survives a round trip unchanged.
func writeJSONString(buf *bytes.Buffer, s string) {
	encoder := json.NewEncoder(buf)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(s)
	buf.Truncate(buf.Len() - 1) // Encode appends a newline
}

// jsonDocument is a JSON file open for a read-modify-write.
type jsonDocument struct {
	Root    *jsonObject
	Existed bool
	indent  string
}

// errNotStrictJSON marks a file that exists but is not strict JSON (a
// JSON5 OpenClaw config, say), which the adapter turns into a manual step.
var errNotStrictJSON = errors.New("file is not strict JSON")

// loadJSONObject reads a JSON file whose root is an object. A missing file
// yields an empty document that Save creates.
func loadJSONObject(content []byte, existed bool) (*jsonDocument, error) {
	doc := &jsonDocument{Root: newJSONObject(), Existed: existed, indent: "  "}
	if !existed || len(bytes.TrimSpace(content)) == 0 {
		return doc, nil
	}
	value, err := parseJSON(content)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errNotStrictJSON, err)
	}
	root, ok := value.(*jsonObject)
	if !ok {
		return nil, fmt.Errorf("%w: root is not an object", errNotStrictJSON)
	}
	doc.Root = root
	doc.indent = detectIndent(content)
	return doc, nil
}

// Bytes renders the document.
func (d *jsonDocument) Bytes() []byte { return formatJSON(d.Root, d.indent) }

// detectIndent reads the indentation of the first indented line and falls
// back to two spaces.
func detectIndent(content []byte) string {
	for _, line := range bytes.Split(content, []byte("\n")) {
		trimmed := bytes.TrimLeft(line, " \t")
		if len(trimmed) == len(line) || len(trimmed) == 0 {
			continue
		}
		prefix := line[:len(line)-len(trimmed)]
		if prefix[0] == '\t' {
			return "\t"
		}
		return string(prefix)
	}
	return "  "
}

// readFile returns a file's content and whether it existed.
func readFile(path string) ([]byte, bool, error) {
	content, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return content, true, nil
}
