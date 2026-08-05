import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored engine builds. public/stockfish/*.js is minified Emscripten
    // output, not our source — linting it produced 7 no-require-imports errors
    // that can't be fixed and drown out real ones.
    "public/stockfish/**",
    "public/maia/**",
  ]),
]);

export default eslintConfig;
