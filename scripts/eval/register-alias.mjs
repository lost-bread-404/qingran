/**
 * Node ESM hook: resolve `@/` → `src/` and extensionless relative imports to `.ts` / `.tsx`.
 * Loaded via `node --import ./scripts/eval/register-alias.mjs`.
 */
import { existsSync, statSync } from "node:fs";
import { register } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.QR_ALIAS_REGISTERED) {
  process.env.QR_ALIAS_REGISTERED = "1";
  register(import.meta.url);
}

const srcRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../src") + "/";

function pick(base) {
  for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return pathToFileURL(p).href;
  }
  return null;
}

export async function resolve(spec, ctx, next) {
  if (spec.startsWith("@/")) {
    const href = pick(srcRoot + spec.slice(2));
    if (href) return next(href, { ...ctx, parentURL: import.meta.url });
  }
  if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL?.startsWith("file:")) {
    const href = pick(resolvePath(dirname(fileURLToPath(ctx.parentURL)), spec));
    if (href) return next(href, { ...ctx, parentURL: import.meta.url });
  }
  return next(spec, ctx);
}
