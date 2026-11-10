<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Inbox identity is verified server-side using the existing Discord OAuth cookie or Embedded SDK access token; service-only chat tables must never be queried directly from the browser, to keep messages private.
- Inbox uses its own /inbox route with visibility-aware polling; preserve the creator at / and never send in-app messages through Discord DMs.
- Creator workspace sections use local view state so switching among editor, library and settings preserves the current draft; saved-preset actions reuse existing authenticated functions.
- Shared StudioNav keeps creator and inbox navigation consistent; preset library presentation stays separate from account storage and mutations.
- Pending profile-table types are defined locally in profile functions rather than modifying generated Cloud types; server identity checks and queries remain unchanged.
