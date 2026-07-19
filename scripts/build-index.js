#!/usr/bin/env node
/**
 * Batwing Dataset Index Builder
 * ------------------------------
 * Scans the public/ directory for all *.geojson and *.kml files,
 * extracts metadata (feature count, file size, bounding box, property
 * summary), and emits a self-contained static HTML page at dist/index.html
 * that lists every dataset with download links.
 *
 * Called by the GitHub Actions Pages workflow after validation passes.
 *
 * Usage:
 *   node scripts/build-index.js
 *   OUTPUT_DIR=./out node scripts/build-index.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────
const ROOT       = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_DIR    = process.env.OUTPUT_DIR
                     ? path.resolve(process.env.OUTPUT_DIR)
                     : path.join(ROOT, 'dist');

// ── KML → GeoJSON (lightweight, no full togeojson dep needed here) ────────────
// We only need feature count + rough bbox from KML, so we parse it simply.
function kmlFeatureCount(xml) {
  return (xml.match(/<Placemark/g) || []).length;
}
function kmlName(xml) {
  const m = xml.match(/<name>\s*([^<]+)\s*<\/name>/);
  return m ? m[1].trim() : null;
}

// ── GeoJSON helpers ───────────────────────────────────────────────────────────
function bbox(features) {
  let minLon= 180, minLat= 90, maxLon=-180, maxLat=-90;
  let found = false;
  for (const f of features) {
    if (!f.geometry) continue;
    const polys =
      f.geometry.type === 'Polygon'      ? [f.geometry.coordinates] :
      f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates   : [];
    for (const poly of polys) {
      for (const ring of poly) {
        for (const [lon, lat] of ring) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          found = true;
        }
      }
    }
  }
  return found ? [minLon, minLat, maxLon, maxLat] : null;
}

function typeCounts(features) {
  const counts = {};
  for (const f of features) {
    const t = (f.properties && (f.properties.type || f.properties.Type)) || 'Unknown';
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtBbox(bb) {
  if (!bb) return 'n/a';
  const fmt = n => n.toFixed(4);
  return `${fmt(bb[1])}°N ${fmt(bb[0])}°E → ${fmt(bb[3])}°N ${fmt(bb[2])}°E`;
}

// ── Discover files ─────────────────────────────────────────────────────────────
function discoverFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...discoverFiles(full));
    else if (/\.(geojson|kml)$/i.test(entry.name)) results.push(full);
  }
  return results.sort();
}

// ── Per-file metadata ──────────────────────────────────────────────────────────
function extractMeta(filePath) {
  const rel      = path.relative(PUBLIC_DIR, filePath);
  const stat     = fs.statSync(filePath);
  const isKml    = /\.kml$/i.test(filePath);
  const raw      = fs.readFileSync(filePath, 'utf8');
  const fileName = path.basename(filePath);

  let featureCount = 0;
  let bb           = null;
  let types        = {};
  let title        = fileName;

  if (isKml) {
    featureCount = kmlFeatureCount(raw);
    title        = kmlName(raw) || fileName;
    // bbox not extracted from KML (would need full parser) — show n/a
  } else {
    let gj;
    try { gj = JSON.parse(raw); } catch (_) { return null; }
    const features = gj.type === 'FeatureCollection' ? gj.features :
                     gj.type === 'Feature'           ? [gj]         : [];
    featureCount = features.length;
    bb    = bbox(features);
    types = typeCounts(features);
    // Try to infer a human title from the first feature's layerName or worldUpdate
    const first = features[0];
    if (first && first.properties) {
      const bw = first.properties._batwing;
      if (bw && bw.layerName) title = bw.layerName;
      else if (first.properties.worldUpdate) title = `WU${first.properties.worldUpdate} Dataset`;
    }
  }

  return {
    fileName,
    rel,          // path relative to public/ — used as download href
    title,
    format: isKml ? 'KML' : 'GeoJSON',
    size: fmtSize(stat.size),
    sizeBytes: stat.size,
    featureCount,
    bbox: fmtBbox(bb),
    types,
  };
}

// ── HTML generation ────────────────────────────────────────────────────────────
function typeChips(types) {
  return Object.entries(types)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<span class="chip">${t} <em>${n}</em></span>`)
    .join('');
}

function formatBadge(fmt) {
  return fmt === 'KML'
    ? `<span class="badge kml">KML</span>`
    : `<span class="badge geojson">GeoJSON</span>`;
}

function buildCard(meta, repoUrl) {
  const downloadHref = repoUrl
    ? `${repoUrl}/raw/main/public/${meta.rel}`
    : meta.rel;
  const chips = Object.keys(meta.types).length
    ? `<div class="chips">${typeChips(meta.types)}</div>`
    : '';
  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">${meta.title}</div>
        ${formatBadge(meta.format)}
      </div>
      <div class="card-meta">
        <span title="File name">📄 ${meta.fileName}</span>
        <span title="Features">🗺 ${meta.featureCount} feature${meta.featureCount !== 1 ? 's' : ''}</span>
        <span title="File size">💾 ${meta.size}</span>
      </div>
      ${meta.bbox !== 'n/a' ? `<div class="card-bbox" title="Bounding box">📐 ${meta.bbox}</div>` : ''}
      ${chips}
      <a class="download-btn" href="${downloadHref}" download="${meta.fileName}">
        ⬇ Download ${meta.format}
      </a>
    </div>`;
}

function buildHTML(datasets, repoUrl, builtAt) {
  const geojsonCount = datasets.filter(d => d.format === 'GeoJSON').length;
  const kmlCount     = datasets.filter(d => d.format === 'KML').length;
  const totalFeats   = datasets.reduce((s, d) => s + d.featureCount, 0);

  const cards = datasets.map(d => buildCard(d, repoUrl)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Batwing Airspace &amp; Parks Datasets</title>
  <meta name="description" content="Curated GeoJSON and KML datasets for MSFS airspace boundaries, national parks, and custom flight simulation polygons — validated and maintained by Batwing.">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:         #0d1117;
      --surface:    #161b22;
      --surface2:   #1c2230;
      --border:     rgba(255,255,255,0.08);
      --accent:     #58a6ff;
      --accent2:    #1f6feb;
      --text:       #e6edf3;
      --muted:      #8b949e;
      --geojson:    #2da44e;
      --geojson-bg: rgba(45,164,78,0.12);
      --kml:        #d29922;
      --kml-bg:     rgba(210,153,34,0.12);
      --radius:     8px;
      --radius-lg:  14px;
      font-size: 15px;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.6;
    }

    /* ── Header ── */
    header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 28px 24px 24px;
      text-align: center;
    }

    .logo {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }

    .logo svg { width: 36px; height: 36px; }

    h1 {
      font-size: 1.6rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text);
    }

    .tagline {
      color: var(--muted);
      font-size: 0.9rem;
      margin-top: 4px;
    }

    /* ── Stats bar ── */
    .stats {
      display: flex;
      justify-content: center;
      gap: 32px;
      padding: 16px 24px;
      background: var(--surface2);
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }

    .stat { text-align: center; }
    .stat-val { font-size: 1.4rem; font-weight: 700; color: var(--accent); }
    .stat-lbl { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }

    /* ── Main grid ── */
    main {
      max-width: 900px;
      margin: 0 auto;
      padding: 32px 20px 60px;
    }

    .section-title {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .09em;
      color: var(--muted);
      margin-bottom: 16px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 16px;
    }

    /* ── Card ── */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 18px 18px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      transition: border-color .15s, box-shadow .15s;
    }

    .card:hover {
      border-color: rgba(88,166,255,.3);
      box-shadow: 0 4px 24px rgba(88,166,255,.07);
    }

    .card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }

    .card-title {
      font-weight: 600;
      font-size: 0.95rem;
      line-height: 1.35;
      color: var(--text);
    }

    .badge {
      font-size: 0.68rem;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 20px;
      flex-shrink: 0;
      letter-spacing: .04em;
      text-transform: uppercase;
    }

    .badge.geojson { background: var(--geojson-bg); color: var(--geojson); border: 1px solid rgba(45,164,78,.25); }
    .badge.kml     { background: var(--kml-bg);     color: var(--kml);     border: 1px solid rgba(210,153,34,.25); }

    .card-meta {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      font-size: 0.8rem;
      color: var(--muted);
    }

    .card-bbox {
      font-size: 0.75rem;
      color: var(--muted);
      font-family: 'SF Mono', 'Fira Code', monospace;
      background: rgba(255,255,255,0.04);
      padding: 4px 8px;
      border-radius: 4px;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .chip {
      font-size: 0.72rem;
      padding: 2px 8px;
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--border);
      border-radius: 20px;
      color: var(--muted);
    }

    .chip em {
      font-style: normal;
      color: var(--accent);
      font-weight: 600;
      margin-left: 3px;
    }

    .download-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 4px;
      padding: 8px 14px;
      background: rgba(31,111,235,.15);
      border: 1px solid rgba(31,111,235,.35);
      color: var(--accent);
      border-radius: var(--radius);
      font-size: 0.82rem;
      font-weight: 600;
      text-decoration: none;
      transition: background .15s, border-color .15s;
    }

    .download-btn:hover {
      background: rgba(31,111,235,.28);
      border-color: var(--accent2);
    }

    /* ── Footer ── */
    footer {
      text-align: center;
      padding: 20px;
      font-size: 0.78rem;
      color: var(--muted);
      border-top: 1px solid var(--border);
    }

    footer a { color: var(--accent); text-decoration: none; }
    footer a:hover { text-decoration: underline; }

    @media (max-width: 520px) {
      .stats { gap: 20px; }
      .grid  { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

<header>
  <div class="logo">
    <!-- Batwing bat-wing chevron logo -->
    <svg viewBox="0 0 36 36" fill="none" aria-label="Batwing">
      <path d="M18 28 L2 10 L10 14 L18 8 L26 14 L34 10 Z" fill="#58a6ff" opacity=".9"/>
      <path d="M18 28 L10 14 L18 20 L26 14 Z" fill="#1f6feb"/>
    </svg>
    <h1>Batwing Datasets</h1>
  </div>
  <p class="tagline">Validated GeoJSON &amp; KML for MSFS airspace, national parks, and custom flight boundaries</p>
</header>

<div class="stats">
  <div class="stat">
    <div class="stat-val">${datasets.length}</div>
    <div class="stat-lbl">Datasets</div>
  </div>
  <div class="stat">
    <div class="stat-val">${totalFeats}</div>
    <div class="stat-lbl">Total Features</div>
  </div>
  <div class="stat">
    <div class="stat-val">${geojsonCount}</div>
    <div class="stat-lbl">GeoJSON Files</div>
  </div>
  <div class="stat">
    <div class="stat-val">${kmlCount}</div>
    <div class="stat-lbl">KML Files</div>
  </div>
</div>

<main>
  <div class="section-title">Available datasets</div>
  <div class="grid">
    ${cards}
  </div>
</main>

<footer>
  Built by <a href="https://github.com/batwing-studios" target="_blank">NickArthur Night</a> · Batwing Flight Simulation Suite ·
  Auto-published by GitHub Actions · Last built: ${builtAt}
  ${repoUrl ? `· <a href="${repoUrl}" target="_blank">View source</a>` : ''}
</footer>

</body>
</html>`;
}

// ── Main ───────────────────────────────────────────────────────────────────────
function main() {
  // Read optional REPO_URL env (injected by the Actions workflow)
  const repoUrl = process.env.REPO_URL || null;
  const builtAt = new Date().toUTCString();

  console.log(`[build-index] Scanning ${PUBLIC_DIR}`);
  const files = discoverFiles(PUBLIC_DIR);
  console.log(`[build-index] Found ${files.length} file(s)`);

  const datasets = files
    .map(f => { try { return extractMeta(f); } catch (e) { console.warn(`  skip ${f}: ${e.message}`); return null; } })
    .filter(Boolean);

  if (!datasets.length) {
    console.warn('[build-index] No datasets found — writing empty index.');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Copy all geo files into dist/ so they're served from Pages
  for (const filePath of files) {
    const rel     = path.relative(PUBLIC_DIR, filePath);
    const destDir = path.dirname(path.join(OUT_DIR, rel));
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(filePath, path.join(OUT_DIR, rel));
    console.log(`  copied ${rel}`);
  }

  const html = buildHTML(datasets, repoUrl, builtAt);
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html, 'utf8');
  console.log(`[build-index] Written → ${path.join(OUT_DIR, 'index.html')}`);
  console.log(`[build-index] Done — ${datasets.length} dataset(s) indexed.`);
}

main();
