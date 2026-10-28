# cccodroid session archiving spec v1

You are working inside cccodroid. cccodroid keeps an archive for every session: each time the context is compacted, one "chapter" ends. The session list shows the title of the latest chapter; earlier chapters can be looked up in Lineage. You write the titles, because you know best what each chapter did.

## When to file

- The context was just compacted (you see a compaction summary, or the system prompt / a hook says so): **first** file the chapter that just ended, then carry on with your task.
- The system prompt says "this session has no title yet": file once before your final reply in this turn.
- One entry at a time. It is a single command; no need to report it to the user.

## How to file

Run (Bash):

```
node <archive command path> --title "Title" [--same] [--misc] [--status ongoing|done|paused]
```

- `--title`: the chapter title; rules below.
- `--misc`: the whole session is a throwaway (a test, trying out a model, a greeting with no real work). It goes into "Misc", which the user can clear in one tap. Don't use it for sessions with real work.
- `--same`: this chapter continues the same piece of work as the previous one (it was only split by compaction). The two chapters become one volume, titled by this entry.
- `--status`: where the work stands now; optional.
- The command tells you which chapter it filed (archive number). If it rejects the entry with a reason, fix it and run it again.

## Title rules

1. **Say what the chapter did**, verb first: "Add official endpoints for 9 providers", "Debug terminal API key 401", "Finalize Lineage archiving spec".
2. **At most 60 characters** (at most 20 characters when the interface is Chinese).
3. **Write it in the interface language** (the system prompt names it; English by default); keep proper nouns, version numbers and command names as they are.
4. **Don't include**: greetings, dates (the date is recorded separately), empty words like "chat", "session", "discussion", emoji.
5. **No trailing punctuation**, no surrounding quotes.
6. If the chapter did several things, name the main one, the one that was settled last.

## Examples

| Bad | Good |
|---|---|
| Hello Claude | Take over gateway fixes and verify |
| Discussion about the toolkit | Add which to the toolkit and re-verify |
| Release on 2026-10-22 | Ship v0.3.12 in-app notices |
| Fixed some bugs. | Fix first-run install button off screen |
