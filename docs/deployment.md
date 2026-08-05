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

If you can't open the preview, don't stall the PR waiting for permission —
**every preview URL 302s to Vercel SSO** while Deployment Protection is on, and
there are no Vercel credentials on this machine. That's expected, not a problem
with your branch. §4 has the details and the standing answer: the accepted
substitute is a local production build (`next build` + `next start`) driven to a
real result, plus Vercel's own green build status on the PR. Two PRs sat open
overnight because that wasn't written here.

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

### Cleaning up after a merge

Two traps here, and the first one is in the merge command this doc recommends
three paragraphs up.

**`--delete-branch` fails if the branch is checked out in a linked worktree.**
You get `'main' is already used by worktree at ...` and a non-zero exit. The
*server-side merge already succeeded* — only `gh`'s local cleanup step failed. Do
not re-run the merge. Just finish the cleanup by hand:

```sh
git worktree remove ../engine-room-<lane>   # refuses if there's uncommitted work
git branch -D <branch>
git push origin --delete <branch>
```

`git worktree remove` is the safe primitive: it declines rather than deleting
anything if the worktree is dirty, so use it instead of `rm -rf`.

**Squash-merging means git can't tell you what's merged.** The squash commit on
`main` is a brand-new object that shares no ancestry with the branch it came
from, so `git branch --merged` lists nothing, `git merge-base --is-ancestor`
says "not merged", and every landed branch looks unmerged forever. That's how
this repo accumulated seven stale local branches and five worktrees in a day.
Check the *content* instead — and `gh pr list --state all` is the real authority
on what landed:

```sh
git diff --stat origin/main <branch>   # only "deletions" = branch is behind, nothing unique
git log --all --not origin/main --oneline --decorate   # everything genuinely unlanded
```

If a branch shows insertions in that first diff, it still has content of its own
— find out what before deleting it. Deleted branch tips stay in the reflog for
90 days, so `-D` is recoverable, but reading the diff first is cheaper.

**Why it's worth doing at all:** a branch that's really merged is just noise, but
a branch that only *looks* merged is a trap. Splitting one branch into two and
pushing only one half cost this project a live-site fix overnight — the marquee
kept claiming a backend we don't have because the second half never got pushed.
When you split a branch, push both halves before you stop for the day.

### One clone, two agents: your commits can land on someone else's branch

`git checkout` is repo-global, not per-process. If another agent switches branches
in the clone you're working in, your *next* commit goes to **their** branch, and
nothing warns you. This is not hypothetical — Task 13's docs commit landed on
`feat/14-maia-rollouts`, and the `git push -u origin feat/13-bayesian-rating`
immediately after it reported `* [new branch]` and exited 0 while pushing a tip
that didn't contain the commit, because the local ref had stopped moving one
commit earlier.

That's the nasty part: **the push looks like it worked.** The only thing that
catches it is comparing the two directly.

```sh
git rev-parse HEAD                                           # what you think you pushed
git ls-remote origin refs/heads/<branch> | awk '{print $1}'   # what's actually there
git branch -vv                                               # and which branch you're really on
```

Fix it without disturbing the other agent's working tree. Both of these operate on
refs and need no checkout:

```sh
git push origin <sha>:refs/heads/<branch>   # fast-forward, if <sha>'s parent is the old tip
git branch -f <branch> <sha>                # safe: not the checked-out branch
```

**Do not `git checkout` to fix this.** The other agent may have uncommitted work in
files that differ between the two branches — switching under them turns one
stranded commit into a lost afternoon. Same reason to prefer
`git fetch origin main:main` over `git checkout main && git pull`: it updates the
local ref without touching the tree.

Two follow-on consequences:

- **A branch cut from another agent's in-flight branch inherits its commits.**
  `feat/14-maia-rollouts` was created from `feat/13-bayesian-rating`'s tip instead
  of from `main`, so it carried four of Task 13's commits. Once Task 13
  squash-merged, those commits exist on `main` only as one new object sharing no
  ancestry with them — so that branch looks like it still has unique content
  forever, which is the same trap as "Squash-merging means git can't tell you
  what's merged" below, arrived at from the other direction. Rebase onto `main`;
  don't trust the diff.
- **Skip `gh pr merge --delete-branch` in a shared clone.** It deletes the local
  branch as well as the remote one, and doing that can mean checking out the
  default branch first — which in a shared clone is someone else's working tree.
  Not verified here, because the right move was to avoid finding out. Merge
  without it and clean up by hand:

```sh
gh pr merge <n> --squash
git fetch origin main:main       # local main, no checkout
git push origin --delete <branch>
git branch -D <branch>
```

