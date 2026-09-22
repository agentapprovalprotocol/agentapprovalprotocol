package aap

import "testing"

func TestIdentifyTool(t *testing.T) {
	for _, tc := range []struct {
		name   string
		naming ToolNaming
		want   ToolIdentity
	}{
		{"mcp__stripe__create_refund", NamingMCPPrefixed, ToolIdentity{Tool: "create_refund", Server: "stripe"}},
		{"mcp__mcp_server_linkedin__search_people", NamingMCPPrefixed, ToolIdentity{Tool: "search_people", Server: "mcp_server_linkedin"}},
		{"mcp__codex_apps__gmail__send_email", NamingMCPPrefixed, ToolIdentity{Tool: "gmail__send_email", Server: "codex_apps"}},
		{"Bash", NamingMCPPrefixed, ToolIdentity{Tool: "Bash"}},
		{"stripe__create_refund", NamingMCPPrefixed, ToolIdentity{Tool: "stripe__create_refund"}},
		{"mcp__stripe__", NamingMCPPrefixed, ToolIdentity{Tool: "mcp__stripe__"}},
		{"mcp____create_refund", NamingMCPPrefixed, ToolIdentity{Tool: "mcp____create_refund"}},
		{"stripe__create_refund", NamingServerPrefixed, ToolIdentity{Tool: "create_refund", Server: "stripe"}},
		{"exec", NamingServerPrefixed, ToolIdentity{Tool: "exec"}},
		{"mcp__stripe__create_refund", NamingPlain, ToolIdentity{Tool: "mcp__stripe__create_refund"}},
		{"read", NamingPlain, ToolIdentity{Tool: "read"}},
	} {
		if got := IdentifyTool(tc.name, tc.naming); got != tc.want {
			t.Errorf("IdentifyTool(%q, %d) = %+v, want %+v", tc.name, tc.naming, got, tc.want)
		}
	}
}
