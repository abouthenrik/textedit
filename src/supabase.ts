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

export interface DocSummary {
  id: string;
  title: string;
  content_text: string;
  mode: Mode;
  updated_at: string;
}

export interface Profile {
  id: string;
  email: string | null;
  approved: boolean;
  is_admin: boolean;
}

export async function fetchMyProfile(userId: string): Promise<Profile | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("id,email,approved,is_admin")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}

export async function listDocs(): Promise<DocSummary[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("documents")
    .select("id,title,content_text,mode,updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data as DocSummary[]) ?? [];
}

export async function loadDoc(id: string): Promise<Doc | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("documents")
    .select("id,title,content_html,content_text,mode")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as Doc | null;
}

export async function saveDoc(doc: Doc) {
  if (!supabase) throw new Error("Supabase är inte konfigurerat");
  const { error } = await supabase
    .from("documents")
    .upsert({ ...doc, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function deleteDoc(id: string) {
  if (!supabase) return;
  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) throw error;
}
