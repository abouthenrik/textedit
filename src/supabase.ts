import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase = url && key ? createClient(url, key) : null;

export type Mode = "rich" | "plain";
export interface Doc {
  id: string;
  title: string;
  content_html: string;
  content_text: string;
  mode: Mode;
}

/** Anonym inloggning ger en stabil användare per enhet, så RLS kan låsa dokumentet till ägaren. */
async function ensureUser() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.user;
  const { data: anon, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return anon.user;
}

export async function loadLatest(): Promise<Doc | null> {
  if (!supabase) return null;
  await ensureUser();
  const { data, error } = await supabase
    .from("documents")
    .select("id,title,content_html,content_text,mode")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Doc | null;
}

export async function saveDoc(doc: Doc) {
  if (!supabase) throw new Error("Supabase är inte konfigurerat");
  await ensureUser();
  const { error } = await supabase
    .from("documents")
    .upsert({ ...doc, updated_at: new Date().toISOString() });
  if (error) throw error;
}