**Or just don't share the clone.** `git worktree add ../engine-room-<lane> -b
<branch> main` gives each lane its own checkout with its own HEAD, and a linked
worktree inherits `.git/config` — so `core.hooksPath` and `user.signingkey`
carry over and commits still sign correctly without repeating the per-clone
setup. That's how this very section was written while another agent held the main
worktree. Remove it with `git worktree remove` when done (it refuses if dirty,
which is the point).

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
3. Confirm the detected settings:
   - Framework Preset: **Next.js**
   - Root Directory: **`web`** — see the box below, this one is not the default
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

### Root Directory must be `web`, not `./`

The Next app lives in `web/`, not at the repo root. There is no `package.json`,
`next.config.ts` or `tsconfig.json` at the top level, so a build with Root
Directory left at `./` fails at framework detection before it compiles anything.

Why the app is in a subdirectory at all: those config files can't be relocated
one at a time. Next and npm resolve them from whatever directory the build runs
in, and Next *writes* to two of them (it injects a plugin entry into
`tsconfig.json` and regenerates `next-env.d.ts`). So the unit that moves is the
whole project, which is also why Trojan-Troy has `client/` and `server/`.

Two consequences worth knowing:

- **Every command in this doc runs from `web/`**, not the repo root — `npm
  install`, `npm run build`, `npm run start`, and anything touching
  `web/public/`. `docs/` and the git hooks stay at the repo root.
- **`.gitignore` patterns must not be root-anchored.** The scaffold shipped
  `/node_modules`, `/.next/`, `/out/` and `/build` with leading slashes, which
  only match at the repo root and silently stopped matching once the app moved
  down a level — `web/node_modules` would have been committed. They're
  unanchored now. If you ever add an ignore rule, don't anchor it.

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
(`web/app/actions/games.ts`); it's dormant until one env flag flips.

How the switch works: `web/lib/games/store.ts` branches on
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
   dashboard. **The code accepts either pair** (`web/app/actions/games.ts` checks
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

**No COOP/COEP headers needed — for two different reasons now.** Stockfish uses
the single-threaded build, which never touches `SharedArrayBuffer`.
onnxruntime-web (Maia) only *ships* threaded-named binaries, so there the
guarantee is a runtime setting instead: `ort.env.wasm.numThreads = 1` in
`web/lib/chess/engineMaia.ts`. Verified against a production build:
`crossOriginIsolated` is `false`, `SharedArrayBuffer` is absent, no console
warnings, inference correct. If anyone raises `numThreads` above 1 without
adding cross-origin-isolation headers, ort logs a warning and **falls back to
single-threaded** rather than breaking — so the failure mode is a misleading
console message and no speedup, not a crash. Raising it for real means serving
COOP/COEP headers from `next.config.ts`, which would also let the
multi-threaded Stockfish build in; treat that as one decision, not two.

**onnxruntime-web wasm paths (Task 3).** onnxruntime-web loads its own `.wasm`
files at runtime and doesn't always resolve them correctly under a bundler.
If it 404s on Vercel, the fix is copying its wasm assets into `web/public/` and
setting `ort.env.wasm.wasmPaths` to that path.

Confirmed while doing Task 3, with one correction: copying the `.wasm` is
necessary but **not sufficient**. ORT also dynamically imports a matching `.mjs`
glue module — `ort-wasm-simd-threaded.jsep.mjs` alongside
`ort-wasm-simd-threaded.jsep.wasm` — so copy both. A missing `.mjs` surfaces as
`no available backend found` with every backend reporting
`previous call to 'initWasm()' failed`, which reads like an ORT/browser problem
and is really just a 404. Also set `ort.env.wasm.numThreads = 1` to stay
single-threaded and keep the no-COOP/COEP decision intact.

**The Maia model is hosted in a second repo of ours (Task 3).** `engineMaia.ts`
fetches ~93 MB at runtime from **`juanmendoza-dev/engine-room-assets`** via
`raw.githubusercontent.com`, pinned to a commit. It is not in this repo and not
on Vercel, on purpose: it would be 93 MB of git history plus ~93 MB of egress per
page load (roughly 1,000 loads against Hobby's 100 GB/month). Two rules if you
ever move it:

- **The host must send `Access-Control-Allow-Origin`.** `raw.githubusercontent.com`
  sends `*`. **GitHub Release assets do not send it at all** — they redirect to an
  Azure blob with no CORS headers, and a browser `fetch()` of one fails with a
  bare "Failed to fetch". This was tried, verified broken in a real browser, and
  abandoned; don't spend the afternoon again.
- **Never Git LFS for it.** `raw` serves LFS pointer text instead of content, so
  LFS breaks it the same way it breaks Vercel static assets (above).

**Maia's cold load is much slower on production than on localhost — plan the demo
around it.** Measured on the live site, two cold runs, click Start → first move on
the board: **73 s and 261 s**. Local `next start` on the same machine measured
23–49 s, and the review before that reported 24–29 s. Nothing regressed; the
comparison was just never like-for-like:

| | localhost | production |
| --- | --- | --- |
| Maia model (GitHub raw) | ~93 MB over the network | ~93 MB over the network |
| `ort` jsep wasm | served from disk, ~free | **~27 MB over the network** |

So a cold production visitor downloads ~120 MB, and the two transfers compete for
the same bandwidth. It's also just variable: the 261 s run and the 73 s run were
minutes apart on the same connection. Don't read a slow load as a broken one —
the progress bar keeps counting, which is exactly what it's there for.

Our mirror is **not** the cause; benchmarked against the file it replaced, ours
was faster (37.7 s vs 63.8 s for the same 93 MB).

**Demo mitigation:** open a Maia game once before anyone is watching, and don't
reload that tab. The session is a module-level singleton, so it loads once per
tab and every later game in that tab is instant. A refresh pays the full cost
again — Chrome will not disk-cache a body that size. The real fix is the
IndexedDB cache noted in `docs/maia-notes.md`; until then, treat "don't hit F5
on stage" as the operational rule.

**Copy only the jsep pair.** `onnxruntime-web` 1.27 ships five wasm/glue
variants, and it's tempting to copy the lot. Don't — the default import resolves
to the **jsep** build, so `ort-wasm-simd-threaded.jsep.wasm` + `.jsep.mjs` are
the only two ever fetched. The plain `.wasm`, plain `.mjs`, `asyncify.mjs` and
`jspi.mjs` are 13.6 MB of dead weight; verified by deleting them and re-running
`/dev/maia-test` clean. `web/public/ort/` should be 26.9 MB, two files. A further
13.4 MB is available if someone converts `engineMaia.ts` to a client-side
dynamic `import("onnxruntime-web/wasm")` — that switches it to the CPU-only
plain pair. The naive static `import … from "onnxruntime-web/wasm"` does **not**
work: it fails `next build` with `ERR_INVALID_URL` during prerender, because
that bundle resolves its own URL at module scope.

**`web/app/favicon.ico` must contain an RGBA PNG, or `next build` dies.** Turbopack
decodes the ICO at build time and rejects anything else with `Processing image
failed / unable to decode image data / Format error decoding Ico: The PNG is not
in RGBA format!`. Nothing in that message points at the file you just replaced.
The trap: Chrome's own PNG encoder (`Page.captureScreenshot`, `canvas.toDataURL`)
drops the alpha channel when every pixel is opaque, so a screenshot-derived
favicon with a solid background is RGB and fails, while the same icon with one
transparent pixel would have passed. `web/scripts/make-icons.mjs` sidesteps it by
reading raw RGBA off a canvas and encoding the PNG itself (~40 lines, zlib is in
Node). Check any hand-made icon with `file web/app/favicon.ico` — you want
`8-bit/color RGBA`, not `8-bit/color RGB`.

**Next 16 snapshots `web/public/` at build time.** Files added to `web/public/` *after*
`next build` return 404 from `next start` until you rebuild. This bites whenever
you copy engine assets in as a separate step from the build — the app looks
broken at runtime for a reason that has nothing to do with your code. Rebuild
after adding anything to `web/public/`.

**The history page and prerendering (Task 11).** An earlier version of this
note said `web/app/history/page.tsx` must set `export const dynamic =
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

