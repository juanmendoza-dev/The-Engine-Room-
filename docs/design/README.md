# Design

| File | What's in it |
| --- | --- |
| [`ink-and-bone-notes.md`](ink-and-bone-notes.md) | **The current design system.** Tokens, fonts, the day/night mechanics, the header scoreboard, the brand mark, the route transition, and a Traps section. Start here. |
| [`ink-and-bone-preview.html`](ink-and-bone-preview.html) | The approved mockup for the above. Open it directly in a browser — self-contained apart from Google Fonts. Reference only; the shipped design is in `app/` and `components/`. |
| [`fight-fx-notes.md`](fight-fx-notes.md) | The 19 fight effects and the tier ladder that decides which one fires on a given move. |
| [`hero-notes.md`](hero-notes.md) | **Superseded 2026-08-04.** The original brass/steam design, replaced by Ink & Bone because it read as AI-generated default styling. Kept for history — don't build new screens from it. |
| [`hero-preview.html`](hero-preview.html) | The mockup for that superseded design. Same caveat. |

Both preview files came out of a design tool with its own template syntax
(`{{ expr }}`, `<sc-for>`, `style-hover`), so they're a visual and interaction
spec to translate, not code to copy. `hero-notes.md` has the translation table.
