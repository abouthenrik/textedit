create table public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'Namnlöst',
  content_html text not null default '',
  content_text text not null default '',
  mode text not null default 'rich' check (mode in ('rich', 'plain')),
  updated_at timestamptz not null default now()
);

alter table public.documents enable row level security;

create policy "owner select" on public.documents for select to authenticated using (owner_id = (select auth.uid()));
create policy "owner insert" on public.documents for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "owner update" on public.documents for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owner delete" on public.documents for delete to authenticated using (owner_id = (select auth.uid()));
