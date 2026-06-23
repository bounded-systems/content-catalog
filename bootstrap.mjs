#!/usr/bin/env node
// Bootstraps .string-audit.json sentinels across every repo in a GitHub org.
// Probes common catalog + grounding paths; skips repos that already have a
// sentinel or have no recognizable catalog.
//
// Usage:
//   node bootstrap.mjs                  # dry run — shows what would be written
//   node bootstrap.mjs --write          # commit sentinels to each discovered repo
//   node bootstrap.mjs --write --repo=prx   # single repo
//   node bootstrap.mjs --help
//
// Env: GITHUB_TOKEN (required), ORG (default: bounded-systems)

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`\nbootstrap.mjs — seed .string-audit.json sentinels across an org

  node bootstrap.mjs             dry run (no writes)
  node bootstrap.mjs --write     commit sentinels to discovered repos
  node bootstrap.mjs --write --repo=<name>  single repo only

  Env: GITHUB_TOKEN (required), ORG (default: bounded-systems)\n`);
  process.exit(0);
}

const write = args.includes("--write");
const singleRepo = (args.find((a) => a.startsWith("--repo=")) ?? "").slice("--repo=".length) || null;

const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("bootstrap: GITHUB_TOKEN env var required"); process.exit(1); }

const org = process.env.ORG ?? "bounded-systems";

// ── Catalog paths to probe (ordered: most specific first) ─────────────────────
const CATALOG_CANDIDATES = [
  "content/strings.json",
  "dist/catalog.json",
  "catalog.json",
  "src/content/strings.json",
  "tokens/content.json",
  "strings.json",
];

// Grounding path candidates (probed after a catalog is found)
const GROUNDING_CANDIDATES = [
  "content/grounding.json",
  "grounding.json",
  "dist/grounding.json",
];

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

async function fileExists(repo, path) {
  const d = await gh(`repos/${org}/${repo}/contents/${encodeURIComponent(path)}`);
  return d != null;
}

async function fileText(repo, path) {
  const d = await gh(`repos/${org}/${repo}/contents/${encodeURIComponent(path)}`);
  if (!d?.content) return null;
  return Buffer.from(d.content, "base64").toString("utf8");
}

async function commitFile(repo, path, content, message) {
  // Check for existing file SHA (required for updates)
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

// ── Discover ───────────────────────────────────────────────────────────────────

async function probe(repo) {
  // Already opted in?
  const existing = await fileText(repo, ".string-audit.json");
  if (existing) {
    try { return { status: "already", config: JSON.parse(existing) }; }
    catch { return { status: "already", config: null }; }
  }

  // Check if package.json references string-audit (strong signal)
  const pkgText = await fileText(repo, "package.json");
  const usesStringAudit = pkgText?.includes("string-audit") ?? false;

  // Probe catalog paths
  let catalogPath = null;
  for (const candidate of CATALOG_CANDIDATES) {
    if (await fileExists(repo, candidate)) { catalogPath = candidate; break; }
  }

  if (!catalogPath) return { status: "no-catalog", usesStringAudit };

  // Probe grounding paths
  let groundingPath = null;
  for (const candidate of GROUNDING_CANDIDATES) {
    if (await fileExists(repo, candidate)) { groundingPath = candidate; break; }
  }

  return { status: "found", catalogPath, groundingPath, usesStringAudit };
}

// ── Main ───────────────────────────────────────────────────────────────────────

// Paginate repos
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

console.log(`\n  ${org}: ${repos.length} repo${repos.length !== 1 ? "s" : ""} to scan${write ? "" : " (dry run — pass --write to commit)"}\n`);

const results = { found: [], already: [], skipped: [] };

for (const { name: repo } of repos) {
  const r = await probe(repo);

  if (r.status === "already") {
    results.already.push({ repo, config: r.config });
    console.log(`  · ${repo.padEnd(30)} already opted in`);
    continue;
  }

  if (r.status === "no-catalog") {
    results.skipped.push({ repo });
    const hint = r.usesStringAudit ? " (uses string-audit but no catalog found)" : "";
    console.log(`  - ${repo.padEnd(30)} no catalog${hint}`);
    continue;
  }

  // Found a catalog
  const config = { catalogPath: r.catalogPath };
  if (r.groundingPath) config.groundingPath = r.groundingPath;

  results.found.push({ repo, ...r });

  const gTag = r.groundingPath ? ` + grounding` : "";
  const saTag = r.usesStringAudit ? " [uses string-audit]" : "";
  console.log(`  ✓ ${repo.padEnd(30)} ${r.catalogPath}${gTag}${saTag}`);

  if (write) {
    const content = JSON.stringify(config, null, 2) + "\n";
    const url = await commitFile(
      repo,
      ".string-audit.json",
      content,
      "chore: opt in to content-catalog aggregator",
    );
    if (url) console.log(`    → ${url}`);
    else console.warn(`    ✗ commit failed`);
  }
}

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n  ${"─".repeat(52)}`);
console.log(`  found:    ${results.found.length} repo${results.found.length !== 1 ? "s" : ""} with catalogs`);
console.log(`  already:  ${results.already.length} already opted in`);
console.log(`  skipped:  ${results.skipped.length} no catalog`);

if (!write && results.found.length > 0) {
  console.log(`\n  re-run with --write to commit sentinels to the ${results.found.length} discovered repo${results.found.length !== 1 ? "s" : ""}`);
}

// Machine-readable output for piping / CI use
writeFileSync(
  "bootstrap-report.json",
  JSON.stringify({ org, write, found: results.found, already: results.already, skipped: results.skipped }, null, 2),
);
console.log(`  wrote: bootstrap-report.json\n`);
