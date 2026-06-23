#!/usr/bin/env node
// Token coverage tool + org bootstrapper.
//
// One pass over every repo in the org:
//   OPTED IN       — fetch catalog, show symbol counts by type + error tally
//   DISCOVERED     — catalog found, no sentinel yet; added with --write
//   DARK SURFACES  — frontend framework detected, no catalog (potential untracked copy)
//   CLEAN          — infra/library repos, nothing to do
//
// Usage:
//   node bootstrap.mjs                  # full scan, dry run
//   node bootstrap.mjs --write          # scan + commit sentinels to discovered repos
//   node bootstrap.mjs --repo=<name>    # focus on one repo
//   node bootstrap.mjs --json           # machine-readable output to stdout
//   node bootstrap.mjs --help
//
// Env: GITHUB_TOKEN (required), ORG (default: bounded-systems)

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
bootstrap.mjs — token coverage + org bootstrapper

  node bootstrap.mjs             full scan, dry run
  node bootstrap.mjs --write     scan + commit sentinels to discovered repos
  node bootstrap.mjs --repo=X    single repo only
  node bootstrap.mjs --json      machine-readable report to stdout

  Env: GITHUB_TOKEN (required), ORG (default: bounded-systems)
`);
  process.exit(0);
}

const write = args.includes("--write");
const jsonOut = args.includes("--json");
const singleRepo = (args.find((a) => a.startsWith("--repo=")) ?? "").slice("--repo=".length) || null;

const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("bootstrap: GITHUB_TOKEN env var required"); process.exit(1); }

const org = process.env.ORG ?? "bounded-systems";

// ── Catalog + grounding path candidates ───────────────────────────────────────
const CATALOG_CANDIDATES = [
  "content/strings.json",
  "dist/catalog.json",
  "catalog.json",
  "src/content/strings.json",
  "tokens/content.json",
  "strings.json",
];
const GROUNDING_CANDIDATES = [
  "content/grounding.json",
  "grounding.json",
  "dist/grounding.json",
];

// Frontend framework deps that suggest user-facing copy worth tokenising
const FRONTEND_SIGNALS = [
  "next", "react", "vue", "svelte", "nuxt", "gatsby", "remix", "astro",
  "@astrojs", "solid-js", "preact", "qwik",
];

// ── GitHub API helpers ─────────────────────────────────────────────────────────
async function gh(path, opts = {}) {
  const r = await fetch(`https://api.github.com/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      Accept: "application/vnd.github+json",
      ...(opts.headers ?? {}),
    },
  });
  if (r.status === 404) return null;
  if (!r.ok) { console.warn(`  gh ${path} → HTTP ${r.status}`); return null; }
  return r.json();
}

async function fileText(repo, path) {
  const d = await gh(`repos/${org}/${repo}/contents/${encodeURIComponent(path)}`);
  if (!d?.content) return null;
  return Buffer.from(d.content, "base64").toString("utf8");
}

async function fileExists(repo, path) {
  return (await gh(`repos/${org}/${repo}/contents/${encodeURIComponent(path)}`)) != null;
}

async function commitFile(repo, path, content, message) {
  const existing = await gh(`repos/${org}/${repo}/contents/${encodeURIComponent(path)}`);
  const body = {
    message,
    content: Buffer.from(content).toString("base64"),
    ...(existing?.sha ? { sha: existing.sha } : {}),
  };
  const r = await gh(`repos/${org}/${repo}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r?.commit?.html_url ?? null;
}

// ── Catalog helpers ────────────────────────────────────────────────────────────
const inferType = (key) =>
  /tagline/i.test(key) ? "tagline" :
  /\bname\b/i.test(key) ? "name" :
  /desc|meta/i.test(key) ? "meta" :
  /headline|hero/i.test(key) ? "headline" :
  /cta|button/i.test(key) ? "cta" :
  /thesis|statement|claim/i.test(key) ? "claim" : "body";

function parseCatalog(text) {
  try {
    const raw = JSON.parse(text);
    const symbols = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("$") || !v || typeof v !== "object") continue;
      if ("value" in v) symbols[k] = { type: v.type || inferType(k), value: v.value };
      else if ("$value" in v) symbols[k] = { type: v.type || v.$type || inferType(k), value: v.$value };
    }
    return symbols;
  } catch { return null; }
}

function typeCounts(symbols) {
  const counts = {};
  for (const { type } of Object.values(symbols)) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

function formatTypes(counts) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}:${n}`)
    .join(" ");
}

