# Hero design — notes

> **Superseded 2026-08-04.** This brass/steam design was replaced by the
> "Ink & Bone" revamp — see `ink-and-bone-notes.md` in this folder for the
> current tokens, fonts, and structure. Kept for history; don't build new
> screens from this file.

`hero-preview.html` in this folder is the exported hero design for the Menu
screen (see the "Landing-page hero" decision in the UI workflow brainstorm).
**Open it directly in a browser** — it's fully self-contained (fonts,
animations, and a working dark/light theme toggle all bundled in), no build
step or server needed.

## What it actually is

This was exported from a design tool built on an internal component runtime
("dc-runtime"), not plain React/JSX. The markup uses its own small template
syntax:

- `{{ expr }}` — value interpolation
- `<sc-for list="{{ x }}" as="item">...</sc-for>` — loops
- `style-hover="..."` — hover-state styles (no real `:hover` CSS)
- `sc-camel-on-click="{{ handler }}"` — click handlers

None of that is portable directly into the Next.js/React codebase. When
Task 5 (Menu screen) in the implementation plan gets built for real, treat
this file as the **visual and interaction spec to translate**, not code to
copy-paste:

| Here | Becomes |
|---|---|
| `{{ expr }}` | JSX `{expr}` |
| `<sc-for list as>` | `.map()` |
| `style-hover="..."` | Tailwind `hover:` utilities or a CSS module |
| `sc-camel-on-click` | normal `onClick` |
| `href="#model-1v1"` / `#user-1v1` / `#history` | real routes: `<Link href="/model-1v1">` etc. (the anchors here are a standalone-preview stand-in, not real navigation) |

Fonts: the preview embeds raw `.woff2` files for offline viewing. For the
real build, load **Schibsted Grotesk** and **Martian Mono** via
`next/font/google`, and **Geist Mono** via the `geist` npm package (Vercel's
own font, zero-config with Next.js/Vercel — convenient given this deploys
on Vercel anyway). Don't carry the embedded woff2 blobs into the app.

## Design tokens (CSS custom properties, `--er-*`)

**Dark (default):**

| Token | Value | Use |
|---|---|---|
| `--er-bg` | `#14110d` | page background |
| `--er-surface` / `--er-surface2` | `#1d1813` / `#171310` | card backgrounds (gradient) |
| `--er-plate` / `--er-plate2` | `#221c15` / `#181410` | mini-board panel background |
| `--er-line` | `#2b241c` | borders/dividers |
| `--er-text` | `#ede4d4` | primary text |
| `--er-dim` | `#9c8f7c` | secondary text |
| `--er-accent` / `--er-accent-deep` | `#c9974a` / `#8a6320` | brass — primary accent, headline gradient, Model 1v1 card |
| `--er-copper` | `#c2703e` | secondary accent — User 1v1 card |
| `--er-verd` | `#5e8f7f` | tertiary accent — status/live indicators |

**Light:** same token set, swapped to `--er-bg:#ece5d8`, `--er-text:#241d12`,
`--er-accent:#96700f`, `--er-copper:#a4552a`, `--er-verd:#3f7566`, etc. — see
`hero-preview.html`'s `themeVars()` for the full light-mode table.

## Content (copy, captured verbatim so it doesn't drift)

- **Headline:** "The Engine Room" (gradient on "Engine", underline draws in on "Room")
- **Tagline:** "Where chess engines run at full steam. Watch machines duel across the sixty-four squares — or take the controls yourself."
- **Model 1v1 card:** badge "Mode 01 · Spectate" · "Pick two engines. Sit back and watch them run." · CTA "Open the throttle →"
- **User 1v1 card:** badge "Mode 02 · Play" · "Pick your opponent. Take a seat at the board." · CTA "Take the controls →"
- **History link:** "Game history — the ledger"
- **Theme toggle label:** "Lamps on" (dark) / "Lamps off" (light)

## Structural elements

- Persistent header: knight-glyph logo mark, gradient wordmark, theme toggle button (right-aligned) — matches the "persistent minimal header" decision from the workflow brainstorm, so this header treatment should carry to every other screen, not just the hero.
- Small animated train running along a track above the headline (decorative, on load).
- Mini animated "photo" panel: a static mid-game chess position rendered as an 8x8 grid with the last-move square pulsing, plus a status readout row ("Nº 64", "Live · engines coupled").
- Horizontal scrolling "telemetry ticker" strip with flavor text (engine names, eval, opening name) — atmospheric, not live data.
- Two large mode cards with a gauge-needle icon, hover lift/glow, sheen sweep animation.
- Ambient background: faint dashed flywheel circles, grain texture, radial glows — subtle, not competing with the cards/board for attention.

## Open question for later

The ticker's flavor text ("Stockfish 17 · depth 42", "Leela Zero · 84k
nodes/s", eval numbers) is static placeholder copy in this preview, not
wired to anything real. Decide at Task 5 implementation time whether it
stays as atmospheric flavor text or gets swapped for genuinely live data
(e.g. pulling from recent KV game records) — the latter would be a nice
touch but isn't necessary for the MVP.
