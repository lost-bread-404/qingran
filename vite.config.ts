import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
import { isMigrationFile } from "./scripts/migration-plan.mjs";

/** The files `src/lib/db.ts` globs — same directory, same non-recursive scope. */
function hasGlobbedMigrations(root: string): boolean {
  try {
    return readdirSync(join(root, "migrations")).some(isMigrationFile);
  } catch {
    return false;
  }
}

/**
 * Finish PGLite bootstrap during dev-server setup (before traffic). Vite awaits
 * async `configureServer` hooks. Production: `src/lib/db` kicks `ensureDbReady`
 * on import.
 *
 * Vite awaiting the hook puts this on time-to-first-render, so an app with no
 * migrations — no schema to apply — skips it entirely rather than paying for a
 * PGLite instance it never queries.
 */
function pgliteBootstrapPlugin(): Plugin {
  return {
    name: "qingran:pglite-bootstrap",
    apply: "serve",
    async configureServer(server) {
      if (!hasGlobbedMigrations(server.config.root)) return;
      try {
        const mod = (await server.ssrLoadModule("/src/lib/db.ts")) as {
          ensureDbReady?: () => Promise<void>;
        };
        if (typeof mod.ensureDbReady === "function") {
          await mod.ensureDbReady();
        }
      } catch (err) {
        console.error("[db] bootstrap failed:", err);
        throw err;
      }
    },
  };
}

export default defineConfig(({ command, isPreview }) => ({
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  ssr: command === "serve" ? { external: ["ws"] } : undefined,
  plugins: [
    pgliteBootstrapPlugin(),
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview
      ? [
          nitro({
            preset: "vercel",
            // server/: the password gate (middleware/00-auth.ts) and the login / logout routes.
            // Nitro v3 defaults serverDir to false, so removing this silently turns the gate off.
            serverDir: "./server",
            // Hobby Fluid 上限 300s。createServerFn 与 SSR 打进同一条
            // Vercel Function，waitUntil 的长 drain 需要整条 function 都是 300s。
            // 不要用 functionRules 给 cron 单独设：Nitro 会整包复制一份
            // （nitro#4233），而 Diary 的 waitUntil 也跑在同一条 function 上。
            vercel: {
              // supportsCancellation: when the phone drops /api/talk (she went on), the function is told, so an
              // answer she never hears is not saved.
              functions: { maxDuration: 300, supportsCancellation: true },
            },
          }),
        ]
      : []),
    viteReact(),
  ],
}));
