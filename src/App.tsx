import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  deleteDoc,
  fetchMyProfile,
  listDocs,
  loadDoc,
  restoreDoc,
  saveDoc,
  supabase,
  type Doc,
  type DocSummary,
  type Mode,
  type Profile,
} from "./supabase";

const DEBOUNCE_MS = 1000;
type Status = "idle" | "dirty" | "saving" | "saved" | "error" | "offline";

const newDoc = (id: string): Doc => ({
  id,
  title: "Namnlöst",
  content_html: "",
  content_text: "",
  mode: "plain",
  tag: null,
});

const timeAgo = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "Nyss";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} tim`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d`;
  return new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
};

const textToHtml = (t: string) =>
  t
    .split("\n")
    .map((l) => `<p>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`)
    .join("");

/** Namn från innehållet: första raden med text, högst ca 50 tecken. */
const titleFromText = (t: string) => {
  const line = t.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  if (line.length <= 50) return line || "Namnlöst";
  const cut = line.slice(0, 50);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 50)}…`;
};

/** Minnas filhandtag (File System Access API) per dokument-id under sessionen, så "spara" kan skriva tillbaka utan att fråga igen. */
const fileHandles = new Map<string, FileSystemFileHandle>();

async function saveTextToFile(docId: string, title: string, text: string): Promise<"handle" | "download"> {
  const w = window as unknown as {
    showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
  };
  const existing = fileHandles.get(docId);
  if (existing) {
    const writable = await existing.createWritable();
    await writable.write(text);
    await writable.close();
    return "handle";
  }
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: `${title || "Namnlöst"}.txt`,
        types: [{ description: "Textfil", accept: { "text/plain": [".txt"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      fileHandles.set(docId, handle);
      return "handle";
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      // API tillgängligt men misslyckades (t.ex. iPadOS-begränsning) – fall tillbaka på nedladdning.
    }
  }
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title || "Namnlöst"}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return "download";
}

/**
 * Dator (File System Access API finns) -> riktig "Spara som"-dialog där man väljer mapp.
 * Dator utan sådan dialog -> nedladdning (webbläsaren frågar var filen ska sparas om det är påslaget).
 * Mobil (ingen sådan dialog i webbläsaren) -> delningsmenyn ger t.ex. "Spara i Drive" / "Spara i Filer".
 */
async function saveOrShareText(docId: string, title: string, text: string): Promise<"shared" | "handle" | "download"> {
  const w = window as unknown as { showSaveFilePicker?: unknown };
  if (fileHandles.has(docId) || w.showSaveFilePicker) {
    return saveTextToFile(docId, title, text);
  }
  // Dator utan spara-dialog (t.ex. Brave, Safari) -> vanlig nedladdning, inte Apples delningsmeny.
  if (!window.matchMedia("(pointer: coarse)").matches) {
    return saveTextToFile(docId, title, text);
  }
  const filename = `${title || "Namnlöst"}.txt`;
  const nav = navigator as Navigator & { canShare?: (data?: { files?: File[] }) => boolean };
  if (nav.canShare) {
    const file = new File([text], filename, { type: "text/plain" });
    if (nav.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return "shared";
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        // delning misslyckades av annan anledning – fall tillbaka på fil-sparning
      }
    }
  }
  return saveTextToFile(docId, title, text);
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(supabase ? undefined : null);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setProfile(session === null ? null : undefined);
      return;
    }
    setProfile(undefined);
    fetchMyProfile(session.user.id)
      .then(setProfile)
      .catch(() => setProfile(null));
  }, [session]);

  if (session === undefined || (session && profile === undefined)) {
    return <div className="auth-loading">Laddar…</div>;
  }
  if (!session) return <SignIn />;
  if (!profile?.approved) return <PendingApproval />;
  return <Shell />;
}

function SignIn() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      if (mode === "up") {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) setNotice("Konto skapat. Kolla din mejl för att bekräfta kontot.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>.txt</h1>
        <input
          type="email"
          required
          autoComplete="email"
          placeholder="E-post"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          required
          minLength={6}
          autoComplete={mode === "up" ? "new-password" : "current-password"}
          placeholder="Lösenord"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="auth-error">{error}</p>}
        {notice && <p className="auth-notice">{notice}</p>}
        <button type="submit" disabled={loading}>
          {loading ? "Ett ögonblick…" : mode === "up" ? "Skapa konto" : "Logga in"}
        </button>
        <button type="button" className="auth-switch" onClick={() => setMode((m) => (m === "up" ? "in" : "up"))}>
          {mode === "up" ? "Har du redan ett konto? Logga in" : "Inget konto än? Skapa ett"}
        </button>
      </form>
    </div>
  );
}

function PendingApproval() {
  return (
    <div className="auth">
      <div className="auth-card">
        <h1>Väntar på godkännande</h1>
        <p>Kontot är skapat men måste godkännas innan du kan använda appen.</p>
        <button type="button" onClick={() => void supabase?.auth.signOut()}>
          Logga ut
        </button>
      </div>
    </div>
  );
}

function Shell() {
  const [docs, setDocs] = useState<DocSummary[] | undefined>(undefined);
  const [activeId, setActiveId] = useState<string>(() => crypto.randomUUID());
  const [showList, setShowList] = useState(false);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const docsRef = useRef<DocSummary[] | undefined>(undefined);
  useEffect(() => {
    docsRef.current = docs;
  }, [docs]);

  useEffect(() => {
    if (!supabase) {
      setDocs([]);
      return;
    }
    listDocs()
      .then(setDocs)
      .catch(() => setDocs([]));
  }, []);

  const importNote = useCallback(async (text: string, name: string, handle?: FileSystemFileHandle) => {
    if (!supabase) return;
    const title = name.replace(/\.txt$/i, "") || "Namnlöst";
    // Samma filnamn delat igen -> uppdatera den anteckningen istället för att skapa en till kopia.
    const existing = docsRef.current?.find((d) => d.title === title);
    const id = existing?.id ?? crypto.randomUUID();
    const tag = existing?.tag ?? null;
    const full: Doc = { id, title, content_html: textToHtml(text), content_text: text, mode: "plain", tag };
    await saveDoc(full);
    if (handle) fileHandles.set(id, handle);
    setDocs((prev) => [
      { id, title, content_text: text, mode: "plain", tag, updated_at: new Date().toISOString() },
      ...(prev ?? []).filter((d) => d.id !== id),
    ]);
    setActiveId(id);
    setShowList(false);
  }, []);

  // Android: fil öppnad via "Öppna med" (file_handlers).
  useEffect(() => {
    const w = window as unknown as {
      launchQueue?: { setConsumer: (cb: (p: { files: FileSystemFileHandle[] }) => void) => void };
    };
    w.launchQueue?.setConsumer(async (launchParams) => {
      for (const handle of launchParams.files) {
        try {
          const file = await handle.getFile();
          await importNote(await file.text(), file.name, handle);
        } catch {
          // ignorera filer som inte kunde läsas
        }
      }
    });
  }, [importNote]);

  // Android: fil delad via delningsmenyn (share_target, hanterad av service workern).
  useEffect(() => {
    if (new URLSearchParams(location.search).get("shared") !== "1") return;
    window.history.replaceState(null, "", location.pathname);
    (async () => {
      try {
        const cache = await caches.open("textedit-share");
        const res = await cache.match("/__shared-file");
        if (!res) return;
        const name = res.headers.get("X-File-Name") || "Delad text.txt";
        const text = await res.text();
        await cache.delete("/__shared-file");
        await importNote(text, name);
      } catch {
        // tyst fel – delningen misslyckades, inget att visa
      }
    })();
  }, [importNote]);

  const onNew = () => {
    setActiveId(crypto.randomUUID());
    setShowList(false);
  };

  const onSelect = (id: string) => {
    setActiveId(id);
    setShowList(false);
  };

  const onSaved = useCallback((summary: DocSummary) => {
    setDocs((prev) => [summary, ...(prev ?? []).filter((d) => d.id !== summary.id)]);
  }, []);

  const onEmptied = useCallback((id: string) => {
    setDocs((prev) => (prev ?? []).filter((d) => d.id !== id));
  }, []);

  // Senast slängda anteckningen, så den kan läggas tillbaka med "Ångra" en kort stund.
  const [trashed, setTrashed] = useState<{ doc: Doc; summary: DocSummary } | null>(null);
  const undoTimer = useRef<number | undefined>(undefined);

  const onDelete = useCallback(
    async (id: string) => {
      const summary = docsRef.current?.find((d) => d.id === id);
      const full = summary ? await loadDoc(id).catch(() => null) : null;
      fileHandles.delete(id);
      await deleteDoc(id);
      setDocs((prev) => (prev ?? []).filter((d) => d.id !== id));
      if (id === activeId) {
        setActiveId(crypto.randomUUID());
        setShowList(false);
      }
      if (full && summary) {
        setTrashed({ doc: full, summary });
        window.clearTimeout(undoTimer.current);
        undoTimer.current = window.setTimeout(() => setTrashed(null), 6000);
      }
    },
    [activeId],
  );

  const onUndo = async () => {
    if (!trashed) return;
    window.clearTimeout(undoTimer.current);
    setTrashed(null);
    await restoreDoc(trashed.doc, trashed.summary.updated_at);
    setDocs((prev) =>
      [...(prev ?? []).filter((d) => d.id !== trashed.summary.id), trashed.summary].sort((a, b) =>
        b.updated_at.localeCompare(a.updated_at),
      ),
    );
    setActiveId(trashed.doc.id);
    setShowList(false);
  };

  const allTags = [...new Set((docs ?? []).map((d) => d.tag).filter((t): t is string => !!t))].sort((a, b) =>
    a.localeCompare(b, "sv"),
  );

  const q = query.trim().toLowerCase();
  const activeTag = allTags.includes(tagFilter) ? tagFilter : "";
  const filteredDocs = (docs ?? []).filter(
    (d) =>
      (!activeTag || d.tag === activeTag) &&
      (!q ||
        d.title.toLowerCase().includes(q) ||
        d.content_text.toLowerCase().includes(q) ||
        !!d.tag?.toLowerCase().includes(q)),
  );

  return (
    <div className="shell">
      <aside className={`sidebar ${showList ? "open" : ""}`}>
        <div className="sidebar-head">
          <div className="brand">
            <img src="/favicon-32.png" alt="" className="brand-icon" />
            <span className="brand-word">.txt</span>
          </div>
          <button type="button" className="new-note" onClick={onNew} aria-label="Ny anteckning" title="Ny anteckning">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        <div className="search-wrap">
          <input
            type="search"
            className="search"
            placeholder="Sök"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Sök bland anteckningar"
          />
          {allTags.length > 0 && (
            <select
              className={`search-tag ${activeTag ? "on" : ""}`}
              value={activeTag}
              onChange={(e) => setTagFilter(e.target.value)}
              aria-label="Visa bara anteckningar med tagg"
            >
              <option value="">Alla taggar</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="notes">
          {docs === undefined && <div className="notes-empty">Laddar…</div>}
          {docs?.length === 0 && <div className="notes-empty">Inga anteckningar än</div>}
          {docs && docs.length > 0 && filteredDocs.length === 0 && (
            <div className="notes-empty">{q ? `Inga träffar på "${query}"` : "Inga anteckningar med den taggen"}</div>
          )}
          {filteredDocs.map((d) => (
            <NoteRow
              key={d.id}
              d={d}
              active={d.id === activeId}
              onSelect={() => onSelect(d.id)}
              onDelete={() => onDelete(d.id)}
              onTrash={() => onDelete(d.id)}
            />
          ))}
        </div>
        {supabase && (
          <button type="button" className="signout" onClick={() => void supabase?.auth.signOut()}>
            Logga ut
          </button>
        )}
      </aside>
      <div className={`main ${showList ? "" : "open"}`}>
        <Editor
          key={activeId}
          docId={activeId}
          allTags={allTags}
          onBack={() => setShowList(true)}
          onSaved={onSaved}
          onEmptied={onEmptied}
          onDelete={() => onDelete(activeId)}
        />
      </div>
      {trashed && (
        <div className="undo-toast" role="status">
          <span>Anteckningen slängd</span>
          <button type="button" onClick={onUndo}>
            Ångra
          </button>
        </div>
      )}
    </div>
  );
}

/** Dra en anteckning åt vänster för att slänga den – som att dra bort en ikon från Dockan på Mac. */
function NoteRow({
  d,
  active,
  onSelect,
  onDelete,
  onTrash,
}: {
  d: DocSummary;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onTrash: () => void;
}) {
  const THROW_AWAY = -90;
  const start = useRef<{ x: number; y: number } | null>(null);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [gone, setGone] = useState(false);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!start.current) return;
    const rawX = e.clientX - start.current.x;
    const rawY = e.clientY - start.current.y;
    if (!dragging) {
      if (Math.abs(rawX) < 10 && Math.abs(rawY) < 10) return;
      if (Math.abs(rawY) > Math.abs(rawX)) {
        start.current = null; // vertikal rörelse – låt listan scrolla istället
        return;
      }
      setDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
    setDx(Math.min(0, rawX));
  };

  const endDrag = () => {
    if (!dragging) {
      start.current = null;
      return;
    }
    if (dx < THROW_AWAY) {
      setGone(true);
      setDx(-400);
      window.setTimeout(onDelete, 190);
    } else {
      setDx(0);
    }
    start.current = null;
    setDragging(false);
  };

  return (
    <div
      className="note-row"
      style={{
        transform: `translateX(${dx}px)`,
        opacity: gone ? 0 : 1,
        transition: dragging ? "none" : "transform .2s ease, opacity .2s ease",
      }}
    >
      <button
        type="button"
        className={`note-item ${active ? "active" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={() => {
          if (!dragging && Math.abs(dx) < 4) onSelect();
        }}
      >
        <span className="note-title">{d.title || "Namnlöst"}</span>
        <span className="note-meta">
          <span className="note-time">{timeAgo(d.updated_at)}</span>
          {d.tag && <span className="note-tag">{d.tag}</span>}
          <span className="note-preview">{(d.content_text || "Tomt").replace(/\s+/g, " ").slice(0, 60)}</span>
        </span>
      </button>
      {active && (
        <button type="button" className="note-trash" onClick={onTrash} aria-label="Släng anteckningen" title="Släng">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
          </svg>
          Släng
        </button>
      )}
    </div>
  );
}

