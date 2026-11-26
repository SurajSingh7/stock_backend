/**
 * Prepares a database for a code release — so the person deploying only has to
 * build and start. Every seeder / migration the release needs runs here, from a
 * developer machine, with a preview first and nothing written until the
 * database name is typed back.
 *
 *   node scripts/prepare-production.js                 preview, then ask
 *   node scripts/prepare-production.js --plan          preview only, never writes
 *   node scripts/prepare-production.js --env .env.x    target another env file (default .env.live)
 *   node scripts/prepare-production.js --with-alerts   also seed alert templates/rules (off by default)
 *   node scripts/prepare-production.js --confirm <db>  non-interactive confirm (same check as typing it)
 *
 * What it does, in order:
 *   1. Reads MONGO_URI from the env file ONLY (never from .env), prints host + database.
 *   2. Previews every step: what it would add / change / remove, per collection.
 *   3. Asks for the database name. Anything else → exits, nothing written.
 *   4. mongodump of that one database (refuses to continue if the backup fails).
 *   5. Runs the pending steps in order, stopping at the first failure.
 *   6. Writes a change log (before → after, per document and field) next to the backup,
 *      and records each finished step in `_migrations` so it is never run twice.
 *
 * Backups and logs go to ../prod-backups (outside this repo — they hold vendor bank details).
 * Restore: mongorestore --uri "<same uri>" --drop <backup folder>
 */
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const has = (name) => args.includes(name);

// ── 1. Target ───────────────────────────────────────────────────────────────
const envFile = path.resolve(ROOT, opt("--env") || ".env.live");
if (!fs.existsSync(envFile)) fail(`env file not found: ${envFile}`);
const uri = (fs.readFileSync(envFile, "utf8").match(/^\s*MONGO_URI\s*=\s*(.+?)\s*$/m) || [])[1];
if (!uri) fail(`no MONGO_URI in ${envFile}`);
// Set before any project import: the models' dotenv.config() never overrides an existing variable.
process.env.MONGO_URI = uri;
const host = uri.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, "").split(/[/?]/)[0];
const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);

// ── Steps ───────────────────────────────────────────────────────────────────
// Each script step is one of the existing scripts, run exactly as rehearsed.
// `dry` / `apply` are its own flags (the scripts are not consistent about them).
const PERMISSION_COLLS = ["modules", "role_module_permissions", "user_permission_overrides", "user_data_scopes", "department_module_restrictions"];
const STEPS = [
  { id: "boot-indexes-and-modules", kind: "boot", title: "Indexes for every model + new modules / actions (what server start would do)", colls: ["modules"] },
  { id: "remove-quotation-update-action", kind: "script", title: "Quotations: drop the UPDATE action", dry: ["--dry"], apply: [], colls: PERMISSION_COLLS },
  { id: "migrate-notifications-to-alerts", kind: "script", title: "Old notifications → Alerts (drops the notifications module + collection)", dry: [], apply: ["--apply"], colls: [...PERMISSION_COLLS, "notifications", "alert_templates", "alert_rules", "audit_logs"] },
  { id: "migrate-stock-page-modules", kind: "script", title: "inventory-items → 4 Stock page modules (old one switched off)", dry: [], apply: ["--apply"], colls: PERMISSION_COLLS },
  { id: "migrate-transfer-modules", kind: "script", title: "transfer-requests → 3 Stock Transfer modules (old one switched off)", dry: [], apply: ["--apply"], colls: PERMISSION_COLLS },
  ...(has("--with-alerts") ? [
    { id: "seed-low-stock-alert", kind: "script", title: "Alert templates + rule: low stock", noDry: true, apply: [], colls: ["alert_templates", "alert_rules", "audit_logs"] },
    { id: "seed-transfer-alerts", kind: "script", title: "Alert templates + rules: stock transfer", noDry: true, apply: [], colls: ["alert_templates", "alert_rules", "audit_logs"] },
  ] : []),
];

// ── Load project models (no server, no alert worker) ────────────────────────
let mongoose;
for (const f of fs.readdirSync(path.join(ROOT, "models")).filter((f) => f.endsWith(".model.js"))) {
  const M = (await import(pathToFileURL(path.join(ROOT, "models", f)).href)).default;
  if (M?.base) mongoose = M.base;
}
const { MODULE_DEFINITIONS, seedModules } = await import(pathToFileURL(path.join(ROOT, "seeders", "stock.module.seeder.js")).href);

// Nothing may be created before confirmation — indexes and collections come from the boot step.
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
await mongoose.connect(uri);
const db = mongoose.connection.db;
const DB = db.databaseName;
const done = new Set((await db.collection("_migrations").find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id));

