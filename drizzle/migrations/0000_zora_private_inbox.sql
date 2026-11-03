CREATE TABLE public.chat_users (
 discord_user_id text PRIMARY KEY,
 discord_name text NOT NULL,
 display_name text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.chat_users TO service_role;
ALTER TABLE public.chat_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Chat directory service only" ON public.chat_users FOR ALL TO service_role USING (true) WITH CHECK (true);
INSERT INTO public.chat_users (discord_user_id, discord_name, display_name) SELECT discord_user_id, username, username FROM public.discord_accounts WHERE username IS NOT NULL;
CREATE TABLE public.chat_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sender_id text NOT NULL REFERENCES public.chat_users(discord_user_id),
 recipient_id text NOT NULL REFERENCES public.chat_users(discord_user_id),
 body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),
 read_at timestamptz,
 CONSTRAINT chat_no_self_message CHECK (sender_id <> recipient_id)
);
GRANT ALL ON public.chat_messages TO service_role;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Messages service only" ON public.chat_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX chat_messages_sender ON public.chat_messages(sender_id, created_at DESC);
CREATE INDEX chat_messages_recipient ON public.chat_messages(recipient_id, created_at DESC);
CREATE TABLE public.chat_blocks (
 owner_id text NOT NULL REFERENCES public.chat_users(discord_user_id),
 blocked_id text NOT NULL REFERENCES public.chat_users(discord_user_id),
 PRIMARY KEY (owner_id, blocked_id),
 CHECK (owner_id <> blocked_id)
);
GRANT ALL ON public.chat_blocks TO service_role;
ALTER TABLE public.chat_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Blocks service only" ON public.chat_blocks FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE FUNCTION public.chat_send(p_sender text, p_recipient text, p_body text) RETURNS uuid
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE result uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(least(p_sender,p_recipient) || ':' || greatest(p_sender,p_recipient),0));
 IF EXISTS (SELECT 1 FROM public.chat_blocks WHERE (owner_id=p_sender AND blocked_id=p_recipient) OR (owner_id=p_recipient AND blocked_id=p_sender)) THEN RAISE EXCEPTION 'Messaging is unavailable for this conversation.'; END IF;
 IF EXISTS (SELECT 1 FROM public.chat_messages WHERE sender_id=p_sender AND created_at > now()-interval '2 seconds') THEN RAISE EXCEPTION 'Please wait a moment before sending again.'; END IF;
 INSERT INTO public.chat_messages(sender_id,recipient_id,body) VALUES(p_sender,p_recipient,btrim(p_body)) RETURNING id INTO result;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.chat_send(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_send(text,text,text) TO service_role;
CREATE FUNCTION public.chat_inbox(p_user text) RETURNS TABLE (peer_id text, discord_name text, display_name text, body text, created_at timestamptz, unread bigint)
LANGUAGE sql STABLE SET search_path = public AS $$
 WITH mine AS (SELECT *, CASE WHEN sender_id=p_user THEN recipient_id ELSE sender_id END AS peer FROM public.chat_messages WHERE sender_id=p_user OR recipient_id=p_user),
 latest AS (SELECT DISTINCT ON(peer) peer,body,created_at FROM mine ORDER BY peer,created_at DESC,id DESC),
 counts AS (SELECT sender_id,count(*) AS n FROM public.chat_messages WHERE recipient_id=p_user AND read_at IS NULL GROUP BY sender_id)
 SELECT l.peer,u.discord_name,u.display_name,l.body,l.created_at,coalesce(c.n,0) FROM latest l JOIN public.chat_users u ON u.discord_user_id=l.peer LEFT JOIN counts c ON c.sender_id=l.peer ORDER BY l.created_at DESC;
$$;
REVOKE ALL ON FUNCTION public.chat_inbox(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_inbox(text) TO service_role;