**This app's server-rendered HTML is a bad oracle for "did my deploy land?"**
`curl | grep` is the obvious way to check the live site from a terminal, and on
this app it will lie to you in both directions. Cost an agent ~15 minutes and
prompted an unnecessary production redeploy, so it's worth the words:

- **Client-only UI isn't in the HTML at all.** The header scoreboard
  (`web/components/HeaderScoreboard.tsx`) renders `null` on the server on purpose —
  it reads `web/lib/boardFeed.ts`, and no board has published anything until a page
  hydrates. So `grep er-turn` returns 0 on a *correct* deploy. Anything fed by
  the board feed has the same property.
- **Don't grep a string that also appears elsewhere on the page.** The old
  header badge said "engines coupled" — and so did a marquee item, three
  elements down. Grepping for it matched the new build too, which read as "the
  deploy is stale" when it had actually shipped. (That marquee line is gone now,
  which kills this specific case but not the mistake.)
- **What actually works:** pick a marker that existed *only* in the build you're
  replacing and that you deleted — `er-live-dot` was the discriminator here.
  Confirm the expected value against your own local production build first, so
  you know what a pass looks like before you trust it on prod.
- **Better: drive the deployed URL in headless Chrome** with one of the
  `web/scripts/cdp-*.mjs` harnesses and assert on the post-hydration DOM. That's the
  only check that sees client-rendered UI, and production (unlike previews) is
  public, so it needs no credentials.

