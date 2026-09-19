CREATE TABLE public.presets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '✨',
  accent TEXT NOT NULL DEFAULT 'oklch(0.8 0.13 180)',
  draft JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX presets_discord_user_id_idx ON public.presets (discord_user_id);

GRANT ALL ON public.presets TO service_role;

ALTER TABLE public.presets ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_presets_updated_at
BEFORE UPDATE ON public.presets
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();