console.log("\n══════════════════════════════════════════════════════════════");
console.log(`  TARGET  ${host}  →  database "${DB}"   ${isLocal ? "(local)" : "⚠️  REMOTE / LIVE"}`);
console.log(`  env     ${path.relative(ROOT, envFile)}`);
console.log("══════════════════════════════════════════════════════════════\n");

// ── 2. Preview ──────────────────────────────────────────────────────────────
const keyStr = (k) => JSON.stringify(k);
async function bootPlan() {
  const existing = await db.listCollections({}, { nameOnly: true }).toArray().then((c) => new Set(c.map((x) => x.name)));
  const indexes = [];
  for (const name of mongoose.modelNames()) {
    const M = mongoose.model(name);
    const coll = M.collection.collectionName;
    const live = existing.has(coll) ? await db.collection(coll).indexes() : [];
    for (const [key, o] of M.schema.indexes()) {
      if (!live.some((l) => keyStr(l.key) === keyStr(key))) indexes.push(`${coll}${existing.has(coll) ? "" : " (new collection)"}: ${o.name || keyStr(key)}${o.unique ? " UNIQUE" : ""}`);
    }
  }
  const mods = await db.collection("modules").find({}, { projection: { key: 1, actions: 1 } }).toArray();
  const byKey = new Map(mods.map((m) => [m.key, new Set(m.actions || [])]));
  const newModules = MODULE_DEFINITIONS.filter((d) => !byKey.has(d.key)).map((d) => d.key);
  const newActions = MODULE_DEFINITIONS.filter((d) => byKey.has(d.key))
    .map((d) => [d.key, d.actions.filter((a) => !byKey.get(d.key).has(a))]).filter(([, a]) => a.length);
  return { indexes, newModules, newActions, pending: indexes.length + newModules.length + newActions.length };
}

