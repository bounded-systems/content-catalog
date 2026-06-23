#!/usr/bin/env node
// Enriches content/strings.json for every opted-in repo.
// Reads README.md + package.json and produces a typed token set:
//   name        — display name (proper-cased repo name)
//   tagline     — first punchy sentence (≤120 chars)
//   description — fuller 1-3 sentence summary
//   keywords    — SCREAMING·CASE keyword rail (if package.json has keywords)
//
// Safe to re-run: skips repos whose catalog already has more than 2 tokens
// (i.e. was already manually enriched beyond the seed).
//
// Usage:
//   node enrich.mjs              # dry run
//   node enrich.mjs --write      # commit enriched catalogs
//   node enrich.mjs --force      # overwrite even enriched catalogs
//   node enrich.mjs --repo=X     # single repo
//
// Env: GITHUB_TOKEN (required), ORG (default: bounded-systems)

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const write = args.includes("--write");
const force = args.includes("--force");
const singleRepo = (args.find((a) => a.startsWith("--repo=")) ?? "").slice("--repo=".length) || null;

const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("enrich: GITHUB_TOKEN required"); process.exit(1); }

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
  const d = await gh(`repos/${org}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
  if (!d?.content) return null;
  return Buffer.from(d.content, "base64").toString("utf8");
}

async function commitFile(repo, path, content, message) {
  const existing = await gh(`repos/${org}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
  const body = {
    message,
    content: Buffer.from(content).toString("base64"),
    ...(existing?.sha ? { sha: existing.sha } : {}),
  };
  const r = await gh(`repos/${org}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r?.commit?.html_url ?? null;
}

// ── Text extraction helpers ────────────────────────────────────────────────────

function repoToName(repo) {
  const words = repo.replace(/[._]/g, "-").split("-").filter(Boolean);
  if (words.length === 1 && words[0].length <= 4) return words[0];
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function stripMarkdown(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")    // links → text
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")         // images → nothing
    .replace(/`{1,3}[^`]*`{1,3}/g, (m) => m.replace(/`/g, "").trim()) // inline code
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1") // bold/italic
    .replace(/^#+\s+/gm, "")                      // headings
    .replace(/^\s*[-*+>]\s+/gm, "")               // bullets/quotes
    .replace(/\s+/g, " ")
    .trim();
}

function extractReadmeContent(text) {
  if (!text) return { tagline: null, description: null };

  const lines = text.split("\n");
  const paragraphs = [];
  let current = [];

  for (const raw of lines) {
    const line = raw.trim();
    // Skip badges, HTML, empty separator lines
    if (!line || line.match(/^!\[.*shield/i) || line.startsWith("<") || line.startsWith("---")) {
      if (current.length) { paragraphs.push(current.join(" ")); current = []; }
      continue;
    }
    // Skip heading-only lines
    if (line.startsWith("#")) {
      if (current.length) { paragraphs.push(current.join(" ")); current = []; }
      continue;
    }
    current.push(line);
  }
  if (current.length) paragraphs.push(current.join(" "));

  const clean = paragraphs
    .map(stripMarkdown)
    .filter((p) => p.length > 20);

  if (!clean.length) return { tagline: null, description: null };

  // Tagline: first sentence of the first substantial paragraph, capped at 120 chars
  const first = clean[0];
  const sentenceEnd = first.search(/[.!?](?:\s|$)/);
  let tagline = sentenceEnd >= 0 ? first.slice(0, sentenceEnd + 1).trim() : first;
  if (tagline.length > 120) tagline = tagline.slice(0, 117) + "…";

  // Description: up to 3 sentences from the first paragraph, or first 2 paragraphs
  const descPara = clean.slice(0, 2).join(" ");
  const sentences = descPara.match(/[^.!?]+[.!?]+/g) ?? [descPara];
  let description = sentences.slice(0, 3).join(" ").trim();
  if (description.length > 280) description = description.slice(0, 277) + "…";

  return { tagline: tagline === description ? null : tagline, description };
}

// ── Per-repo enrichment ────────────────────────────────────────────────────────

async function enrich(repoName) {
  const sentinelText = await fileText(repoName, ".string-audit.json");
  if (!sentinelText) return { repo: repoName, status: "no-sentinel" };

  let config;
  try { config = JSON.parse(sentinelText); } catch { return { repo: repoName, status: "invalid-sentinel" }; }

  const catalogPath = config.catalogPath ?? "content/strings.json";
  const existingText = await fileText(repoName, catalogPath);

  let existing = {};
  if (existingText) {
    try { existing = JSON.parse(existingText); } catch {}
  }

  // Skip already-enriched catalogs unless --force
  const tokenCount = Object.keys(existing).filter((k) => !k.startsWith("$")).length;
  if (!force && tokenCount > 2) {
    return { repo: repoName, status: "enriched", tokenCount, catalogPath };
  }

  // Read source material in parallel
  const [pkgText, readmeText, readmeLower] = await Promise.all([
    fileText(repoName, "package.json"),
    fileText(repoName, "README.md"),
    fileText(repoName, "readme.md"),
  ]);

  const pkg = pkgText ? (() => { try { return JSON.parse(pkgText); } catch { return null; } })() : null;
  const readme = readmeText || readmeLower;

  const displayName = repoToName(repoName);
  const pkgDesc = pkg?.description?.trim() ?? null;
  const keywords = pkg?.keywords?.filter((k) => typeof k === "string") ?? [];

  const { tagline: readmeTagline, description: readmeDesc } = extractReadmeContent(readme);

  // Determine best tagline and description
  let tagline = readmeTagline ?? pkgDesc ?? null;
  let description = readmeDesc ?? pkgDesc ?? null;

  // If tagline == description, only use description
  if (tagline && description && tagline === description.split(".")[0].trim() + ".") {
    tagline = null;
  }

  const catalog = {};

  catalog["name"] = { type: "name", value: displayName };

  if (tagline && tagline.length > 0) {
    catalog["tagline"] = { type: "tagline", value: tagline };
  }

  if (description && description.length > 0) {
    catalog["description"] = { type: "meta", value: description };
  }

  if (keywords.length > 0) {
    catalog["keywords"] = {
      type: "body",
      value: keywords.map((k) => k.toUpperCase()).join(" · "),
    };
  }

  const newCount = Object.keys(catalog).length;
  return { repo: repoName, status: "enrich", catalogPath, catalog, tokenCount: newCount };
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

console.log(`\n  ${org}: ${repos.length} repo${repos.length !== 1 ? "s" : ""}  ${write ? "(writing)" : "(dry run)"}\n`);

const BATCH = 8;
const results = [];
for (let i = 0; i < repos.length; i += BATCH) {
  const batch = repos.slice(i, i + BATCH);
  const r = await Promise.all(batch.map(({ name }) => enrich(name)));
  results.push(...r);
}

const toEnrich   = results.filter((r) => r.status === "enrich");
const alreadyDone = results.filter((r) => r.status === "enriched");
const noSentinel  = results.filter((r) => r.status === "no-sentinel");

console.log(`  to enrich: ${toEnrich.length}`);
if (alreadyDone.length) console.log(`  already enriched (≥3 tokens): ${alreadyDone.length} (use --force to overwrite)`);
if (noSentinel.length)  console.log(`  no sentinel: ${noSentinel.length}`);
console.log();

for (const r of toEnrich) {
  const tokens = Object.entries(r.catalog)
    .map(([k, v]) => `${k}[${v.type}]`)
    .join(", ");
  console.log(`  · ${r.repo.padEnd(28)} ${tokens}`);
}

if (!write && toEnrich.length) {
  console.log(`\n  → re-run with --write to commit ${toEnrich.length} enriched catalog${toEnrich.length !== 1 ? "s" : ""}\n`);
}

// ── Write ───────────────────────────────────────────────────────────────────────
const report = { org, write, enriched: [], skipped: alreadyDone.map((r) => r.repo) };

if (write && toEnrich.length) {
  console.log(`\n  ── WRITING ${"─".repeat(43)}\n`);
  for (const r of toEnrich) {
    const content = JSON.stringify(r.catalog, null, 2) + "\n";
    const url = await commitFile(r.repo, r.catalogPath, content, "chore: enrich content catalog (name · tagline · description · keywords)");
    if (url) {
      console.log(`  ✓ ${r.repo.padEnd(28)} ${Object.keys(r.catalog).length} tokens → ${url}`);
      report.enriched.push(r.repo);
    } else {
      console.warn(`  ✗ ${r.repo.padEnd(28)} commit failed`);
    }
  }
  console.log();
}

writeFileSync("enrich-report.json", JSON.stringify(report, null, 2));
console.log(`  wrote: enrich-report.json\n`);
