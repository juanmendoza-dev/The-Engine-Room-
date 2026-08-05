// An ESM resolve hook so plain Node can import this repo's TypeScript modules.
//
// Node 24 strips types out of a `.ts` file on its own, with no flag and no
// dependency — but it does not rewrite import specifiers, and the source here
// uses extensionless relative imports (`from "./eloModel"`), which is the
// bundler convention Next configures and every other file in `lib/` follows.
// Plain Node's ESM resolver wants `./eloModel.ts` and errors otherwise.
//
// Rather than sprinkle `.ts` extensions through the source purely to suit a
// verification script — or turn on `allowImportingTsExtensions` in the shared
// tsconfig — the fixup lives out here, in the one place that needs it.
//
// Register it before the dynamic import that needs it:
//
//   import { register } from "node:module";
//   register("./ts-extension-resolver.mjs", import.meta.url);
//   const mod = await import("../lib/analysis/eloModel.ts");
//
// Only useful for modules that are pure TypeScript with no npm imports and no
// `window` — `lib/analysis/`'s maths files, deliberately. Anything reaching for
// chess.js or ORT still belongs in a browser page.

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith(".")) return nextResolve(specifier, context);

  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    return nextResolve(`${specifier}.ts`, context);
  }
}
