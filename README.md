# Text – minimalistisk PWA-textredigerare

React + TipTap + Supabase. Utseendet följer macOS TextEdit.

- Växla mellan **Rich text** (WYSIWYG) och **Ren text** i verktygsfältet.
- Autosparar till Supabase 1000 ms efter senaste ändring (debounce), samt direkt när fliken göms.
- Anonym Supabase-inloggning; RLS låser dokumentet till ägaren.

## Kom igång
1. `cp .env.example .env` och fyll i `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`.
2. Aktivera *Anonymous sign-ins* i Supabase Auth och kör `supabase/migrations/*.sql` (`supabase db push`).
3. `npm install && npm run dev`
