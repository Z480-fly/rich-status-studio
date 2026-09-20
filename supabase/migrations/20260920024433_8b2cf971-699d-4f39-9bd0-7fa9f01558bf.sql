CREATE TABLE public.discord_accounts (
  discord_user_id TEXT PRIMARY KEY,
  username TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  scope TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.discord_accounts TO service_role;
ALTER TABLE public.discord_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "discord_accounts service only" ON public.discord_accounts FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.app_sessions (
  token TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL REFERENCES public.discord_accounts(discord_user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days')
);
GRANT ALL ON public.app_sessions TO service_role;
ALTER TABLE public.app_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "app_sessions service only" ON public.app_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.presence_sessions (
  discord_user_id TEXT PRIMARY KEY REFERENCES public.discord_accounts(discord_user_id) ON DELETE CASCADE,
  activity JSONB,
  desired_state TEXT NOT NULL DEFAULT 'stopped',
  worker_state TEXT NOT NULL DEFAULT 'idle',
  worker_message TEXT,
  worker_heartbeat_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.presence_sessions TO service_role;
ALTER TABLE public.presence_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "presence_sessions service only" ON public.presence_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql SET search_path = public;
CREATE TRIGGER discord_accounts_touch BEFORE UPDATE ON public.discord_accounts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER presence_sessions_touch BEFORE UPDATE ON public.presence_sessions FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();