// ── Per-repo probe ─────────────────────────────────────────────────────────────
async function probe(repo) {
  const [sentinelText, pkgText] = await Promise.all([
    fileText(repo, ".string-audit.json"),
    fileText(repo, "package.json"),
  ]);

  const pkg = pkgText ? (() => { try { return JSON.parse(pkgText); } catch { return null; } })() : null;
  const allDeps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.peerDependencies });
  const isFrontend = FRONTEND_SIGNALS.some((s) => allDeps.some((d) => d === s || d.startsWith(s + "/")));
  const usesStringAudit = allDeps.some((d) => d.includes("string-audit"));

  if (sentinelText) {
    // Already opted in — load and analyse the catalog
    let config;
    try { config = JSON.parse(sentinelText); } catch { return { status: "opted-in-invalid" }; }

    const catalogText = await fileText(repo, config.catalogPath ?? "dist/catalog.json");
    const symbols = catalogText ? parseCatalog(catalogText) : null;
    return {
      status: "opted-in",
      config,
      symbols,
      symbolCount: symbols ? Object.keys(symbols).length : 0,
      types: symbols ? typeCounts(symbols) : {},
      isFrontend,
    };
  }

  // Not opted in — probe for catalog
  let catalogPath = null;
  for (const c of CATALOG_CANDIDATES) {
    if (await fileExists(repo, c)) { catalogPath = c; break; }
  }

  if (catalogPath) {
    let groundingPath = null;
    for (const c of GROUNDING_CANDIDATES) {
      if (await fileExists(repo, c)) { groundingPath = c; break; }
    }
    const catalogText = await fileText(repo, catalogPath);
    const symbols = catalogText ? parseCatalog(catalogText) : null;
    return {
      status: "discovered",
      catalogPath,
      groundingPath,
      symbols,
      symbolCount: symbols ? Object.keys(symbols).length : 0,
      types: symbols ? typeCounts(symbols) : {},
      usesStringAudit,
      isFrontend,
    };
  }

  return { status: isFrontend ? "dark" : "clean", isFrontend, usesStringAudit };
}

// ── Main ───────────────────────────────────────────────────────────────────────
let repos = [];
if (singleRepo) {
  repos = [{ name: singleRepo }];
} else {
  for (let page = 1; ; page++) {
    const batch = await gh(`orgs/${org}/repos?per_page=100&page=${page}&sort=full_name`);
    if (!batch?.length) break;
    repos.push(...batch);
    if (batch.length < 100) break;
  }
}

if (!jsonOut) {
  console.log(`\n  ${org}: ${repos.length} repo${repos.length !== 1 ? "s" : ""}${write ? "" : " (dry run — pass --write to commit)"}\n`);
}

// Run probes — parallelise in batches of 8 to avoid rate limits
const BATCH = 8;
const probed = [];
for (let i = 0; i < repos.length; i += BATCH) {
  const batch = repos.slice(i, i + BATCH);
  const results = await Promise.all(batch.map(({ name }) => probe(name).then((r) => ({ repo: name, ...r }))));
  probed.push(...results);
}

const optedIn   = probed.filter((r) => r.status === "opted-in" || r.status === "opted-in-invalid");
const discovered = probed.filter((r) => r.status === "discovered");
const dark       = probed.filter((r) => r.status === "dark");
const clean      = probed.filter((r) => r.status === "clean");