function Editor({
  docId,
  allTags,
  onBack,
  onSaved,
  onEmptied,
  onDelete,
}: {
  docId: string;
  allTags: string[];
  onBack: () => void;
  onSaved: (s: DocSummary) => void;
  onEmptied: (id: string) => void;
  onDelete: () => void;
}) {
  const doc = useRef<Doc>(newDoc(docId));
  const timer = useRef<number | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("plain");
  const [plain, setPlain] = useState("");
  const [title, setTitle] = useState("Namnlöst");
  // Så länge man inte själv skrivit en titel följer titeln textens första rad.
  const autoTitle = useRef(true);
  const syncAutoTitle = useCallback(() => {
    if (!autoTitle.current) return;
    const t = titleFromText(doc.current.content_text);
    doc.current.title = t;
    setTitle(t);
  }, []);
  const [tag, setTag] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(supabase ? "idle" : "offline");
  const [ready, setReady] = useState(false);
  const [fileMsg, setFileMsg] = useState("");
  const [copyMsg, setCopyMsg] = useState("");

  const flush = useCallback(async () => {
    if (!supabase) return;
    setStatus("saving");
    try {
      // Tom anteckning (ingen text) sparas inte – och tas bort om den redan fanns sparad.
      if (!doc.current.content_text.trim()) {
        await deleteDoc(doc.current.id);
        setStatus("idle");
        onEmptied(doc.current.id);
        return;
      }
      await saveDoc({ ...doc.current });
      setStatus("saved");
      onSaved({
        id: doc.current.id,
        title: doc.current.title,
        content_text: doc.current.content_text,
        mode: doc.current.mode,
        tag: doc.current.tag,
        updated_at: new Date().toISOString(),
      });
    } catch {
      setStatus("error");
    }
  }, [onSaved, onEmptied]);

  const schedule = useCallback(() => {
    if (!supabase) return;
    setStatus("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, DEBOUNCE_MS);
  }, [flush]);

  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: "Skriv något…" })],
    content: "",
    onUpdate: ({ editor }) => {
      doc.current.content_html = editor.getHTML();
      doc.current.content_text = editor.getText({ blockSeparator: "\n" });
      syncAutoTitle();
      schedule();
    },
  });

  useEffect(() => {
    if (!editor) return;
    loadDoc(docId)
      .then((d) => {
        if (d) {
          doc.current = d;
          autoTitle.current = d.title === "Namnlöst" || d.title === titleFromText(d.content_text);
          setTitle(d.title);
          setTag(d.tag);
          setMode(d.mode);
          setPlain(d.content_text);
          editor.commands.setContent(d.content_html, { emitUpdate: false });
        }
      })
      .catch(() => setStatus("error"))
      .finally(() => setReady(true));
  }, [editor, docId]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && timer.current) {
        window.clearTimeout(timer.current);
        timer.current = undefined;
        void flush();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      if (timer.current) {
        window.clearTimeout(timer.current);
        void flush();
      }
    };
  }, [flush]);

  const toggle = (next: Mode) => {
    if (next === mode || !editor) return;
    if (next === "plain") {
      setPlain(editor.getText({ blockSeparator: "\n" }));
    } else {
      editor.commands.setContent(textToHtml(plain), { emitUpdate: false });
      doc.current.content_html = editor.getHTML();
    }
    doc.current.mode = next;
    setMode(next);
    schedule();
  };

  const onPlain = (v: string) => {
    setPlain(v);
    doc.current.content_text = v;
    doc.current.content_html = textToHtml(v);
    syncAutoTitle();
    schedule();
  };

  const onTitle = (v: string) => {
    setTitle(v);
    autoTitle.current = !v.trim();
    doc.current.title = v || "Namnlöst";
    schedule();
  };

  const NEW_TAG = "__ny__";
  const onTag = (v: string) => {
    let next: string | null = v || null;
    if (v === NEW_TAG) {
      next = window.prompt("Namn på ny tagg")?.trim() || null;
      if (!next) return;
    }
    setTag(next);
    doc.current.tag = next;
    schedule();
  };
  const tagOptions = tag && !allTags.includes(tag) ? [...allTags, tag] : allTags;

  const exportLabel: Record<"shared" | "handle" | "download", string> = {
    shared: "Delad ✓",
    handle: "Sparad i fil ✓",
    download: "Nedladdad",
  };

  const onExportFile = async () => {
    try {
      const kind = await saveOrShareText(docId, doc.current.title, doc.current.content_text);
      setFileMsg(exportLabel[kind]);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setFileMsg("Kunde inte spara filen");
    } finally {
      window.setTimeout(() => setFileMsg(""), 1800);
    }
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(doc.current.content_text);
      setCopyMsg("Kopierad ✓");
    } catch {
      setCopyMsg("Kunde inte kopiera");
    } finally {
      window.setTimeout(() => setCopyMsg(""), 1800);
    }
  };

  const rich = mode === "rich";
  const currentText = rich ? (editor?.getText({ blockSeparator: "\n" }) ?? "") : plain;
  const wordCount = currentText.trim() ? currentText.trim().split(/\s+/).length : 0;
  // Tecken inklusive mellanslag, som i Word (radbrytningar räknas inte).
  const charCount = [...currentText.replace(/\n/g, "")].length;
  const btn = (label: string, active: boolean | undefined, run: () => void, cls = "") => (
    <button
      type="button"
      className={`tb ${cls} ${active ? "on" : ""}`}
      disabled={!rich}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  );
  const c = () => editor?.chain().focus();

  return (
    <div className="win">
      <header className="bar">
        <button type="button" className="back" onClick={onBack} aria-label="Tillbaka till listan">
          ‹
        </button>
        <input
          className="title"
          value={title === "Namnlöst" ? "" : title}
          placeholder="Namnlöst"
          onChange={(e) => onTitle(e.target.value)}
          aria-label="Titel"
        />
        <div className="bar-actions">
          <button type="button" className="icon-btn" onClick={onDelete} aria-label="Ta bort" title="Ta bort">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
            </svg>
          </button>
          <span className="word-count">
            {wordCount.toLocaleString("sv-SE")} ord · {charCount.toLocaleString("sv-SE")} tecken
          </span>
        </div>
      </header>
      <div className="toolbar">
        {rich && (
          <>
            {btn("B", editor?.isActive("bold"), () => c()?.toggleBold().run(), "b")}
            {btn("I", editor?.isActive("italic"), () => c()?.toggleItalic().run(), "i")}
            {btn("S", editor?.isActive("strike"), () => c()?.toggleStrike().run(), "s")}
            <span className="sep" />
            {btn("H1", editor?.isActive("heading", { level: 1 }), () => c()?.toggleHeading({ level: 1 }).run())}
            {btn("H2", editor?.isActive("heading", { level: 2 }), () => c()?.toggleHeading({ level: 2 }).run())}
            <span className="sep" />
            {btn("•", editor?.isActive("bulletList"), () => c()?.toggleBulletList().run())}
            {btn("1.", editor?.isActive("orderedList"), () => c()?.toggleOrderedList().run())}
          </>
        )}
        {rich && <span className="sep" />}
        <select className="tag-select" value={tag ?? ""} onChange={(e) => onTag(e.target.value)} aria-label="Tagg">
          <option value="">Ingen tagg</option>
          {tagOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
          <option value={NEW_TAG}>+ Ny tagg…</option>
        </select>
        <div className="seg" role="group" aria-label="Läge">
          <button className={rich ? "on" : ""} onClick={() => toggle("rich")}>Rich text</button>
          <button className={!rich ? "on" : ""} onClick={() => toggle("plain")}>Ren text</button>
        </div>
      </div>
      <main className="page">
        {!ready && <div className="loading">Laddar…</div>}
        <div hidden={!rich}>
          <EditorContent editor={editor} />
        </div>
        {!rich && (
          <textarea
            className="plain"
            value={plain}
            onChange={(e) => onPlain(e.target.value)}
            placeholder="Skriv något…"
            spellCheck
            autoFocus
          />
        )}
        <div className="save-box-wrap">
          <button type="button" className="save-box secondary" onClick={onCopy}>
            {copyMsg || "Kopiera"}
          </button>
          <button type="button" className="save-box" onClick={onExportFile}>
            {fileMsg || "Spara"}
          </button>
        </div>
      </main>
    </div>
  );
}
