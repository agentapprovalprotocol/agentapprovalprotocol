package runtimes

import (
	"testing"
)

func TestJSONRoundTripPreservesOrderAndIndent(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "two space indent and key order",
			input: "{\n  \"z\": 1,\n  \"a\": {\n    \"nested\": [1, \"two\", true, null]\n  },\n  \"m\": \"x&y<z>\"\n}\n",
			want:  "{\n  \"z\": 1,\n  \"a\": {\n    \"nested\": [\n      1,\n      \"two\",\n      true,\n      null\n    ]\n  },\n  \"m\": \"x&y<z>\"\n}\n",
		},
		{
			name:  "four space indent is kept",
			input: "{\n    \"a\": {},\n    \"b\": []\n}",
			want:  "{\n    \"a\": {},\n    \"b\": []\n}\n",
		},
		{
			name:  "large numbers survive",
			input: "{\"n\": 12345678901234567890, \"f\": 1.50}",
			want:  "{\n  \"n\": 12345678901234567890,\n  \"f\": 1.50\n}\n",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doc, err := loadJSONObject([]byte(tt.input), true)
			if err != nil {
				t.Fatal(err)
			}
			if got := string(doc.Bytes()); got != tt.want {
				t.Fatalf("got\n%s\nwant\n%s", got, tt.want)
			}
		})
	}
}

func TestJSONObjectSetKeepsPosition(t *testing.T) {
	doc, err := loadJSONObject([]byte(`{"a":1,"b":2,"c":3}`), true)
	if err != nil {
		t.Fatal(err)
	}
	doc.Root.Set("b", "changed")
	doc.Root.Set("d", 4)
	doc.Root.Delete("a")
	want := "{\n  \"b\": \"changed\",\n  \"c\": 3,\n  \"d\": 4\n}\n"
	if got := string(doc.Bytes()); got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestJSONRejectsJSON5(t *testing.T) {
	if _, err := loadJSONObject([]byte("// comment\n{ a: 1 }"), true); err == nil {
		t.Fatal("JSON5 should not parse as strict JSON")
	}
	if _, err := loadJSONObject([]byte(`[1, 2]`), true); err == nil {
		t.Fatal("an array root should be rejected")
	}
}
