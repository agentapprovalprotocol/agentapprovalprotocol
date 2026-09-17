package runtimes

import (
	"encoding/json"
	"strconv"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

// hookTimeoutSeconds is the per-hook ceiling written into Claude Code
// style hook registrations: the approval window plus room to answer.
const hookTimeoutSeconds = 7*24*60*60 + 60

// claudeHookEntry builds the PreToolUse entry Claude Code (and the dsh
// bridge, which reads the same shape) runs for our hook.
func claudeHookEntry(command, matcher string) *jsonObject {
	hook := newJSONObject()
	hook.Set("type", "command")
	hook.Set("command", command)
	hook.Set("timeout", json.Number(strconv.Itoa(hookTimeoutSeconds)))
	entry := newJSONObject()
	if matcher != "" {
		entry.Set("matcher", matcher)
	}
	entry.Set("hooks", []jsonValue{hook})
	return entry
}

// findClaudeHook locates our entry in a hooks.PreToolUse array: the entry
// index and, within it, the hook index whose command is ours.
func findClaudeHook(entries []jsonValue, key catalog.Key) (entryIndex, hookIndex int) {
	for i, item := range entries {
		entry, ok := item.(*jsonObject)
		if !ok {
			continue
		}
		hooks, _ := entry.Array("hooks")
		for j, h := range hooks {
			hook, ok := h.(*jsonObject)
			if ok && isOurHookCommand(hook.String("command"), key) {
				return i, j
			}
		}
	}
	return -1, -1
}

// claudeHookInstalled reports whether root carries our hook naming the
// given command exactly.
func claudeHookInstalled(root *jsonObject, key catalog.Key, command string) bool {
	hooks, ok := root.ObjectIfPresent("hooks")
	if !ok {
		return false
	}
	entries, ok := hooks.Array("PreToolUse")
	if !ok {
		return false
	}
	i, j := findClaudeHook(entries, key)
	if i < 0 {
		return false
	}
	hooksArray, _ := entries[i].(*jsonObject).Array("hooks")
	return hooksArray[j].(*jsonObject).String("command") == command
}

// upsertClaudeHook installs or refreshes our PreToolUse entry. An existing
// entry keeps its place in the array; only its matcher and our hook's
// command and timeout are rewritten, so other hooks a person added to the
// same entry survive.
func upsertClaudeHook(root *jsonObject, key catalog.Key, command, matcher string) {
	hooks := root.Object("hooks")
	entries, _ := hooks.Array("PreToolUse")
	i, j := findClaudeHook(entries, key)
	if i < 0 {
		hooks.Set("PreToolUse", append(entries, claudeHookEntry(command, matcher)))
		return
	}
	entry := entries[i].(*jsonObject)
	if matcher != "" {
		entry.Set("matcher", matcher)
	} else {
		entry.Delete("matcher")
	}
	hooksArray, _ := entry.Array("hooks")
	hook := hooksArray[j].(*jsonObject)
	hook.Set("type", "command")
	hook.Set("command", command)
	hook.Set("timeout", json.Number(strconv.Itoa(hookTimeoutSeconds)))
	hooks.Set("PreToolUse", entries)
}

// stripClaudeHook removes our hook from root. An entry left with no hooks
// goes too, and so do the hooks.PreToolUse and hooks containers when they
// end up empty, so the file returns to what it was before us.
func stripClaudeHook(root *jsonObject, key catalog.Key) bool {
	hooks, ok := root.ObjectIfPresent("hooks")
	if !ok {
		return false
	}
	entries, ok := hooks.Array("PreToolUse")
	if !ok {
		return false
	}
	changed := false
	kept := make([]jsonValue, 0, len(entries))
	for _, item := range entries {
		entry, ok := item.(*jsonObject)
		if !ok {
			kept = append(kept, item)
			continue
		}
		hooksArray, _ := entry.Array("hooks")
		remaining := make([]jsonValue, 0, len(hooksArray))
		for _, h := range hooksArray {
			if hook, ok := h.(*jsonObject); ok && isOurHookCommand(hook.String("command"), key) {
				changed = true
				continue
			}
			remaining = append(remaining, h)
		}
		if len(remaining) == 0 && len(hooksArray) > 0 {
			continue
		}
		entry.Set("hooks", remaining)
		kept = append(kept, entry)
	}
	if !changed {
		return false
	}
	if len(kept) == 0 {
		hooks.Delete("PreToolUse")
	} else {
		hooks.Set("PreToolUse", kept)
	}
	if hooks.Len() == 0 {
		root.Delete("hooks")
	}
	return true
}

// stripClaudeHookFile is the stripFunc for a Claude Code style JSON file.
func stripClaudeHookFile(key catalog.Key) stripFunc {
	return func(_ string, content []byte) ([]byte, bool, error) {
		doc, err := loadJSONObject(content, true)
		if err != nil {
			return nil, false, err
		}
		if !stripClaudeHook(doc.Root, key) {
			return nil, false, nil
		}
		return doc.Bytes(), true, nil
	}
}
