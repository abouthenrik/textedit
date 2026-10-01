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
 * Mobil (ingen sådan dialog i webbläsaren) -> delningsmenyn ger t.ex. "Spara i Drive" / "Spara i Filer".
 */
async function saveOrShareText(docId: string, title: string, text: string): Promise<"shared" | "handle" | "download"> {
  const w = window as unknown as { showSaveFilePicker?: unknown };
  if (fileHandles.has(docId) || w.showSaveFilePicker) {
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
    const id = crypto.randomUUID();
    const title = name.replace(/\.txt$/i, "") || "Namnlöst";
    const full: Doc = { id, title, content_html: textToHtml(text), content_text: text, mode: "plain" };
    await saveDoc(full);
    if (handle) fileHandles.set(id, handle);
    setDocs((prev) => [
      { id, title, content_text: text, mode: "plain", updated_at: new Date().toISOString() },
      ...(prev ?? []),
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

  const onDelete = useCallback(
    async (id: string, skipConfirm = false) => {
      if (!skipConfirm && !window.confirm("Ta bort anteckningen?")) return;
      fileHandles.delete(id);
      await deleteDoc(id);
      setDocs((prev) => (prev ?? []).filter((d) => d.id !== id));
      if (id === activeId) {
        setActiveId(crypto.randomUUID());
        setShowList(false);
      }
    },
    [activeId],
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
            +
          </button>
        </div>
        <div className="notes">
          {docs === undefined && <div className="notes-empty">Laddar…</div>}
          {docs?.length === 0 && <div className="notes-empty">Inga anteckningar än</div>}
          {docs?.map((d) => (
            <NoteRow
              key={d.id}
              d={d}
              active={d.id === activeId}
              onSelect={() => onSelect(d.id)}
              onDelete={() => onDelete(d.id, true)}
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
          onBack={() => setShowList(true)}
          onSaved={onSaved}
          onDelete={() => onDelete(activeId)}
        />
      </div>
    </div>
  );
}

/** Dra en anteckning åt vänster för att slänga den – som att dra bort en ikon från Dockan på Mac. */
function NoteRow({
  d,
  active,
  onSelect,
  onDelete,
}: {
  d: DocSummary;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
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
    <button
      type="button"
      className={`note-item ${active ? "active" : ""}`}
      style={{
        transform: `translateX(${dx}px)`,
        opacity: gone ? 0 : 1,
        transition: dragging ? "none" : "transform .2s ease, opacity .2s ease",
      }}
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
        <span className="note-preview">{(d.content_text || "Tomt").replace(/\s+/g, " ").slice(0, 60)}</span>
      </span>
    </button>
  );
}

function Editor({
  docId,
  onBack,
  onSaved,
  onDelete,
}: {
  docId: string;
  onBack: () => void;
  onSaved: (s: DocSummary) => void;
  onDelete: () => void;
}) {
  const doc = useRef<Doc>(newDoc(docId));
  const timer = useRef<number | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("plain");
  const [plain, setPlain] = useState("");
  const [title, setTitle] = useState("Namnlöst");
  const [status, setStatus] = useState<Status>(supabase ? "idle" : "offline");
  const [ready, setReady] = useState(false);
  const [fileMsg, setFileMsg] = useState("");

  const flush = useCallback(async () => {
    if (!supabase) return;
    setStatus("saving");
    try {
      await saveDoc({ ...doc.current });
      setStatus("saved");
      onSaved({
        id: doc.current.id,
        title: doc.current.title,
        content_text: doc.current.content_text,
        mode: doc.current.mode,
        updated_at: new Date().toISOString(),
      });
    } catch {
      setStatus("error");
    }
  }, [onSaved]);

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
      schedule();
    },
  });

  useEffect(() => {
    if (!editor) return;
    loadDoc(docId)
      .then((d) => {
        if (d) {
          doc.current = d;
          setTitle(d.title);
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
    schedule();
  };

  const onTitle = (v: string) => {
    setTitle(v);
    doc.current.title = v || "Namnlöst";
    schedule();
  };

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

  const rich = mode === "rich";
  const currentText = rich ? (editor?.getText({ blockSeparator: "\n" }) ?? "") : plain;
  const wordCount = currentText.trim() ? currentText.trim().split(/\s+/).length : 0;
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
        <input className="title" value={title} onChange={(e) => onTitle(e.target.value)} aria-label="Titel" />
        <div className="bar-actions">
          <button type="button" className="icon-btn" onClick={onDelete} aria-label="Ta bort" title="Ta bort">
            🗑
          </button>
          <span className="word-count">{wordCount} ord</span>
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
        <span className="grow" />
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
          <button type="button" className="save-box" onClick={onExportFile}>
            {fileMsg || "Spara"}
            <span className="save-box-icon">▼</span>
          </button>
        </div>
      </main>
    </div>
  );
}
