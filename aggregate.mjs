#!/usr/bin/env node
// Discovers all opted-in repos in the org via .string-audit.json sentinel,
// fetches their catalogs at HEAD, namespaces keys by repo name, merges, and writes:
//
//   catalog.merged.json   — namespaced catalog loadable by string-audit's loadCatalog()
//   grounding.merged.json — union of all grounding arrays
//
// Provenance is embedded as $provenance in catalog.merged.json (loadCatalog skips $
// keys, so the gate consumes the file unmodified). SLSA attestation is applied to
// catalog.merged.json by the workflow via actions/attest-build-provenance.
//
// Sentinel format (.string-audit.json in each participating repo root):
//   { "catalogPath": "dist/catalog.json", "groundingPath": "dist/grounding.json" }
// Both paths are optional (defaults shown above). groundingPath may be omitted.
//
// Env: GITHUB_TOKEN (required), ORG (default: bounded-systems)

import { writeFileSync } from "node:fs";

const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("aggregate: GITHUB_TOKEN env var required"); process.exit(1); }

const org = process.env.ORG ?? "bounded-systems";

async function gh(path) {
  const r = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      Accept: "application/vnd.github+json",
    },
  });
  if (r.status === 404) return null;
  if (!r.ok) { console.warn(`  gh api ${path} → HTTP ${r.status}`); return null; }
  return r.json();
}

async function fileText(repo, filePath) {
  const d = await gh(`repos/${org}/${repo}/contents/${encodeURIComponent(filePath)}`);
  if (!d?.content) return null;
  return Buffer.from(d.content, "base64").toString("utf8");
}

// Paginate all repos in the org
const repos = [];
for (let page = 1; ; page++) {
  const batch = await gh(`orgs/${org}/repos?per_page=100&page=${page}&sort=full_name`);
  if (!batch?.length) break;
  repos.push(...batch);
  if (batch.length < 100) break;
}
console.log(`\n  ${org}: ${repos.length} repos\n`);

const merged = {};
const groundingSet = new Set();
const sources = {};

for (const { name: repo, default_branch } of repos) {
  const raw = await fileText(repo, ".string-audit.json");
  if (!raw) continue; // not opted in

  let config;
  try { config = JSON.parse(raw); }
  catch { console.warn(`  ${repo}: invalid .string-audit.json — skipping`); continue; }

  const catalogPath = config.catalogPath ?? "dist/catalog.json";
  const catalogText = await fileText(repo, catalogPath);
  if (!catalogText) { console.warn(`  ${repo}: catalog not found at ${catalogPath} — skipping`); continue; }

  let catalog;
  try { catalog = JSON.parse(catalogText); }
  catch { console.warn(`  ${repo}: catalog parse error — skipping`); continue; }

  // record the commit SHA for provenance
  const head = await gh(`repos/${org}/${repo}/commits/${default_branch}`);
  const sha = head?.sha ?? "unknown";

  let count = 0;
  for (const [k, v] of Object.entries(catalog)) {
    if (k.startsWith("$") || !v || typeof v !== "object") continue;
    merged[`${repo}.${k}`] = { ...v, $source: repo };
    count++;
  }

  if (config.groundingPath) {
    const groundingText = await fileText(repo, config.groundingPath);
    if (groundingText) {
      try {
        const terms = JSON.parse(groundingText);
        if (Array.isArray(terms)) terms.forEach((t) => groundingSet.add(t));
      } catch {}
    }
  }

  sources[repo] = { sha, branch: default_branch, catalogPath, symbols: count };
  console.log(`  ✓ ${repo.padEnd(28)} ${count} symbols @ ${sha.slice(0, 8)}`);
}

const total = Object.keys(merged).length;
if (!total) {
  console.error("\n  no symbols — add a .string-audit.json sentinel to at least one repo");
  process.exit(1);
}

// Embed provenance as $-prefixed metadata (loadCatalog in string-audit skips these)
merged["$provenance"] = {
  org,
  generated: new Date().toISOString(),
  sources,
};

writeFileSync("catalog.merged.json", JSON.stringify(merged, null, 2));
writeFileSync("grounding.merged.json", JSON.stringify([...groundingSet], null, 2));

const sourceCount = Object.keys(sources).length;
console.log(`\n  merged: ${total} symbols from ${sourceCount} repo${sourceCount !== 1 ? "s" : ""}`);
console.log(`  wrote: catalog.merged.json · grounding.merged.json\n`);