function runScript(step, flags) {
  const preload = pathToFileURL(path.join(ROOT, "scripts", "_no-auto-index.mjs")).href;
  const r = spawnSync(process.execPath, ["--import", preload, path.join(ROOT, "scripts", `${step.id}.js`), ...flags], {
    cwd: ROOT, env: { ...process.env, MONGO_URI: uri }, encoding: "utf8",
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`.split("\n").filter((l) => !/\[MONGOOSE\] Warning|trace-warnings/.test(l)).join("\n").trim();
  return { code: r.status, out };
}

const plan = [];
for (const [i, step] of STEPS.entries()) {
  console.log(`── ${i + 1}. ${step.title}`);
  if (step.kind === "boot") {
    const p = await bootPlan();
    if (!p.pending) { console.log("     nothing to do\n"); continue; }
    if (p.newModules.length) console.log(`     + ${p.newModules.length} module(s): ${p.newModules.join(", ")}`);
    for (const [k, a] of p.newActions) console.log(`     ~ module ${k}: + action(s) ${a.join(", ")}`);
    if (p.indexes.length) console.log(`     + ${p.indexes.length} index(es) — e.g. ${p.indexes.slice(0, 3).join(" | ")}${p.indexes.length > 3 ? " …" : ""}`);
    plan.push(step);
  } else if (done.has(step.id)) {
    console.log("     already applied here (recorded in _migrations) — skip");
  } else if (step.noDry) {
    console.log("     (this script has no dry run) creates its templates/rules only if they are not there yet");
    plan.push(step);
  } else {
    const r = runScript(step, step.dry);
    if (r.code !== 0) fail(`dry run of ${step.id} failed:\n${r.out}`);
    console.log(r.out.split("\n").map((l) => `     │ ${l}`).join("\n"));
    plan.push(step);
  }
  console.log("");
}

if (!plan.length) { console.log("Nothing to do — this database is already prepared."); await bye(0); }
if (has("--plan")) { console.log("--plan: preview only, nothing written."); await bye(0); }

// ── 3. Confirm ──────────────────────────────────────────────────────────────
console.log(`${plan.length} step(s) will run on "${DB}" after a full backup.`);
const typed = opt("--confirm") ?? (await ask(`Type the database name (${DB}) to apply, anything else to cancel: `));
if (typed !== DB) { console.log("Cancelled — nothing written."); await bye(0); }

// ── 4. Backup ───────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(ROOT, "..", "prod-backups", `${DB}-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });
const mongodump = findTool("mongodump");
if (!mongodump) fail("mongodump not found (install MongoDB Database Tools) — refusing to run without a backup.");
console.log(`\nBacking up "${DB}" → ${outDir}`);
const dump = spawnSync(mongodump, [`--uri=${uri}`, `--out=${path.join(outDir, "dump")}`], { encoding: "utf8" });
const dumped = fs.existsSync(path.join(outDir, "dump", DB)) ? fs.readdirSync(path.join(outDir, "dump", DB)).filter((f) => f.endsWith(".bson")).length : 0;
const liveColls = (await db.listCollections({}, { nameOnly: true }).toArray()).filter((c) => !c.name.startsWith("system.")).length;
if (dump.status !== 0 || dumped < liveColls) fail(`backup incomplete (${dumped}/${liveColls} collections) — nothing written.\n${dump.stderr}`);
console.log(`Backup OK: ${dumped} collection(s).\n`);

// ── 5. Apply ────────────────────────────────────────────────────────────────
const changes = [];
const logLines = [`Prepared ${DB} on ${host} — ${new Date().toISOString()} by ${os.userInfo().username}`, `Backup: ${path.join(outDir, "dump")}`, ""];
for (const step of plan) {
  process.stdout.write(`▶ ${step.id} … `);
  const before = await snapshot(step.colls);
  let out = "";
  if (step.kind === "boot") {
    for (const name of mongoose.modelNames()) await mongoose.model(name).createIndexes();
    out = JSON.stringify(await seedModules());
  } else {
    const r = runScript(step, step.apply);
    out = r.out;
    if (r.code !== 0) { fs.writeFileSync(path.join(outDir, "changes.log.txt"), logLines.join("\n")); fail(`${step.id} failed — stopped here. Earlier steps stay applied; backup is in ${outDir}\n${r.out}`); }
  }
  const after = await snapshot(step.colls);
  const diff = diffSnap(step.id, before, after);
  changes.push(...diff);
  await db.collection("_migrations").updateOne({ _id: step.id }, { $set: { appliedAt: new Date(), runBy: os.userInfo().username, host, changes: diff.length } }, { upsert: true });
  console.log(`done (${diff.length} change(s))`);
  logLines.push(`■ ${step.id}`, ...out.split("\n").map((l) => `    ${l}`), ...diff.map(fmt), "");
}
fs.writeFileSync(path.join(outDir, "changes.json"), JSON.stringify(changes, null, 2));
fs.writeFileSync(path.join(outDir, "changes.log.txt"), logLines.join("\n"));
console.log(`\nAll done. Change log: ${path.join(outDir, "changes.log.txt")}`);
await bye(0);

// ── helpers ─────────────────────────────────────────────────────────────────
async function snapshot(colls) {
  const s = {};
  for (const c of colls) {
    const exists = await db.listCollections({ name: c }).hasNext();
    s[c] = exists ? Object.fromEntries((await db.collection(c).find({}).toArray()).map((d) => [String(d._id), d])) : null;
  }
  return s;
}
function flat(o, p = "", out = {}) {
  const leaf = o === null || typeof o !== "object" || Array.isArray(o) || o instanceof Date || o._bsontype;
  if (leaf) out[p] = JSON.stringify(o);
  else for (const k of Object.keys(o)) flat(o[k], p ? `${p}.${k}` : k, out);
  return out;
}
function diffSnap(step, a, b) {
  const res = [];
  const label = (d) => d?.key || d?.name || d?.code || "";
  for (const c of Object.keys(b)) {
    const x = a[c], y = b[c];
    if (x && !y) { res.push({ step, collection: c, op: "drop-collection", count: Object.keys(x).length }); continue; }
    const xa = x || {}, ya = y || {};
    for (const id of Object.keys(ya)) if (!xa[id]) res.push({ step, collection: c, op: "add", id, label: label(ya[id]), after: ya[id] });
    for (const id of Object.keys(xa)) if (!ya[id]) res.push({ step, collection: c, op: "remove", id, label: label(xa[id]), before: xa[id] });
    for (const id of Object.keys(ya)) {
      if (!xa[id]) continue;
      const fa = flat(xa[id]), fb = flat(ya[id]);
      for (const f of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
        if (f === "updatedAt" || f === "__v" || fa[f] === fb[f]) continue;
        res.push({ step, collection: c, op: "change", id, label: label(ya[id]), field: f, before: fa[f] ?? null, after: fb[f] ?? null });
      }
    }
  }
  return res;
}
function fmt(c) {
  if (c.op === "drop-collection") return `    - DROPPED ${c.collection} (${c.count} docs)`;
  if (c.op === "add") return `    + ${c.collection} ${c.label} (${c.id})`;
  if (c.op === "remove") return `    - ${c.collection} ${c.label} (${c.id})`;
  return `    ~ ${c.collection} ${c.label} (${c.id}) ${c.field}: ${c.before} → ${c.after}`;
}
function findTool(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  const base = "C:\\Program Files\\MongoDB\\Tools";
  if (process.platform === "win32" && fs.existsSync(base)) {
    for (const v of fs.readdirSync(base).sort().reverse()) if (fs.existsSync(path.join(base, v, "bin", exe))) return path.join(base, v, "bin", exe);
  }
  return null;
}
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a.trim()); }));
}
async function bye(code) { await mongoose.disconnect().catch(() => {}); process.exit(code); }
function fail(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }
