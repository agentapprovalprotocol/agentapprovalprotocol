package aap

import "strings"

// ToolNaming is how a runtime spells a tool when it hands the call to a
// hook. Runtimes that host MCP servers join the server alias and the
// server-defined tool name into one string for the model; the protocol
// records the two apart, so every hook splits that spelling back with
// IdentifyTool before submitting a request.
type ToolNaming int

const (
	// NamingPlain is a runtime without an MCP client. The hook name is
	// the tool.
	NamingPlain ToolNaming = iota
	// NamingMCPPrefixed is mcp__<server>__<tool>: the Claude Code
	// convention, also used by Codex, Hermes and DeepSeek Harness. A name
	// without the marker is a built-in tool.
	NamingMCPPrefixed
	// NamingServerPrefixed is <server>__<tool> with no marker, OpenClaw's
	// convention. A name without a double underscore is a built-in tool.
	NamingServerPrefixed
)

// ToolIdentity is one intercepted call as the protocol records it: the
// name under which the tool is defined and, for an MCP tool, the alias
// of the server that defines it, as the runtime configured it.
type ToolIdentity struct {
	Tool   string
	Server string
}

// IdentifyTool splits a runtime's spelling of a tool name into the
// identity a request carries. The server alias is everything between the
// marker and the first double underscore after it; the tool keeps any
// double underscores of its own. A spelling the rule does not recognise
// is a built-in tool and is submitted verbatim.
func IdentifyTool(name string, naming ToolNaming) ToolIdentity {
	switch naming {
	case NamingMCPPrefixed:
		joined, ok := strings.CutPrefix(name, "mcp__")
		if !ok {
			return ToolIdentity{Tool: name}
		}
		return splitServerPrefixed(joined, name)
	case NamingServerPrefixed:
		return splitServerPrefixed(name, name)
	default:
		return ToolIdentity{Tool: name}
	}
}

func splitServerPrefixed(joined, name string) ToolIdentity {
	server, tool, ok := strings.Cut(joined, "__")
	if !ok || server == "" || tool == "" {
		return ToolIdentity{Tool: name}
	}
	return ToolIdentity{Tool: tool, Server: server}
}
