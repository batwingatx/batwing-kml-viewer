#!/usr/bin/env node
/**
 * Batwing Geometry Validator
 * --------------------------
 * Scans every *.geojson and *.kml file passed as CLI args (or auto-discovered
 * under public/) for:
 *
 *   1. Out-of-bounds coordinates   lon ∉ [-180, 180] | lat ∉ [-90, 90]
 *   2. Too-few vertices            < 3 unique ring vertices
 *   3. Duplicate consecutive verts within 1e-9°
 *   4. Self-intersecting rings     via @turf/boolean-valid + kinks()
 *   5. Wrong winding order         GeoJSON exterior ring must be CCW (RFC 7946)
 *   6. Zero-area polygons          |signed area| < 1e-10
 *
 * KML files are converted to GeoJSON via togeojson before scanning.
 *
 * Exit codes:
 *   0  — all files clean
 *   1  — one or more geometry errors found
 *   2  — script/dependency error
 *
 * Usage:
 *   node scripts/validate-geo.js                        # auto-discover public/
 *   node scripts/validate-geo.js path/a.geojson b.kml   # explicit list
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Dependency guards ────────────────────────────────────────────────────────
function require_safe(pkg) {
  try { return require(pkg); }
  catch (e) {
    console.error(`[validate-geo] Missing package: ${pkg}`);
    console.error(`               Run: npm install --save-dev ${pkg}`);
    process.exit(2);
  }
}

const turf       = require_safe('@turf/turf');
const toGeoJSON  = require_safe('@tmcw/togeojson');
const { DOMParser } = require_safe('@xmldom/xmldom');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Signed area of a ring (Shoelace). Positive = CCW. */
function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += (ring[i][0] * ring[i + 1][1]) - (ring[i + 1][0] * ring[i][1]);
  }
  return a / 2;
}

/** Cross product of two 2-D vectors. */
function cross2d(ox, oy, ax, ay, bx, by) {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** True if segments (p1→p2) and (p3→p4) properly intersect. */
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross2d(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1]);
  const d2 = cross2d(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1]);
  const d3 = cross2d(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  const d4 = cross2d(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1]);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

/** Check one coordinate ring, return array of issue objects. */
function checkRing(ring, ringLabel) {
  const issues = [];
  const verts  = ring[ring.length - 1][0] === ring[0][0] &&
                 ring[ring.length - 1][1] === ring[0][1]
                   ? ring.slice(0, -1)   // drop closing duplicate
                   : ring.slice();

  // 1. Vertex count
  if (verts.length < 3) {
    issues.push({ code: 'TOO_FEW_VERTS', ring: ringLabel,
      msg: `Only ${verts.length} unique vertices (need ≥ 3)` });
    return issues; // can't meaningfully continue
  }

  // 2. Out-of-bounds
  verts.forEach(([lon, lat], i) => {
    if (lon < -180 || lon > 180)
      issues.push({ code: 'OUT_OF_BOUNDS', ring: ringLabel,
        msg: `Vertex ${i}: lon ${lon} outside [-180, 180]` });
    if (lat < -90 || lat > 90)
      issues.push({ code: 'OUT_OF_BOUNDS', ring: ringLabel,
        msg: `Vertex ${i}: lat ${lat} outside [-90, 90]` });
  });

  // 3. Duplicate consecutive vertices
  for (let i = 0; i < verts.length; i++) {
    const j = (i + 1) % verts.length;
    const dx = Math.abs(verts[i][0] - verts[j][0]);
    const dy = Math.abs(verts[i][1] - verts[j][1]);
    if (dx < 1e-9 && dy < 1e-9)
      issues.push({ code: 'DUPLICATE_VERTS', ring: ringLabel,
        msg: `Duplicate consecutive vertices at index ${i} and ${j}` });
  }

  // 4. Self-intersection (O(n²), skipped above 400 verts)
  if (verts.length <= 400) {
    const segs = verts.map((v, i) => [v, verts[(i + 1) % verts.length]]);
    outer: for (let i = 0; i < segs.length; i++) {
      for (let j = i + 2; j < segs.length; j++) {
        if (i === 0 && j === segs.length - 1) continue;
        if (segmentsIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) {
          issues.push({ code: 'SELF_INTERSECT', ring: ringLabel,
            msg: `Segment ${i}→${i+1} crosses segment ${j}→${j+1}` });
          break outer; // one report per ring is enough
        }
      }
    }
  } else {
    issues.push({ code: 'SKIP_LARGE', ring: ringLabel,
      msg: `${verts.length} verts — self-intersection scan skipped (> 400)` });
  }

  // 5. Winding order (exterior ring must be CCW, area > 0)
  const area = signedArea(ring);
  if (ringLabel === 'exterior' && area < 0)
    issues.push({ code: 'WRONG_WINDING', ring: ringLabel,
      msg: `Exterior ring is CW (signed area ${area.toFixed(6)}); GeoJSON requires CCW` });

  // 6. Zero area
  if (Math.abs(area) < 1e-10)
    issues.push({ code: 'ZERO_AREA', ring: ringLabel,
      msg: `Polygon has effectively zero area (${area})` });

  return issues;
}

