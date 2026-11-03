import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessageCircle, Plus, Search, Send, ShieldBan, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getChatInbox, getChatThread, findChatUsers, sendChatMessage, setChatBlock } from "@/lib/chat.functions";
import { getAccessToken, connectToDiscord, isInsideDiscord, subscribeConnection } from "@/lib/discord-client";
import { getDiscordLinkUrl } from "@/lib/server-presence.functions";

type Peer = { discord_user_id: string; discord_name: string; display_name: string };
type Message = Awaited<ReturnType<typeof getChatThread>>["messages"][number];
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function Inbox() {
  const cache = useQueryClient();
  const [token, setToken] = useState<string | undefined>();
  const [visible, setVisible] = useState(true);
  const [peer, setPeer] = useState<Peer | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Peer[] | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [older, setOlder] = useState<Message[]>([]);
  const [more, setMore] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const inboxFn = useServerFn(getChatInbox);
  const threadFn = useServerFn(getChatThread);
  const searchFn = useServerFn(findChatUsers);
  const sendFn = useServerFn(sendChatMessage);
  const blockFn = useServerFn(setChatBlock);
  const linkFn = useServerFn(getDiscordLinkUrl);
  useEffect(() => {
    const off = subscribeConnection(() => setToken(getAccessToken() ?? undefined));
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => { off(); document.removeEventListener("visibilitychange", update); };
  }, []);
  const inbox = useQuery({ queryKey: ["chat", "inbox", token], queryFn: () => inboxFn({ data: { accessToken: token } }), refetchInterval: visible ? 8000 : false, retry: false });
  const thread = useQuery({ queryKey: ["chat", "thread", peer?.discord_user_id, token], queryFn: () => threadFn({ data: { accessToken: token, peerId: peer?.discord_user_id ?? "0" } }), enabled: Boolean(peer && inbox.data?.me), refetchInterval: visible ? 5000 : false, retry: false });
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [peer?.discord_user_id, thread.data?.messages.at(-1)?.id]);
  useEffect(() => { if (thread.data) void cache.invalidateQueries({ queryKey: ["chat", "inbox"] }); }, [thread.data, cache]);
  const choose = (person: Peer) => { setPeer(person); setSearching(false); setError(""); setText(""); setOlder([]); setMore(true); };
  const fail = (value: unknown) => setError(value instanceof Error ? value.message : "Something went wrong. Try again.");
  const connect = async () => {
    setBusy(true); setError("");
    try {
      if (isInsideDiscord()) { await connectToDiscord(); setToken(getAccessToken() ?? undefined); await inbox.refetch(); }
      else { const { url } = await linkFn(); window.location.assign(url); }
    } catch (value) { fail(value); } finally { setBusy(false); }
  };
  const send = async () => {
    if (!peer || !text.trim() || busy) return;
    setBusy(true); setError("");
    try {
      await sendFn({ data: { accessToken: token, peerId: peer.discord_user_id, body: text } });
      setText(""); await thread.refetch(); await inbox.refetch();
    } catch (value) { fail(value); } finally { setBusy(false); }
  };
  const messages = [...older, ...(thread.data?.messages ?? [])].filter((message, index, all) => all.findIndex((other) => other.id === message.id) === index).sort((a,b) => a.created_at.localeCompare(b.created_at));
  const unread = inbox.data?.conversations.reduce((sum, conversation) => sum + Number(conversation.unread), 0) ?? 0;
  return (
    <main className="safe-area-shell mx-auto min-h-screen max-w-6xl px-4 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
        <Link to="/" className="font-display text-xl font-semibold">𝒁𝒐𝒓𝒂 𝑺𝒕𝒖𝒅𝒊𝒐 <span className="text-primary">✦</span></Link>
        <Button variant="ghost" asChild><Link to="/"><Sparkles />Status creator</Link></Button>
      </header>
      <div className="flex items-center justify-between py-6">
        <div><h1 className="text-3xl font-semibold">Inbox {unread > 0 && <span className="text-lg text-primary">{unread}</span>}</h1><p className="mt-1 text-sm text-muted-foreground">{inbox.data?.me ? `Signed in as ${inbox.data.me.displayName}` : "Your Zora conversations"}</p></div>
        {inbox.data?.me && <Button variant="outline" onClick={() => { setSearching(true); setPeer(null); setError(""); }}><Plus />New message</Button>}
      </div>
      {(error || inbox.error) && <p role="alert" className="mb-4 break-words text-sm text-destructive">{error || inbox.error?.message}<Button variant="ghost" onClick={() => void inbox.refetch()}>Retry</Button></p>}
      {inbox.isPending ? <p className="py-16 text-center text-muted-foreground">Opening inbox…</p> : !inbox.data?.me ? (
        <div className="flex flex-col items-center gap-4 py-20 text-center"><MessageCircle className="size-12 text-primary" /><h2 className="text-xl font-semibold">Your conversations start here</h2><Button onClick={() => void connect()} disabled={busy}>Link Discord account</Button></div>
      ) : (
        <section className="grid min-h-[560px] grid-cols-1 overflow-hidden rounded-lg border border-border bg-background/70 md:grid-cols-[300px_minmax(0,1fr)]">
          <aside className={`${peer || searching ? "hidden md:block" : "block"} border-b border-border md:border-b-0 md:border-r`}>
            <h2 className="border-b border-border p-4 text-xs font-semibold uppercase text-muted-foreground">Messages</h2>
            {!inbox.data.conversations.length && <div className="px-5 py-12 text-center text-sm text-muted-foreground">No conversations yet</div>}
            {inbox.data.conversations.map((conversation) => <Button key={conversation.peer_id} variant="ghost" className={`h-auto w-full justify-start gap-3 rounded-none px-4 py-4 text-left ${peer?.discord_user_id === conversation.peer_id ? "bg-accent" : ""}`} onClick={() => choose({ discord_user_id: conversation.peer_id, discord_name: conversation.discord_name, display_name: conversation.display_name })}>
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary font-display text-primary">{conversation.display_name.slice(0,1).toUpperCase()}</span>
              <span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><span className="truncate font-semibold">{conversation.display_name}</span>{Number(conversation.unread)>0 && <span className="text-xs text-primary">{conversation.unread}</span>}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{conversation.body}</span></span>
            </Button>)}
          </aside>
          <div className={`${peer || searching ? "flex" : "hidden md:flex"} min-w-0 flex-col`}>
            {searching ? <div className="p-5 sm:p-8"><Button variant="ghost" size="icon" aria-label="Back to inbox" onClick={() => setSearching(false)}><ArrowLeft /></Button><h2 className="mt-4 text-xl font-semibold">New message</h2>
              <form className="mt-5 flex gap-2" onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(""); try { setResults(await searchFn({ data: { accessToken: token, query: query.replace(/^@/, "") } })); } catch (value) { fail(value); } finally { setBusy(false); } }}>
                <input aria-label="Discord name" className="field min-w-0 focus:field-focus" placeholder="Discord name" value={query} maxLength={80} onChange={(event) => { setQuery(event.target.value); setResults(null); }} /><Button size="icon" className="size-11 shrink-0" aria-label="Search people" disabled={busy || query.replace(/^@/, "").trim().length < 2}><Search /></Button>
              </form>
              {results?.length === 0 && <p className="mt-6 text-sm text-muted-foreground">No Zora users found with that name.</p>}
              {results?.map((person) => <Button key={person.discord_user_id} variant="ghost" className="mt-3 h-auto w-full justify-between py-4 text-left" onClick={() => choose(person)}><span className="min-w-0"><span className="block truncate font-semibold">{person.display_name}</span><span className="block truncate text-xs text-muted-foreground">@{person.discord_name} · {person.discord_user_id}</span></span><MessageCircle /></Button>)}
            </div> : peer ? <>
              <div className="flex min-h-20 items-center gap-3 border-b border-border px-4"><Button variant="ghost" size="icon" aria-label="Back to inbox" className="md:hidden" onClick={() => setPeer(null)}><ArrowLeft /></Button><div className="min-w-0 flex-1"><h2 className="truncate font-semibold">{peer.display_name}</h2><p className="truncate text-xs text-muted-foreground">@{peer.discord_name}</p></div><Button variant="ghost" size="icon" title={thread.data?.blockedByMe ? "Unblock user" : "Block user"} aria-label={thread.data?.blockedByMe ? "Unblock user" : "Block user"} disabled={busy || !thread.data} onClick={async () => { setBusy(true); try { await blockFn({ data: { accessToken: token, peerId: peer.discord_user_id, blocked: !thread.data?.blockedByMe } }); await thread.refetch(); } catch (value) { fail(value); } finally { setBusy(false); } }}>{thread.data?.blockedByMe ? <ShieldCheck /> : <ShieldBan />}</Button></div>
              <div className="h-[min(52dvh,600px)] min-h-64 overflow-y-auto px-4 py-5 sm:px-6" aria-label="Messages">
                {thread.isPending && <p className="text-sm text-muted-foreground">Loading messages…</p>}
                {thread.error && <p role="alert" className="text-sm text-destructive">{thread.error.message}<Button variant="ghost" onClick={() => void thread.refetch()}>Retry</Button></p>}
                {thread.data?.hasMore && more && <Button variant="ghost" className="mb-4 w-full" disabled={busy} onClick={async () => { const first = messages[0]; if (!first) return; setBusy(true); try { const page = await threadFn({ data: { accessToken: token, peerId: peer.discord_user_id, before: first.created_at } }); setOlder((current) => [...page.messages, ...current]); setMore(page.hasMore); } catch (value) { fail(value); } finally { setBusy(false); } }}>Earlier messages</Button>}
                {thread.data && !messages.length && <p className="py-12 text-center text-sm text-muted-foreground">No messages yet. Say hello.</p>}
                {messages.map((message) => <div key={message.id} className={`mb-4 flex flex-col ${message.sender_id === inbox.data.me?.id ? "items-end" : "items-start"}`}><p className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-4 py-3 text-sm [overflow-wrap:anywhere] ${message.sender_id === inbox.data.me?.id ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}>{message.body}</p><time className="mt-1 text-[11px] text-muted-foreground" dateTime={message.created_at}>{time(message.created_at)}</time></div>)}<div ref={bottom} />
              </div>
              <form className="mt-auto flex items-end gap-2 border-t border-border p-4" onSubmit={(event) => { event.preventDefault(); void send(); }}><textarea aria-label="Message" placeholder={thread.data?.blocked ? "Messaging unavailable" : "Write a message…"} className="field min-h-11 max-h-40 min-w-0 resize-y focus:field-focus" rows={2} maxLength={2000} disabled={!thread.data || thread.data.blocked} value={text} onChange={(event) => setText(event.target.value)} /><Button size="icon" className="size-11 shrink-0" aria-label="Send message" disabled={busy || !text.trim() || !thread.data || thread.data.blocked}><Send /></Button></form>
            </> : <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center"><MessageCircle className="size-12 text-primary" /><h2 className="text-xl font-semibold">A little closer, on Zora</h2><Button variant="outline" onClick={() => setSearching(true)}><Plus />New message</Button></div>}
          </div>
        </section>
      )}
    </main>
  );
}