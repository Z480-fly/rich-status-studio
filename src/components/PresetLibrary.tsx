import { useMemo, useState } from "react";
import { Check, Copy, FolderHeart, MoreHorizontal, Pencil, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PRESETS, verbFor, type Preset } from "@/lib/presence";
import type { SavedPreset } from "@/lib/presets.functions";

const TILE_HUES = ["bg-chart-1/15", "bg-chart-2/15", "bg-chart-3/15", "bg-chart-4/15", "bg-chart-5/15"];

function tileHue(id: string): string {
  let sum = 0;
  for (const ch of id) sum += ch.charCodeAt(0);
  return TILE_HUES[sum % TILE_HUES.length];
}

type Props = {
  saved: SavedPreset[]; loading: boolean; linked: boolean; busy: boolean;
  selectedId: string | null; templateId: string;
  onApply: (preset: SavedPreset) => void; onTemplate: (id: string) => void;
  onDuplicate: (preset: SavedPreset) => void; onDelete: (id: string) => void;
  onConnect: () => void;
};

export function PresetLibrary(props: Props) {
  const [collection, setCollection] = useState<"saved" | "templates">("saved");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("az");
  const [remove, setRemove] = useState<SavedPreset | null>(null);
  const items = useMemo(() => {
    const source: (SavedPreset | Preset)[] = collection === "saved" ? props.saved : PRESETS;
    const query = search.trim().toLocaleLowerCase();
    const filtered = source.filter(p => `${p.name} ${p.draft.details} ${p.draft.state}`.toLocaleLowerCase().includes(query));
    return sort === "az" ? [...filtered].sort((a,b) => a.name.localeCompare(b.name)) : filtered.reverse();
  }, [collection, props.saved, search, sort]);
  return <section className="py-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><h2 className="text-2xl font-semibold">Preset library</h2><p className="mt-1 text-sm text-muted-foreground">{props.saved.length} saved · {PRESETS.length} templates</p></div>
      <div className="flex rounded-lg bg-secondary p-1" aria-label="Preset collection">
        <Button variant={collection === "saved" ? "outline" : "ghost"} onClick={() => setCollection("saved")}><FolderHeart />My presets</Button>
        <Button variant={collection === "templates" ? "outline" : "ghost"} onClick={() => setCollection("templates")}>Templates</Button>
      </div>
    </div>
    <div className="my-6 flex gap-3">
      <label className="relative min-w-0 flex-1"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><input className="field h-11 pl-10 focus:field-focus" aria-label="Search presets" placeholder="Search presets…" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <select aria-label="Sort presets" className="field h-11 w-32 shrink-0" value={sort} onChange={e => setSort(e.target.value)}><option value="az">Name A–Z</option><option value="recent">Newest first</option></select>
    </div>
    {collection === "saved" && !props.linked ? <div className="library-empty"><FolderHeart className="size-8 text-primary" /><h3 className="font-semibold">Your own collection</h3><Button variant="outline" onClick={props.onConnect}>Link Discord account</Button></div>
      : collection === "saved" && props.loading ? <p className="py-12 text-muted-foreground">Loading your presets…</p>
      : !items.length ? <div className="library-empty"><FolderHeart className="size-8 text-muted-foreground" /><h3 className="font-semibold">{search ? "No matching presets" : "No saved presets yet"}</h3><Button variant="outline" onClick={() => { setSearch(""); setCollection("templates"); }}>Browse templates</Button></div>
      : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{items.map(preset => {
        const selected = collection === "saved" ? props.selectedId === preset.id : !props.selectedId && props.templateId === preset.id;
        return <article key={preset.id} className={`preset-tile relative flex min-w-0 flex-col rounded-lg border p-4 ${selected ? "border-primary bg-primary/5" : "border-border bg-card"}`}>
          <div className="mb-4 flex items-center justify-between"><span className={`flex size-11 items-center justify-center rounded-lg text-2xl ${tileHue(preset.id)}`}>{preset.emoji}</span>{selected && <Check className="size-4 text-primary" />}
            {collection === "saved" && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Options for ${preset.name}`} title="Preset options"><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => props.onApply(preset)}><Pencil />Edit / rename</DropdownMenuItem><DropdownMenuItem disabled={props.busy} onSelect={() => props.onDuplicate(preset)}><Copy />Duplicate</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive focus:text-destructive" disabled={props.busy} onSelect={() => setRemove(preset)}><Trash2 />Delete</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
          </div>
          <h3 className="break-words text-base font-semibold">{preset.name}</h3><span className="mt-1 text-xs text-primary">{verbFor(preset.draft.type)}</span><p className="mt-3 truncate text-sm text-muted-foreground">{preset.draft.details || "Custom status"}</p><p className="mt-1 truncate text-xs text-muted-foreground">{preset.draft.state || "—"}</p>
          <Button className="mt-5 w-full" variant={selected ? "secondary" : "outline"} onClick={() => collection === "saved" ? props.onApply(preset) : props.onTemplate(preset.id)}>{selected ? "Edit preset" : "Use preset"}</Button>
        </article>;
      })}</div>}
    <AlertDialog open={Boolean(remove)} onOpenChange={open => { if (!open) setRemove(null); }}><AlertDialogContent className="w-[calc(100%-2rem)] rounded-lg"><AlertDialogHeader><AlertDialogTitle>Delete preset?</AlertDialogTitle><AlertDialogDescription>“{remove?.name}” will be removed from your saved presets.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (remove) props.onDelete(remove.id); }}>Delete preset</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}