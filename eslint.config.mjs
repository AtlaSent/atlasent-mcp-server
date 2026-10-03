// ESLint flat config (issue #162).
//
// The lint toolchain lives in tools/lint/, not in the root devDependencies:
// the root builds with TypeScript 7, which ships no JavaScript API, and
// typescript-eslint parses through that API (peer typescript <6.1). So the
// packages below resolve from tools/lint/node_modules, which `npm run lint`
// installs on first use (scripts/lint.mjs).
import { createRequire } from "node:module";

const require = createRequire(new URL("./tools/lint/package.json", import.meta.url));
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const globals = require("globals");

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "dist/**",
      "mcpb-out/**",
      "**/*.d.ts",
      // Generated mirrors; re-synced by scripts, never hand-edited.
      "src/canonCatalog.ts",
      "src/canonGraph.ts",
      "src/atlasCatalog.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // CONTRIBUTING.md: no `any` in new code. Existing test and acceptance
      // sites that read untyped JSON carry a per-line disable.
      "@typescript-eslint/no-explicit-any": "error",
      // `_`-prefixed names are deliberately unused (mock signatures,
      // `{ dropped: _drop, ...rest }` omission).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // `try { JSON.parse(...) } catch {}` is the intended parse-or-null idiom.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Flags `let json = null; try { json = await res.json() } catch { json = null }`.
      // That explicit default on every fail-closed parse path is intentional,
      // so this rule is off rather than rewriting each one.
      "no-useless-assignment": "off",
    },
  },
  {
    // The atlasent-guard hook's deny patterns: escapes like `[\/\\]` are
    // redundant but harmless, and these regexes are security-relevant, so
    // they are left byte-for-byte rather than "cleaned up" by a linter.
    files: ["packages/agent-hooks/rules.mjs"],
    rules: { "no-useless-escape": "off" },
  },
);
