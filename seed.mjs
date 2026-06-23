#!/usr/bin/env node
// Seeds content/strings.json for every opted-in repo that doesn't have one yet.
// Generates a minimal catalog from package.json name/description + README first line.
//
// Usage:
//   node seed.mjs              # dry run — show what would be written
//   node seed.mjs --write      # commit content/strings.json to each repo
//   node seed.mjs --repo=X     # single repo
//
// Env: GITHUB_TOKEN (required), ORG (default: bounded-systems)

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const write = args.includes("--write");
const singleRepo = (args.find((a) => a.startsWith("--repo=")) ?? "").slice("--repo=".length) || null;

const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("seed: GITHUB_TOKEN required"); process.exit(1); }

const org = process.env.ORG ?? "bounded-systems";

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

// Proper-case a repo name: "door-keeper" → "Door Keeper", "prx" → "prx" (short names stay lower)
function repoToName(repo) {
  const words = repo.replace(/[._]/g, "-").split("-").filter(Boolean);
  if (words.length === 1 && words[0].length <= 4) return words[0]; // prx, cas, fs, gh, bd
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Extract first meaningful sentence from a README (skip headings, badges, html)
function readmeFirstLine(text) {
  if (!text) return null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) continue;
    if (t.startsWith("!") || t.startsWith("<") || t.startsWith(">")) continue;
    if (t.startsWith("[") && t.includes("shield") || t.includes("badge")) continue;
    if (t.length < 10) continue;
    // strip markdown links/bold
    return t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "").trim();
  }
  return null;
}

// ── Paginate repos ──────────────────────────────────────────────────────────────
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

console.log(`\n  ${org}: ${repos.length} repo${repos.length !== 1 ? "s" : ""}  ${write ? "(writing)" : "(dry run)"}\n`);

// ── Per-repo seed ───────────────────────────────────────────────────────────────
async function seed(repoName) {
  const sentinelText = await fileText(repoName, ".string-audit.json");
  if (!sentinelText) return { repo: repoName, status: "no-sentinel" };

  let config;
  try { config = JSON.parse(sentinelText); } catch { return { repo: repoName, status: "invalid-sentinel" }; }

  const catalogPath = config.catalogPath ?? "content/strings.json";

  // Skip if catalog already exists
  const existing = await fileText(repoName, catalogPath);
  if (existing) return { repo: repoName, status: "exists", catalogPath };

  // Gather signals for catalog content
  const [pkgText, readmeText] = await Promise.all([
    fileText(repoName, "package.json"),
    fileText(repoName, "README.md").then((t) => t || fileText(repoName, "readme.md")),
  ]);

  const pkg = pkgText ? (() => { try { return JSON.parse(pkgText); } catch { return null; } })() : null;
  const pkgDesc = pkg?.description?.trim() || null;
  const readmeDesc = readmeFirstLine(readmeText);

  const name = pkg?.name?.replace(/^@[^/]+\//, "") || repoToName(repoName);
  const displayName = repoToName(repoName);
  const description = pkgDesc || readmeDesc;

  const catalog = {};
  catalog["name"] = { type: "name", value: displayName };
  if (description) catalog["description"] = { type: "meta", value: description };

  return { repo: repoName, status: "seed", catalogPath, catalog, name: displayName, description };
}

// Parallelise in batches of 8
const BATCH = 8;
const results = [];
for (let i = 0; i < repos.length; i += BATCH) {
  const batch = repos.slice(i, i + BATCH);
  const r = await Promise.all(batch.map(({ name }) => seed(name)));
  results.push(...r);
}

const toSeed    = results.filter((r) => r.status === "seed");
const exists    = results.filter((r) => r.status === "exists");
const noSentinel = results.filter((r) => r.status === "no-sentinel");

console.log(`  to seed:   ${toSeed.length}`);
console.log(`  exists:    ${exists.length} (skipped)`);
console.log(`  no sentinel: ${noSentinel.length} (skipped)\n`);

for (const r of toSeed) {
  const tokens = Object.keys(r.catalog).join(", ");
  console.log(`  ${write ? "·" : "·"} ${r.repo.padEnd(28)} → ${r.catalogPath}  [${tokens}]`);
  if (r.description) console.log(`    "${r.description.slice(0, 80)}${r.description.length > 80 ? "…" : ""}"`);
}

if (!write && toSeed.length) {
  console.log(`\n  → re-run with --write to commit ${toSeed.length} catalog${toSeed.length !== 1 ? "s" : ""}\n`);
}

// ── Write ───────────────────────────────────────────────────────────────────────
const report = { org, write, seeded: [], skipped: exists.map((r) => r.repo) };

if (write && toSeed.length) {
  console.log(`\n  ── WRITING CATALOGS ${"─".repeat(35)}\n`);
  for (const r of toSeed) {
    const content = JSON.stringify(r.catalog, null, 2) + "\n";
    const url = await commitFile(r.repo, r.catalogPath, content, "chore: add minimal content catalog (name + description tokens)");
    if (url) { console.log(`  ✓ ${r.repo.padEnd(28)} → ${url}`); report.seeded.push(r.repo); }
    else      console.warn(`  ✗ ${r.repo.padEnd(28)} commit failed`);
  }
  console.log();
}

writeFileSync("seed-report.json", JSON.stringify(report, null, 2));
console.log(`  wrote: seed-report.json\n`);
