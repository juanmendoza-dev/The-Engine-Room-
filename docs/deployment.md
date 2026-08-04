# Deployment & Branch Workflow

How The Engine Room gets from a local edit to the live site.

**Short version:** every piece of work happens on its own branch, opens a PR,
gets a Vercel preview URL, then squash-merges into `main`. `main` is wired to
Vercel Production, so anything merged is live within a minute or two. Nobody
commits straight to `main`.

---

## 0. One-time: reattach this clone to GitHub

Only needed if `git remote -v` is empty in your working copy (the original
local folder was a separate `git init`, not a clone — it holds the same files
but none of the history). Check first:

```sh
git remote -v          # if this prints an origin, skip this whole section
```

To fix it in place without touching your working files:

```sh
git remote add origin https://github.com/juanmendoza-dev/The-Engine-Room-.git
git fetch origin
git branch main origin/main        # create local main pointing at the real history
git symbolic-ref HEAD refs/heads/main   # switch HEAD, leaves the worktree alone
git reset                          # rebuild the index from HEAD (does NOT touch files)
git status                         # should be clean, or show only genuinely new files
```

`git reset` with no arguments is mixed-mode — it only rewrites the index, never
the working tree, so nothing on disk is overwritten. If `git status` afterwards
shows unexpected modifications, diff them before committing; that means the
local copy drifted from what's on `main`.

Then the per-clone hook setup from AGENTS.md, which is never tracked by git:

```sh
git config core.hooksPath .githooks
```

The alternative (clone fresh into a new folder and copy uncommitted work over)
also works and is arguably simpler — but it means re-doing `core.hooksPath` and
losing the local `.env.local` if one exists.

### Signing key for this repo

Also per-clone, and easy to get wrong. This repo signs with the
`id_ed25519_polyquant` key, set as a **local** override:

```sh
git config user.signingkey C:/Users/juanm/.ssh/id_ed25519_polyquant.pub
git config --show-origin --get user.signingkey   # must say file:.git/config
```

Why not just use the global default: the global `~/.gitconfig` points at
`id_ed25519_sign.pub`, and that key is **not registered on the GitHub account**
as a signing key. Commits signed with it verify perfectly on this machine but
land on GitHub as "Unverified" with reason `unknown_key`. The polyquant key is
registered *and* matches the `juanmendoza6159@gmail.com` commit email, which is
what GitHub actually checks.

