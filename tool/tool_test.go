package tool

import "testing"

func TestIdentify(t *testing.T) {
	for _, tc := range []struct {
		name   string
		naming Naming
		want   Identity
	}{
		{"mcp__stripe__create_refund", NamingMCPPrefixed, Identity{Tool: "create_refund", Server: "stripe"}},
		{"mcp__mcp_server_linkedin__search_people", NamingMCPPrefixed, Identity{Tool: "search_people", Server: "mcp_server_linkedin"}},
		{"mcp__codex_apps__gmail__send_email", NamingMCPPrefixed, Identity{Tool: "gmail__send_email", Server: "codex_apps"}},
		{"Bash", NamingMCPPrefixed, Identity{Tool: "Bash"}},
		{"stripe__create_refund", NamingMCPPrefixed, Identity{Tool: "stripe__create_refund"}},
		{"mcp__stripe__", NamingMCPPrefixed, Identity{Tool: "mcp__stripe__"}},
		{"mcp____create_refund", NamingMCPPrefixed, Identity{Tool: "mcp____create_refund"}},
		{"stripe__create_refund", NamingServerPrefixed, Identity{Tool: "create_refund", Server: "stripe"}},
		{"exec", NamingServerPrefixed, Identity{Tool: "exec"}},
		{"mcp__stripe__create_refund", NamingPlain, Identity{Tool: "mcp__stripe__create_refund"}},
		{"read", NamingPlain, Identity{Tool: "read"}},
	} {
		if got := Identify(tc.name, tc.naming); got != tc.want {
			t.Errorf("Identify(%q, %d) = %+v, want %+v", tc.name, tc.naming, got, tc.want)
		}
	}
}
