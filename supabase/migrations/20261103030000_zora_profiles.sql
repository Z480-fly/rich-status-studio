-- Zora profiles: one customisable public identity per linked Discord account.
-- The whole profile is data (theme + ordered sections), which is what makes
-- reordering, hiding and custom sections possible without extra tables.
-- Written to be safely re-runnable, so it can also be pasted into the SQL editor.

CREATE TABLE IF NOT EXISTS public.profiles (
  discord_user_id text PRIMARY KEY REFERENCES public.discord_accounts(discord_user_id) ON DELETE CASCADE,
  handle text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name text NOT NULL,
  tagline text NOT NULL DEFAULT '',
  theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  published boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Profiles service only" ON public.profiles;
CREATE POLICY "Profiles service only" ON public.profiles FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS profiles_handle ON public.profiles (handle);