/** Validate a single GeoJSON Feature. Returns array of issue objects. */
function validateFeature(feature, featureName) {
  const issues = [];
  const geom   = feature.geometry;
  if (!geom) return issues;

  const polygons =
    geom.type === 'Polygon'      ? [geom.coordinates] :
    geom.type === 'MultiPolygon' ? geom.coordinates   : [];

  polygons.forEach((poly, pi) => {
    const polyLabel = polygons.length > 1 ? `poly[${pi}]` : '';
    poly.forEach((ring, ri) => {
      const ringLabel = ri === 0 ? 'exterior' : `hole[${ri - 1}]`;
      const label     = [polyLabel, ringLabel].filter(Boolean).join('/');
      checkRing(ring, label).forEach(iss => {
        issues.push({ ...iss, feature: featureName });
      });
    });
  });

  return issues;
}

// ── KML → GeoJSON conversion ─────────────────────────────────────────────────
function kmlToGeoJSON(filePath) {
  const xml = fs.readFileSync(filePath, 'utf8');
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  return toGeoJSON.kml(dom);
}

// ── File discovery ────────────────────────────────────────────────────────────
function discoverFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...discoverFiles(full));
    else if (/\.(geojson|kml)$/i.test(entry.name)) results.push(full);
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const ROOT    = path.resolve(__dirname, '..');
  const PUBLIC  = path.join(ROOT, 'public');

  // Files from CLI args or auto-discovery
  let files = process.argv.slice(2);
  if (!files.length) {
    files = discoverFiles(PUBLIC);
    if (!files.length) {
      console.log('[validate-geo] No .geojson or .kml files found under public/');
      process.exit(0);
    }
  }

  let totalErrors   = 0;
  let totalWarnings = 0;
  let totalFeatures = 0;
  const WARN_CODES  = new Set(['DUPLICATE_VERTS', 'WRONG_WINDING', 'SKIP_LARGE']);

  for (const filePath of files) {
    const rel = path.relative(ROOT, filePath);
    console.log(`\n📂  ${rel}`);

    let geoJSON;
    try {
      if (/\.kml$/i.test(filePath)) {
        geoJSON = kmlToGeoJSON(filePath);
        console.log(`    (converted from KML)`);
      } else {
        geoJSON = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (e) {
      console.error(`    ✖ Parse error: ${e.message}`);
      totalErrors++;
      continue;
    }

    const features =
      geoJSON.type === 'FeatureCollection' ? geoJSON.features :
      geoJSON.type === 'Feature'           ? [geoJSON]        : [];

    console.log(`    ${features.length} feature(s)`);
    totalFeatures += features.length;

    let fileErrors = 0, fileWarns = 0;

    for (const feat of features) {
      const name = (feat.properties && (feat.properties.name || feat.properties.Name)) || '(unnamed)';
      const issues = validateFeature(feat, name);

      for (const iss of issues) {
        const isWarn = WARN_CODES.has(iss.code);
        const icon   = isWarn ? '⚠' : '✖';
        const label  = isWarn ? 'WARN ' : 'ERROR';
        console.log(`    ${icon} [${label}] ${iss.feature} | ${iss.ring} | ${iss.code}: ${iss.msg}`);
        if (isWarn) fileWarns++; else fileErrors++;
      }
    }

    if (fileErrors === 0 && fileWarns === 0) {
      console.log(`    ✅  All features valid`);
    } else {
      console.log(`    ── ${fileErrors} error(s), ${fileWarns} warning(s) in this file`);
    }

    totalErrors   += fileErrors;
    totalWarnings += fileWarns;
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log(`Batwing Geo Validate — ${files.length} file(s), ${totalFeatures} feature(s) scanned`);
  if (totalErrors === 0 && totalWarnings === 0) {
    console.log('✅  All geometry clean. Safe to export.');
    process.exit(0);
  } else {
    if (totalErrors)   console.log(`✖  ${totalErrors} error(s) — fix before export`);
    if (totalWarnings) console.log(`⚠  ${totalWarnings} warning(s) — review recommended`);
    process.exit(totalErrors > 0 ? 1 : 0); // warnings alone don't fail CI
  }
}

main();
