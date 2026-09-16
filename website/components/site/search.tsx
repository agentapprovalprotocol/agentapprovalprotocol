"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

interface SearchEntry { slug: string; title: string; description: string; text: string }

export function Search() {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<SearchEntry[]>([]);
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState(false);

  const open = () => {
    dialog.current?.showModal();
    input.current?.focus();
    if (!entries.length) fetch("/search-index.json").then((res) => {
      if (!res.ok) throw new Error("Search unavailable");
      return res.json();
    }).then(setEntries).catch(() => setFailed(true));
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (dialog.current?.open) dialog.current.close(); else open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const results = entries.filter((entry) => terms.every((term) => `${entry.title} ${entry.description} ${entry.text}`.toLowerCase().includes(term)))
    .sort((a, b) => Number(b.title.toLowerCase().includes(query.toLowerCase())) - Number(a.title.toLowerCase().includes(query.toLowerCase()))).slice(0, 8);

  return <>
    <button type="button" onClick={open} className="search-trigger" aria-label="Search documentation"><span>Search docs</span><kbd>⌘ K</kbd></button>
    <dialog ref={dialog} className="search-dialog" aria-label="Search documentation" onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="search-input-row"><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the specification…" aria-label="Search query" /><button onClick={() => dialog.current?.close()} aria-label="Close search">Esc</button></div>
      <div className="search-results">
        {failed && <p>Search could not load. Use the documentation sidebar to find a page.</p>}
        {!failed && !results.length && <p>{entries.length ? "No matching pages." : "Loading documentation…"}</p>}
        {results.map((entry) => <Link key={entry.slug} href={`/docs/${entry.slug}`} onClick={() => dialog.current?.close()}><strong>{entry.title}</strong><span>{entry.description}</span></Link>)}
      </div>
    </dialog>
  </>;
}
