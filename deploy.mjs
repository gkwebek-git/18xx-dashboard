// Feltöltés Cloudflare Pages-re (a hozzáférési adatokat az erdeiharmonia.hu\.env.production.local fájlból olvassa,
// nem írja ki őket).   npm run deploy
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const envFile = process.env.DEPLOY_ENV_FILE ?? path.resolve(root, "..", "erdeiharmonia.hu", ".env.production.local");
const project = process.env.CF_PAGES_PROJECT ?? "xx18-dashboard";
const vars = {};
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = /^\s*(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*=\s*(.*)\s*$/.exec(line);
  if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!vars.CLOUDFLARE_API_TOKEN || !vars.CLOUDFLARE_ACCOUNT_ID) throw new Error("Hiányzó Cloudflare adatok");

// kimeneti mappa (a helyi teszt-adatok nélkül)
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, "public"), dist, { recursive: true, filter: (s) => !s.includes(`${path.sep}data`) });
fs.writeFileSync(path.join(dist, "_headers"), "/*\n  X-Robots-Tag: noindex\n  Cache-Control: no-cache\n");

const mask = (s) => Object.values(vars).reduce((o, v) => (v ? o.split(v).join("***") : o), s);
const run = (args) => {
  const r = spawnSync("npx", args, { cwd: root, shell: true, encoding: "utf8", env: { ...process.env, ...vars } });
  process.stdout.write(mask(r.stdout ?? ""));
  process.stderr.write(mask(r.stderr ?? ""));
  return r.status ?? 1;
};
process.exit(run(["wrangler", "pages", "deploy", "dist", `--project-name=${project}`, "--branch=main", "--commit-dirty=true"]));