**A climbing `Age` on `X-Vercel-Cache: HIT` is not evidence of a stale deploy.**
Related trap, met at the same time. The production alias serves a cached
prerender and `Age` counts up between revalidations, which *looks* exactly like
an alias that never rotated. It isn't proof of anything about the content — check
the content with a correct oracle (above) before concluding the deploy failed.
Two things that don't help, so don't burn time on them: a query-string cache
buster does nothing (Vercel ignores query strings in the cache key for static
prerenders, so you still get `HIT`), and a `Cache-Control: no-cache` *request*
header doesn't force an edge revalidation either. And you can't diff the new
build directly — deployment-specific URLs are SSO-gated per §2.

Also worth knowing when you do drive production over the network: the waits that
work against `localhost` are too short. Hydration lands measurably later, so a
snapshot taken at 1.2s that passes locally can find no scoreboard at all on the
live site. ~4-5s before the first assertion was enough here.

**Plain Node can run this repo's TypeScript, with one catch worth knowing before
you reach for Chrome.** Node 24 strips types out of a `.ts` file on its own — no
flag, no build step, no dependency — so any module that doesn't touch `window`,
a `Worker`, or ORT can be imported straight into a `.mjs` script and checked in
seconds instead of driven through a browser for minutes. That is why Task 16's
`lib/analysis/` maths is deliberately dependency-free, and why
`scripts/verify-analysis-math.mjs` needs neither Chrome nor an engine.

The catch: Node strips *types*, it does not rewrite *import specifiers*. Our
source uses extensionless relative imports (`from "./eloModel"`), which is the
bundler convention Next configures, and plain Node's resolver wants
`./eloModel.ts` — so the import fails with `ERR_MODULE_NOT_FOUND` naming a file
that is obviously right there. `import type` lines are fine, because they get
erased before anything tries to resolve them, which makes the failure look
arbitrary. `web/scripts/ts-extension-resolver.mjs` is a ~10-line resolve hook
that retries with `.ts` appended; register it before the dynamic import and the
whole thing just works. Fixing it that way rather than by sprinkling `.ts`
extensions through the source, or turning on `allowImportingTsExtensions`
globally, keeps the workaround in the one place that needs it.

Two smaller ones from the same afternoon: Node warns
`MODULE_TYPELESS_PACKAGE_JSON` on every such import because `web/package.json`
has no `"type": "module"` (harmless — suppress with
`--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`, and do **not** add the field,
which is Next's to own), and the imported modules must avoid `enum` and
constructor parameter properties, since those aren't erasable syntax.

**Screenshots are Playwright; verification is still CDP.** `npm run shots` drives
the app in Playwright to write the README gallery into `docs/assets/`
([`docs/screenshots.md`](screenshots.md)). It replaces nothing below — the
`cdp-*.mjs` harnesses are still what proves the app works, and several of the
traps in this list bit the Playwright harness too, the drag-coordinate one
included.

**Headless-Chrome (CDP) verification traps (Task 10).** Things that cost
time when driving the app with the `web/scripts/cdp-*.mjs`-style harnesses:

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
  delays when you read the log, never what's in it. `web/scripts/cdp-press.mjs`
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
- **`localhost` and `127.0.0.1` are not interchangeable against `next dev`.**
  Next 16 treats `127.0.0.1` as a cross-origin host and blocks its own
  `/_next` dev resources, so the page server-renders perfectly — HTTP 200, all
  64 `[data-square]` elements present — and then **never hydrates**. Every click
  is a no-op and every interactive feature looks broken while the console stays
  clean. The only tell is a `Blocked cross-origin request to Next.js dev
  resource` line in the *server's* log, not the browser's. Use `localhost` (or
  set `allowedDevOrigins`). Note this is the opposite of the `Page.navigate`
  advice above, which is about Chrome, not Next — pass the URL as a launch arg
  and use `localhost` in it.
- **Squares in the DOM do not mean the page is interactive.** They're in the SSR
  HTML. Wait for React to attach instead: `Object.keys(el).some(k =>
  k.startsWith("__react"))` on a node inside the page's own tree. Half an hour
  went into "the clicks don't work" before this.
- **Connect CDP *before* the page loads, or reload once connected.** Chrome
  loads its launch-arg URL before your websocket exists, so a hydration error or
  early console message has already come and gone unheard. `Page.reload` after
  `Runtime.enable` is the cheap fix.
- **Two dev servers can't share one `.next`.** If another agent is running
  `next start` out of the repo, starting `next dev` there rewrites the manifests
  it's serving from and breaks it mid-run. Copy the source to a scratch dir and
  junction `node_modules`/`public` in — but then you must use **`next dev
  --webpack`**, because Turbopack rejects a junctioned `node_modules` outright
  ("Symlink [project]/node_modules is invalid, it points out of the filesystem
  root").
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
