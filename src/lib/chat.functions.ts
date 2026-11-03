import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { chatAuth, chatSearch, chatPeer, chatSend, isParticipant } from "./chat-rules";

export const getChatInbox = createServerFn({ method: "POST" }).validator(chatAuth).handler(async ({ data }) => {
  const { chatIdentity } = await import("./chat.server");
  const me = await chatIdentity(data.accessToken);
  if (!me) return { me: null, conversations: [] };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: conversations, error } = await supabaseAdmin.rpc("chat_inbox", { p_user: me.id });
  if (error) throw new Error("Could not load your inbox. Try again.");
  return { me, conversations: conversations ?? [] };
});

export const findChatUsers = createServerFn({ method: "POST" }).validator(chatSearch).handler(async ({ data }) => {
  const { requireChatIdentity, syncChatDirectory } = await import("./chat.server");
  const me = await requireChatIdentity(data.accessToken);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Everyone who linked Discord should be findable, not just inbox visitors.
  await syncChatDirectory();
  const query = data.query.replace(/[%_\\]/g, "\\$&");
  const pattern = `%${query}%`;
  const columns = "discord_user_id,discord_name,display_name";
  // The same person is stored with the @handle for Activity users and with the
  // display name for browser-linked users, so match either column.
  const [handles, names] = await Promise.all([
    supabaseAdmin.from("chat_users").select(columns).neq("discord_user_id", me.id).ilike("discord_name", pattern).limit(20),
    supabaseAdmin.from("chat_users").select(columns).neq("discord_user_id", me.id).ilike("display_name", pattern).limit(20),
  ]);
  if (handles.error || names.error) throw new Error("Could not search people. Try again.");
  const seen = new Set<string>();
  return [...(handles.data ?? []), ...(names.data ?? [])]
    .filter((user) => {
      if (seen.has(user.discord_user_id)) return false;
      seen.add(user.discord_user_id);
      return true;
    })
    .slice(0, 20);
});

export const listChatPeople = createServerFn({ method: "POST" }).validator(chatAuth).handler(async ({ data }) => {
  const { requireChatIdentity, syncChatDirectory } = await import("./chat.server");
  const me = await requireChatIdentity(data.accessToken);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await syncChatDirectory();
  // Browsing beats guessing a name: everyone who linked Discord is listed here.
  const { data: people, error } = await supabaseAdmin.from("chat_users").select("discord_user_id,discord_name,display_name").neq("discord_user_id", me.id).order("updated_at", { ascending: false }).limit(100);
  if (error) throw new Error("Could not load people. Try again.");
  return people ?? [];
});

export const getChatThread = createServerFn({ method: "POST" }).validator(chatPeer.extend({ before: z.string().datetime().optional() })).handler(async ({ data }) => {
  const { requireChatIdentity } = await import("./chat.server");
  const me = await requireChatIdentity(data.accessToken);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: peer, error: peerError } = await supabaseAdmin.from("chat_users").select("discord_user_id,discord_name,display_name").eq("discord_user_id", data.peerId).maybeSingle();
  if (peerError || !peer) throw new Error("This Zora user could not be found.");
  let query = supabaseAdmin.from("chat_messages").select("id,sender_id,recipient_id,body,created_at,read_at").or(`and(sender_id.eq.${me.id},recipient_id.eq.${data.peerId}),and(sender_id.eq.${data.peerId},recipient_id.eq.${me.id})`).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(50);
  if (data.before) query = query.lt("created_at", data.before);
  const [{ data: messages, error }, { data: blocks, error: blockError }] = await Promise.all([
    query,
    supabaseAdmin.from("chat_blocks").select("owner_id").or(`and(owner_id.eq.${me.id},blocked_id.eq.${data.peerId}),and(owner_id.eq.${data.peerId},blocked_id.eq.${me.id})`),
  ]);
  if (error || blockError) throw new Error("Could not load messages. Try again.");
  // Defense in depth: never serialize a message belonging to unrelated accounts.
  const safe = (messages ?? []).filter((message) => isParticipant(me.id, message));
  if (safe.length) {
    const { error: readError } = await supabaseAdmin.from("chat_messages").update({ read_at: new Date().toISOString() }).eq("recipient_id", me.id).eq("sender_id", data.peerId).in("id", safe.map((message) => message.id)).is("read_at", null);
    if (readError) throw new Error("Could not mark messages read. Try again.");
  }
  return { me, peer, messages: safe.reverse(), hasMore: safe.length === 50, blocked: Boolean(blocks?.length), blockedByMe: Boolean(blocks?.some((block) => block.owner_id === me.id)) };
});

export const sendChatMessage = createServerFn({ method: "POST" }).validator(chatSend).handler(async ({ data }) => {
  const { requireChatIdentity } = await import("./chat.server");
  const me = await requireChatIdentity(data.accessToken);
  if (me.id === data.peerId) throw new Error("Choose another Zora user.");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.rpc("chat_send", { p_sender: me.id, p_recipient: data.peerId, p_body: data.body });
  if (error) {
    if (error.message.includes("wait a moment")) throw new Error("Please wait a moment before sending again.");
    if (error.message.includes("unavailable")) throw new Error("Messaging is unavailable for this conversation.");
    throw new Error("Message was not sent. Try again.");
  }
  return { ok: true };
});

export const setChatBlock = createServerFn({ method: "POST" }).validator(chatPeer.extend({ blocked: z.boolean() })).handler(async ({ data }) => {
  const { requireChatIdentity } = await import("./chat.server");
  const me = await requireChatIdentity(data.accessToken);
  if (me.id === data.peerId) throw new Error("Choose another Zora user.");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.rpc("chat_set_block", { p_owner: me.id, p_peer: data.peerId, p_blocked: data.blocked });
  if (error) throw new Error("Could not change blocking. Try again.");
  return { ok: true };
});