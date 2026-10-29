package runtimes

import (
	"encoding/json"
	"strconv"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/catalog"
)

// hookTimeoutSeconds is the per-hook ceiling written into Claude Code
// style hook registrations: the approval window plus room to answer.
const hookTimeoutSeconds = 7*24*60*60 + 60

// hookEvent is one Claude Code style registration: the array under the
// settings file's hooks object that holds our entry, and the timeout the
// entry carries in the runtime's unit.
type hookEvent struct {
	name    string
	timeout json.Number
}

// claudePreToolUse is Claude Code's registration, which the dsh bridge
// reads too. geminiBeforeTool is Gemini CLI's, timed in milliseconds.
var (
	claudePreToolUse = hookEvent{"PreToolUse", json.Number(strconv.Itoa(hookTimeoutSeconds))}
	geminiBeforeTool = hookEvent{"BeforeTool", json.Number(strconv.Itoa(hookTimeoutSeconds * 1000))}
)

// entry builds the entry the runtime runs for our hook.
func (e hookEvent) entry(command, matcher string) *jsonObject {
	hook := newJSONObject()
	hook.Set("type", "command")
	hook.Set("command", command)
	hook.Set("timeout", e.timeout)
	entry := newJSONObject()
	if matcher != "" {
		entry.Set("matcher", matcher)
	}
	entry.Set("hooks", []jsonValue{hook})
	return entry
}

// findClaudeHook locates our entry in a hooks.<event> array: the entry
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

// installed reports whether root carries our hook naming the given
// command exactly.
func (e hookEvent) installed(root *jsonObject, key catalog.Key, command string) bool {
	hooks, ok := root.ObjectIfPresent("hooks")
	return ok && e.installedIn(hooks, key, command)
}

// installedIn is installed for the object that holds the event arrays.
func (e hookEvent) installedIn(hooks *jsonObject, key catalog.Key, command string) bool {
	entries, ok := hooks.Array(e.name)
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

// upsert installs or refreshes our entry. An existing entry keeps its
// place in the array; only its matcher and our hook's command and timeout
// are rewritten, so other hooks a person added to the same entry survive.
func (e hookEvent) upsert(root *jsonObject, key catalog.Key, command, matcher string) {
	hooks := root.Object("hooks")
	entries, _ := hooks.Array(e.name)
	i, j := findClaudeHook(entries, key)
	if i < 0 {
		hooks.Set(e.name, append(entries, e.entry(command, matcher)))
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
	hook.Set("timeout", e.timeout)
	hooks.Set(e.name, entries)
}

// strip removes our hook from root. An entry left with no hooks goes too,
// and so do the hooks.<event> and hooks containers when they end up
// empty, so the file returns to what it was before us.
func (e hookEvent) strip(root *jsonObject, key catalog.Key) bool {
	hooks, ok := root.ObjectIfPresent("hooks")
	if !ok || !e.stripIn(hooks, key) {
		return false
	}
	if hooks.Len() == 0 {
		root.Delete("hooks")
	}
	return true
}

// stripIn is strip for the object that holds the event arrays, which it
// leaves in place however empty.
func (e hookEvent) stripIn(hooks *jsonObject, key catalog.Key) bool {
	entries, ok := hooks.Array(e.name)
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
		hooks.Delete(e.name)
	} else {
		hooks.Set(e.name, kept)
	}
	return true
}

// stripFile is the stripFunc for a Claude Code style JSON file.
func (e hookEvent) stripFile(key catalog.Key) stripFunc {
	return func(_ string, content []byte) ([]byte, bool, error) {
		doc, err := loadJSONObject(content, true)
		if err != nil {
			return nil, false, err
		}
		if !e.strip(doc.Root, key) {
			return nil, false, nil
		}
		return doc.Bytes(), true, nil
	}
}
