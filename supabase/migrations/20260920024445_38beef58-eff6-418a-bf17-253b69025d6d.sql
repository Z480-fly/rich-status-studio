DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='presets') THEN
    EXECUTE 'CREATE POLICY "presets service only" ON public.presets FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;
GRANT ALL ON public.presets TO service_role;