CREATE TABLE public.activity_bridge_settings (
  discord_user_id TEXT PRIMARY KEY REFERENCES public.discord_accounts(discord_user_id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  visibility TEXT NOT NULL DEFAULT 'friends' CHECK (visibility IN ('everyone', 'friends', 'nobody')),
  shared_apps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.activity_bridge_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  discord_user_id TEXT NOT NULL REFERENCES public.discord_accounts(discord_user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE public.activity_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  discord_user_id TEXT NOT NULL REFERENCES public.discord_accounts(discord_user_id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('opened', 'closed')),
  app_name TEXT NOT NULL,
  app_identifier TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  current_status TEXT NOT NULL DEFAULT 'active' CHECK (current_status IN ('active', 'ended')),
  visibility TEXT NOT NULL DEFAULT 'friends' CHECK (visibility IN ('everyone', 'friends', 'nobody')),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'ios_shortcuts' CHECK (source IN ('ios_shortcuts', 'native_ios')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX activity_events_user_last_seen_idx
  ON public.activity_events (discord_user_id, last_seen DESC);
CREATE INDEX activity_bridge_tokens_hash_idx
  ON public.activity_bridge_tokens (token_hash);

GRANT ALL ON public.activity_bridge_settings TO service_role;
GRANT ALL ON public.activity_bridge_tokens TO service_role;
GRANT ALL ON public.activity_events TO service_role;

ALTER TABLE public.activity_bridge_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_bridge_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "activity bridge settings service only"
  ON public.activity_bridge_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "activity bridge tokens service only"
  ON public.activity_bridge_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "activity events service only"
  ON public.activity_events FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER activity_bridge_settings_touch
  BEFORE UPDATE ON public.activity_bridge_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
