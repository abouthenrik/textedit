import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { loadLatest, saveDoc, supabase, type Doc, type Mode } from "./supabase";

const DEBOUNCE_MS = 1000;
type Status = "idle" | "dirty" | "saving" | "saved" | "error" | "offline";

const newDoc = (): Doc => ({
  id: crypto.randomUUID(),
  title: "Namnlöst",
  content_html: "",
  content_text: "",
  mode: "rich",
});

export function App() {
  const doc = useRef<Doc>(newDoc());
  const timer = useRef<number | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("rich");
  const [plain, setPlain] = useState("");
  const [title, setTitle] = useState("Namnlöst");
  const [status, setStatus] = useState<Status>(supabase ? "idle" : "offline");
  const [ready, setReady] = useState(false);

  const flush = useCallback(async () => {
    if (!supabase) return;
    setStatus("saving");
    try {
      await saveDoc({ ...doc.current });
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, []);

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

  // Ladda senaste dokumentet
  useEffect(() => {
    if (!editor) return;
    loadLatest()
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
  }, [editor]);

  // Spara direkt om fliken göms/stängs
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && timer.current) {
        window.clearTimeout(timer.current);
        timer.current = undefined;
        void flush();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [flush]);

  const toggle = (next: Mode) => {
    if (next === mode || !editor) return;
    if (next === "plain") {
      setPlain(editor.getText({ blockSeparator: "\n" }));
    } else {
      const html = plain
        .split("\n")
        .map((l) => `<p>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`)
        .join("");
      editor.commands.setContent(html, { emitUpdate: false });
      doc.current.content_html = editor.getHTML();
    }
    doc.current.mode = next;
    setMode(next);
    schedule();
  };

  const onPlain = (v: string) => {
    setPlain(v);
    doc.current.content_text = v;
    doc.current.content_html = v
      .split("\n")
      .map((l) => `<p>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`)
      .join("");
    schedule();
  };

  const onTitle = (v: string) => {
    setTitle(v);
    doc.current.title = v || "Namnlöst";
    schedule();
  };

  const rich = mode === "rich";
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

  const label: Record<Status, string> = {
    idle: "",
    dirty: "Redigerad",
    saving: "Sparar…",
    saved: "Sparad",
    error: "Kunde inte spara",
    offline: "Supabase ej konfigurerat",
  };

  return (
    <div className="win">
      <header className="bar">
        <input className="title" value={title} onChange={(e) => onTitle(e.target.value)} aria-label="Titel" />
        <span className={`status ${status}`}>{label[status]}</span>
      </header>
      <div className="toolbar">
        {btn("B", editor?.isActive("bold"), () => c()?.toggleBold().run(), "b")}
        {btn("I", editor?.isActive("italic"), () => c()?.toggleItalic().run(), "i")}
        {btn("S", editor?.isActive("strike"), () => c()?.toggleStrike().run(), "s")}
        <span className="sep" />
        {btn("H1", editor?.isActive("heading", { level: 1 }), () => c()?.toggleHeading({ level: 1 }).run())}
        {btn("H2", editor?.isActive("heading", { level: 2 }), () => c()?.toggleHeading({ level: 2 }).run())}
        <span className="sep" />
        {btn("•", editor?.isActive("bulletList"), () => c()?.toggleBulletList().run())}
        {btn("1.", editor?.isActive("orderedList"), () => c()?.toggleOrderedList().run())}
        {btn("❝", editor?.isActive("blockquote"), () => c()?.toggleBlockquote().run())}
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
      </main>
    </div>
  );
}
