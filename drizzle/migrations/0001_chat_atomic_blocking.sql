CREATE FUNCTION public.chat_set_block(p_owner text, p_peer text, p_blocked boolean) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
PERFORM pg_advisory_xact_lock(hashtextextended(least(p_owner,p_peer) || ':' || greatest(p_owner,p_peer),0));
IF p_blocked THEN INSERT INTO public.chat_blocks(owner_id,blocked_id) VALUES(p_owner,p_peer) ON CONFLICT DO NOTHING;
ELSE DELETE FROM public.chat_blocks WHERE owner_id=p_owner AND blocked_id=p_peer; END IF;
END; $$;
REVOKE ALL ON FUNCTION public.chat_set_block(text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_set_block(text,text,boolean) TO service_role;