// ── Print ──────────────────────────────────────────────────────────────────────
if (!jsonOut) {
  const totalSymbols = optedIn.reduce((n, r) => n + (r.symbolCount ?? 0), 0);

  if (optedIn.length) {
    console.log(`  ── OPTED IN (${optedIn.length} repo${optedIn.length !== 1 ? "s" : ""} · ${totalSymbols} symbols) ${"─".repeat(20)}`);
    for (const r of optedIn) {
      if (r.status === "opted-in-invalid") {
        console.log(`  ⚠ ${r.repo.padEnd(28)} invalid .string-audit.json`);
        continue;
      }
      const typeLine = r.symbolCount ? `${r.symbolCount} symbols  [${formatTypes(r.types)}]` : "catalog unreadable";
      console.log(`  · ${r.repo.padEnd(28)} ${typeLine}`);
    }
    console.log();
  }

  if (discovered.length) {
    console.log(`  ── DISCOVERED (${discovered.length} · catalog found, no sentinel) ${"─".repeat(10)}`);
    for (const r of discovered) {
      const typeLine = r.symbolCount ? `${r.symbolCount} symbols  [${formatTypes(r.types)}]` : "";
      const gTag = r.groundingPath ? " + grounding" : "";
      console.log(`  ✓ ${r.repo.padEnd(28)} ${r.catalogPath}${gTag}  ${typeLine}`);
    }
    if (!write) console.log(`\n  → re-run with --write to commit ${discovered.length} sentinel${discovered.length !== 1 ? "s" : ""}`);
    console.log();
  }

  if (dark.length) {
    console.log(`  ── DARK SURFACES (${dark.length} · frontend detected, no catalog) ${"─".repeat(5)}`);
    for (const r of dark) {
      console.log(`  ⚠ ${r.repo.padEnd(28)} frontend deps detected — consider tokenising copy`);
    }
    console.log();
  }

  console.log(`  ── SUMMARY ${"─".repeat(44)}`);
  console.log(`  opted in:   ${optedIn.length} repo${optedIn.length !== 1 ? "s" : ""} · ${totalSymbols} symbols`);
  if (discovered.length) console.log(`  to add:     ${discovered.length} repo${discovered.length !== 1 ? "s" : ""} with catalogs awaiting sentinel`);
  if (dark.length)       console.log(`  dark:       ${dark.length} repo${dark.length !== 1 ? "s" : ""} with frontends, no catalog`);
  console.log(`  clean:      ${clean.length} (infra/libraries — no action needed)`);

  // Type distribution across all opted-in repos
  if (totalSymbols) {
    const allTypes = {};
    for (const r of optedIn) for (const [t, n] of Object.entries(r.types ?? {})) allTypes[t] = (allTypes[t] ?? 0) + n;
    console.log(`\n  type distribution: ${formatTypes(allTypes)}`);
  }

  console.log();
}

// ── Write sentinels ────────────────────────────────────────────────────────────
if (write && discovered.length) {
  console.log(`  ── WRITING SENTINELS ${"─".repeat(34)}`);
  for (const r of discovered) {
    const config = { catalogPath: r.catalogPath };
    if (r.groundingPath) config.groundingPath = r.groundingPath;
    const content = JSON.stringify(config, null, 2) + "\n";
    const url = await commitFile(r.repo, ".string-audit.json", content, "chore: opt in to content-catalog aggregator");
    if (url) console.log(`  ✓ ${r.repo}  → ${url}`);
    else     console.warn(`  ✗ ${r.repo}  commit failed`);
  }
  console.log();
}

// ── Machine-readable output ───────────────────────────────────────────────────
const report = { org, write, scanned: repos.length, optedIn, discovered, dark: dark.map((r) => r.repo), clean: clean.map((r) => r.repo) };
writeFileSync("bootstrap-report.json", JSON.stringify(report, null, 2));
if (!jsonOut) console.log(`  wrote: bootstrap-report.json\n`);
else process.stdout.write(JSON.stringify(report, null, 2) + "\n");