(The key that signed commits `bf89441`–`0f6f7ef`, registered as "The Engine Room
(claude)", no longer has a private half anywhere on disk. Don't go looking for
it — it can't be reused.)

### The pre-push hook does not guarantee a Verified badge

Worth understanding, because it's a silent failure. `.githooks/pre-push` runs
`git verify-commit`, which checks the signature against your local
`~/.ssh/allowed_signers` file. GitHub checks something different: whether the
signing key is registered on the account and the committer email is verified
there. A key can be in `allowed_signers` but not on GitHub — the hook passes,
the push succeeds, and the commit shows Unverified.

So after your first push in a new clone, confirm it for real:

```sh
gh api repos/juanmendoza-dev/The-Engine-Room-/commits/<sha> \
  --jq '.commit.verification'
```

Want `verified=true, reason=valid`. If you get `unknown_key`, fix
`user.signingkey`, then `git commit --amend --no-edit` (re-signs with the new
key) and `git push --force-with-lease`.

---

## 1. Branch workflow

### Naming

Same scheme as Trojan-Troy, prefix by intent:

| Prefix   | For                                      |
| -------- | ---------------------------------------- |
| `feat/`  | new functionality                        |
| `fix/`   | bug fixes                                |
| `docs/`  | docs only                                |
| `chore/` | deps, config, repo housekeeping          |
| `ci/`    | build/deploy pipeline                    |

For build-plan work, put the task number in the slug so two agents can't
silently pick the same task:

```
feat/01-scaffold-nextjs
feat/02-stockfish-spike
feat/03-maia-onnx-spike
feat/04-engine-registry
```

### The loop

```sh
git checkout main
git pull --ff-only origin main         # always start from current main
git checkout -b feat/07-board-component

# ...work, committing small and often per AGENTS.md...
git push -u origin feat/07-board-component

gh pr create --fill                     # Vercel comments a preview URL on the PR
```

Then check the preview URL actually works, and merge:

```sh
gh pr merge --squash --delete-branch
git checkout main && git pull --ff-only origin main
```

Squash-merging through GitHub means GitHub signs the resulting commit, so `main`
stays fully "Verified" — the AGENTS.md signing rule holds without extra work.
If you ever merge locally instead, the merge commit gets signed by your own key
because `commit.gpgsign=true` is set; that's fine too, just don't `--no-gpg-sign`.

### Rebase, don't let branches rot

Branches should live hours, not days. If `main` moves under you:

```sh
git fetch origin
git rebase origin/main
git push --force-with-lease
```

Rebase rewrites commits, which re-signs them automatically (again, because
`commit.gpgsign=true`). Use `--force-with-lease`, never a bare `--force`.

### Who can work in parallel

The build plan's tasks aren't all independent. Dependency waves, so multiple
agents can run at once without stepping on each other:

| Wave | Tasks                  | Notes                                          |
| ---- | ---------------------- | ---------------------------------------------- |
| 1    | Task 1 (scaffold)      | Must land on `main` alone before anything else — every other task imports from it |
| 2    | Tasks 2, 3, 5, 7       | Four agents in parallel; no shared source files |
| 3    | Task 4, then Task 6    | 4 needs 2 + 3 merged; 6 needs 4                |
| 4    | Task 8, then Task 9    | 9 edits the file 8 creates                     |
| 5    | Tasks 10 and 11        | Both only need 9; parallel                     |

**Conflict hotspot: `package.json` / `package-lock.json`.** Tasks 2, 3, 7, and 9
all add dependencies. Never hand-merge `package-lock.json` — on conflict, take
`main`'s copy and regenerate:

```sh
git checkout --theirs package-lock.json   # during a rebase, "theirs" is your branch's side; check which you want
git checkout origin/main -- package-lock.json package.json
npm install <the-package-your-branch-adds>
git add package.json package-lock.json
```

Also: the spec says work stops after each phase (0, 1, 2, 3) for a check-in.
Phase boundaries are check-in gates, not merge gates — merge each task as it's
done, then pause at the phase end.

---

## 2. Vercel project setup

**Live production URL: https://the-engine-room-gold.vercel.app** — deployed from
`main`, confirmed serving `200` with `x-vercel-cache: PRERENDER` out of `iad1`.

All of this is dashboard work on the account side.

**Do this after Task 1 is merged**, not before. Vercel's import step sniffs the
repo for a framework, and right now there's no `package.json` on `main` — the
first build would just fail. Once the Next.js scaffold is on `main`, import is
one click and auto-detects everything.

1. vercel.com → log in with GitHub (`juanmendoza-dev`).
2. **Add New → Project** → import `The-Engine-Room-`.
3. Confirm the detected settings — for a stock `create-next-app` these should
   all be correct already and need no edits:
   - Framework Preset: **Next.js**
   - Root Directory: `./`
   - Build Command / Install Command: defaults
4. **Settings → Git → Production Branch** must be `main`. It defaults to the
   repo's default branch, which is already `main`, so this is a verify step.
5. Leave automatic deployments on. That gives you exactly the behavior you
   want:
   - push/merge to `main` → **Production** deploy → the live site updates
   - push to any other branch → **Preview** deploy at its own URL
   - open a PR → Vercel bot comments the preview URL on the PR
6. Confirm `.vercel` is in `.gitignore` (create-next-app's generated ignore
   file normally includes it — verify rather than assume).

### If preview URLs ask you to log in

That's Deployment Protection, which Vercel turns on for previews by default on
new projects. **Settings → Deployment Protection** — turn it off for previews if
you want to share a branch link with someone who isn't on the account.
Production stays public either way, so the demo link for judges is unaffected.

### Build queuing

The Hobby plan runs builds one at a time. With four agents pushing at once in
wave 2, expect preview builds to queue rather than run simultaneously. Not a
problem, just don't read a queued build as a hung one.

### Node version

Local is Node v24; Vercel pins to whatever LTS it currently offers. Leave the
default. Only if a build errors on the Node version, set it explicitly under
**Settings → Node.js Version** — and don't add an `engines` field to
`package.json` to force it, that tends to cause more problems than it solves.

---

## 3. KV storage (Task 9) — currently OFF, running on a localStorage fallback

**State of the world (2026-08-04): no KV store has ever been provisioned for
this project.** Task 9 shipped anyway, behind an adapter: game records go to
the browser's localStorage (per-browser, capped at 50, newest pruned last), and
`/history` reads whichever adapter is active. The site is fully demo-able with
zero provisioning — a visitor just sees *their own* games, and the history page
says so. The Vercel KV adapter is already written and wired
(`app/actions/games.ts`); it's dormant until one env flag flips.

How the switch works: `lib/games/store.ts` branches on
`NEXT_PUBLIC_KV_ENABLED === "1"`. It has to be a `NEXT_PUBLIC_` var because the
branch also runs in the browser, where server-only env vars don't exist —
Next.js inlines `NEXT_PUBLIC_*` values **at build time**. Two consequences:
setting the flag requires a **redeploy** (a rebuild, not a restart) to take
effect, and the flag's value is baked separately into each environment's build.

### Turning real KV on (owner checklist, no code changes)

1. Vercel dashboard → this project → **Storage** → create/connect an **Upstash
   for Redis** store (the Marketplace integration — "Vercel KV" as a standalone
   product was folded into this; same thing functionally).
2. Connect it to the project for Production, Preview, and Development. Vercel
   injects REST credentials. Depending on which integration flow you land in
   the names are `KV_REST_API_URL`/`KV_REST_API_TOKEN` **or**
   `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` — read them off the
   dashboard. **The code accepts either pair** (`app/actions/games.ts` checks
   both), so no renaming is needed.
3. Project → **Settings → Environment Variables** → add
   `NEXT_PUBLIC_KV_ENABLED` = `1` for Production, Preview, and Development.
4. **Redeploy** (any push, or dashboard → Redeploy). Build-time inlining means
   the flag does nothing until a fresh build ships.
5. Verify: play one Model 1v1 game to the end on the live site, open
   `/history` — the page header should now read "Shared archive", not "Local
   ledger", and the game should appear for a *different* browser too. The KV
   adapter had never run against a real store before this moment, so treat
   this check as mandatory, not paranoia.
6. For local dev against the same store:

```sh
npx vercel link
npx vercel env pull .env.local
```

   then make sure `.env.local` also contains `NEXT_PUBLIC_KV_ENABLED=1` (env
   pull brings it once step 3 is done). `.env*` is gitignored by the Next
   scaffold — verify that's true before the first commit that touches env
   files, and never commit real tokens.

Games logged to localStorage before the flip stay in whatever browser wrote
them; there's no migration (deliberate — they're throwaway demo records).

**One store or two?** Recommendation for this build: **one store shared across
production and preview.** It's the least setup, and games logged from a preview
deploy simply show up in the same history list. The tradeoff is that test games
played on a branch pollute the production history page — acceptable for a
hackathon demo. If that bothers you later, create a second store and scope it to
the Preview environment only.

---

## 4. App-specific things that bite on Vercel

Grouped here so whoever picks up the relevant task doesn't rediscover them.

**Binary assets and Windows line endings (Task 2, Task 3).** Git on Windows can
mangle binaries if it decides they're text. Before committing any `.wasm` /
`.onnx` / `.nnue`, add to `.gitattributes`:

```
*.wasm binary
*.onnx binary
*.nnue binary
```

**Check binary file sizes before committing (Task 2).** Some Stockfish NNUE wasm
builds are large. GitHub warns over 50 MB per file and hard-rejects over 100 MB.
Run `ls -lh` on the files before `git add`. If one is too big, pick a smaller
build rather than reaching for Git LFS — Vercel does not fetch LFS objects
during a build by default, so LFS-tracked static assets can arrive as pointer
text files and break at runtime in a way that works fine locally.

**No COOP/COEP headers needed.** The spec deliberately chose the
single-threaded Stockfish build to avoid `SharedArrayBuffer`, so `next.config.ts`
needs no custom headers. If anyone ever swaps in the multi-threaded build, that
changes — cross-origin isolation headers become mandatory.

**onnxruntime-web wasm paths (Task 3).** onnxruntime-web loads its own `.wasm`
files at runtime and doesn't always resolve them correctly under a bundler.
If it 404s on Vercel, the fix is copying its wasm assets into `public/` and
setting `ort.env.wasm.wasmPaths` to that path.

**The history page and prerendering (Task 11).** An earlier version of this
note said `app/history/page.tsx` must set `export const dynamic =
"force-dynamic"`. That advice was written for the original design (an async
server component reading KV at request time) and **does not apply to the page
as built**: it's a `"use client"` component that fetches through the storage
facade in a `useEffect`, because the default localStorage adapter only exists
in the browser. Next statically prerenders an empty shell with no game data in
it, so there's nothing to go stale — do not add `force-dynamic` to it. The
caveat comes back if anyone reshapes it into a server component (or server
shell) that reads KV directly: *that* file would need `force-dynamic`, for
exactly the reasons the old note gave (no KV during build / baked-in stale
list).

**Don't let `next dev` edit AGENTS.md.** `next.config.ts` sets
`agentRules: false` deliberately. Without it, Next 16's dev server appends a
`<!-- BEGIN:nextjs-agent-rules -->` block to `AGENTS.md` on every single run, and
deleting the block only makes it come back. Across parallel branches that's the
same phantom diff on every one of them. If you ever see that block appear,
someone removed the config option — put it back rather than committing the block.

**`background-clip: text` and the `background` shorthand.** No longer live —
the 2026-08-04 "Ink & Bone" redesign removed all gradient-clipped text (the
headline is hollow via `-webkit-text-stroke` now). Kept because the trap is
real if gradient text ever returns: keep each element's `background-clip` in
the *same* rule as its `background`, after it — `background` is a shorthand
that resets `background-clip` to `border-box`, so factoring the clip into a
shared rule and overriding the gradient later silently un-clips the text and
paints the whole element as a solid block. Was hit once under the old design.

**`next dev` can outlive whatever launched it.** On Windows, killing the shell or
task that ran `npm run dev` doesn't reliably kill the node process — it keeps
holding port 3000 and the next `next dev` refuses to start with "Another next dev
server is already running" (it helpfully prints the PID). Confirm with
`netstat -ano | grep :3000`, then `taskkill //PID <pid> //F` from Git Bash. Worth
knowing before you conclude a code change "didn't take": you may be reading a
stale server.

**Engines run client-side.** Both engine wrappers execute in the browser, so
there's no serverless function timeout or cold-start risk on the engine path at
all. The only server-side code in the whole app is the two KV Server Actions.

**Headless-Chrome (CDP) verification traps (Task 10).** Things that cost
time when driving the app with the `scripts/cdp-*.mjs`-style harnesses:

- `Page.navigate` can return a normal-looking result and leave the tab parked
  on `about:blank` — and not only for `localhost` URLs (the comment in
  `cdp-model-1v1.mjs` blames `localhost`; it happened on `127.0.0.1` too).
  Reliable recipe: pass the target URL as Chrome's launch argument so the tab
  starts there, and/or re-issue `Page.navigate` in a loop until
  `location.href` actually reports the target.
- Killing a headless Chrome (`taskkill //F`) leaves its `--user-data-dir`
  holding a ProcessSingleton lock, and the next launch with the same profile
  dir **aborts silently** ("Lock file can not be created" only appears in the
  log). Use a fresh profile dir per run rather than fighting the lock.
- Interactive boards are drivable without Playwright: react-chessboard v5's
  drag is dnd-kit's PointerSensor (1px activation distance), which accepts
  `Input.dispatchMouseEvent` — mousePressed, a few interpolated mouseMoved
  steps, mouseReleased — on the `[data-square="…"]` elements. And React
  ignores `.value =` on a controlled `<select>`; use the native value setter
  plus a bubbling `change` event.
- **Measure both ends of a drag in one `Runtime.evaluate`, at one scroll
  position.** A `squareCenter(sq)` helper that calls
  `scrollIntoView({block:"center"})` before reading `getBoundingClientRect()`
  gives you `from` and `to` measured at *different* scroll offsets, because
  centring the destination scrolls the page a rank's worth after `from` was
  read. The `mousePressed` then lands ~48px off — on an empty square — so no
  drag starts and the move silently never happens. It looks like the app
  rejecting a legal move, which sends you hunting a bug that isn't there.
  What makes it nasty: early in a game the page is short enough that
  `scrollIntoView` is clamped and both reads agree, so drags work; the move log
  grows the page (1272px in a 485px headless viewport by ply 36), scrolling
  becomes possible, and *then* every drag between two ranks starts missing.
  Cost this the first production run of /user-1v1: ~100 identical rejected
  drags in a position where only two legal moves existed. Fix is one evaluate
  returning both centres.
- **Don't assert on animation state sampled from Node on a wall-clock delay.**
  `await sleep(140)` then `Runtime.evaluate` does *not* read the page at 140ms:
  the round trip against a busy headless Chrome can land hundreds of ms late, so
  a probe aimed at the middle of a ~1.2s transition reads one that has already
  finished and reports a broken feature that isn't broken. The fix is to invert
  it — inject a `requestAnimationFrame` sampler that timestamps itself with
  `performance.now()` into an array on `window` *before* triggering the thing,
  then read the whole array back afterwards in one evaluate. Slow CDP then only
  delays when you read the log, never what's in it. `scripts/cdp-press.mjs`
  splits its two passes (`measureCase` asserts off the log, `captureCase` only
  screenshots) for exactly this reason. Bonus: the sampler survives
  `router.push`, since client-side navigation keeps the same JS context — so one
  recording covers before, during, and after the route swap.
- **Two Chrome instances can both hold `--remote-debugging-port=9222`** (one on
  IPv4, one on IPv6) when agents work in parallel, and `/json/list` over
  `127.0.0.1` hands you whichever bound IPv4 — possibly another agent's browser.
  Symptom: console errors from an origin your script never visited (a run on
  `:3100` reporting a CORS failure from `127.0.0.1:3000`). Pick a per-run port
  and a fresh profile dir rather than assuming 9222 is yours.
- None of this works against a **preview** deployment as long as Deployment
  Protection (§2) is on: every preview URL 302s to Vercel SSO for anonymous
  fetchers, and there are no Vercel credentials on this machine (`~/.vercel`,
  `AppData/Roaming/com.vercel.cli` — nothing). PR #8 hit the same wall. So
  "verify the preview" is only possible after someone with dashboard access
  turns preview protection off or shares a Protection Bypass for Automation
  secret; until then the strongest available check is the local production
  build plus Vercel's own green build status.

---

## 5. Optional: protect `main`

With multiple agents pushing, a light guardrail is worth it. GitHub → **Settings
→ Rules / Branch protection** on `main`:

- Require a pull request before merging
- Require the Vercel status check to pass (only selectable after the first
  deploy exists)

Recommendation: turn both on, but leave bypass enabled for yourself so you can
hotfix during a demo without fighting the tooling. What this actually buys you
is that no agent can push a broken build straight to the production site.
