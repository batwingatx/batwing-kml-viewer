const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'presets.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── preset helpers ───────────────────────────────────────────────
function readPresets() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(_) { return {}; }
}
function writePresets(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── GET all presets ──────────────────────────────────────────────
app.get('/api/presets', (req, res) => res.json(readPresets()));

// ── PUT (upsert) one preset ──────────────────────────────────────
app.put('/api/presets/:key', (req, res) => {
  const all = readPresets();
  all[req.params.key] = { ...req.body, savedAt: Date.now() };
  writePresets(all);
  res.json({ ok: true, key: req.params.key });
});

// ── DELETE one preset ────────────────────────────────────────────
app.delete('/api/presets/:key', (req, res) => {
  const all = readPresets();
  delete all[req.params.key];
  writePresets(all);
  res.json({ ok: true });
});

// ── DELETE all presets ───────────────────────────────────────────
app.delete('/api/presets', (req, res) => {
  writePresets({});
  res.json({ ok: true });
});

// ── POST /api/export  ─────────────────────────────────────────────
// Body: { format: 'geojson'|'kml', filename: string, layers: [...] }
// Each layer: { name, theme, cfg: {fillColor,strokeColor,fillOpacity,strokeWidth}, features: [...GeoJSON features] }
// Returns the serialised file as an attachment download.
app.post('/api/export', (req, res) => {
  const { format, filename, layers } = req.body;
  if (!format || !layers || !Array.isArray(layers)) {
    return res.status(400).json({ error: 'Missing format or layers.' });
  }

  try {
    if (format === 'geojson') {
      // Merge all layers into one FeatureCollection.
      // Each feature gets a _batwing metadata block so reload restores style.
      const features = [];
      for (const layer of layers) {
        for (const f of (layer.features || [])) {
          features.push({
            ...f,
            properties: {
              ...(f.properties || {}),
              _batwing: {
                layerName:   layer.name,
                theme:       layer.theme,
                fillColor:   layer.cfg.fillColor,
                strokeColor: layer.cfg.strokeColor,
                fillOpacity: layer.cfg.fillOpacity,
                strokeWidth: layer.cfg.strokeWidth,
              }
            }
          });
        }
      }
      const geojson = { type: 'FeatureCollection', features };
      const body    = JSON.stringify(geojson, null, 2);
      const fname   = (filename || 'batwing-export').replace(/\.geojson$/i, '') + '.geojson';
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.setHeader('Content-Type', 'application/geo+json');
      return res.send(body);
    }

    if (format === 'kml') {
      // Build a KML document with one Folder per layer.
      // Style is encoded as KML <Style> and also echoed in <ExtendedData> for round-trip.
      function hexToKmlColor(hex, opacity) {
        // KML color format: aabbggrr
        const a = Math.round((opacity || 1) * 255).toString(16).padStart(2, '0');
        const r = hex.slice(1, 3);
        const g = hex.slice(3, 5);
        const b = hex.slice(5, 7);
        return `${a}${b}${g}${r}`;
      }

      function coordsToKml(geometry) {
        if (!geometry) return '';
        const ring2str = ring => ring.map(([lo, la, alt]) => `${lo},${la},${alt || 0}`).join(' ');
        if (geometry.type === 'Polygon') {
          const [outer, ...holes] = geometry.coordinates;
          let kml = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${ring2str(outer)}</coordinates></LinearRing></outerBoundaryIs>`;
          for (const h of holes) kml += `<innerBoundaryIs><LinearRing><coordinates>${ring2str(h)}</coordinates></LinearRing></innerBoundaryIs>`;
          kml += '</Polygon>';
          return kml;
        }
        if (geometry.type === 'MultiPolygon') {
          return `<MultiGeometry>${geometry.coordinates.map(poly => {
            const [outer, ...holes] = poly;
            let kml = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${ring2str(outer)}</coordinates></LinearRing></outerBoundaryIs>`;
            for (const h of holes) kml += `<innerBoundaryIs><LinearRing><coordinates>${ring2str(h)}</coordinates></LinearRing></innerBoundaryIs>`;
            return kml + '</Polygon>';
          }).join('')}</MultiGeometry>`;
        }
        if (geometry.type === 'Point') {
          const [lo, la, alt] = geometry.coordinates;
          return `<Point><coordinates>${lo},${la},${alt || 0}</coordinates></Point>`;
        }
        return '';
      }

      let styleDefs = '';
      let folders   = '';

      for (let li = 0; li < layers.length; li++) {
        const layer  = layers[li];
        const cfg    = layer.cfg || {};
        const styleId = `batwing_style_${li}`;

        const fillKml   = hexToKmlColor(cfg.fillColor   || '#d9a12e', cfg.fillOpacity  ?? 0.4);
        const strokeKml = hexToKmlColor(cfg.strokeColor || '#7a4f1c', 1);

        styleDefs += `
  <Style id="${styleId}">
    <LineStyle>
      <color>${strokeKml}</color>
      <width>${cfg.strokeWidth || 2}</width>
    </LineStyle>
    <PolyStyle>
      <color>${fillKml}</color>
    </PolyStyle>
  </Style>`;

        const placemarks = (layer.features || []).map(f => {
          const p    = f.properties || {};
          const name = p.name || p.Name || p.title || 'Unnamed';
          const desc = p.description || '';

          // ExtendedData — all original properties + Batwing style block
          const allProps = {
            ...p,
            _batwing_layerName:   layer.name,
            _batwing_theme:       layer.theme,
            _batwing_fillColor:   cfg.fillColor,
            _batwing_strokeColor: cfg.strokeColor,
            _batwing_fillOpacity: cfg.fillOpacity,
            _batwing_strokeWidth: cfg.strokeWidth,
          };
          const extData = Object.entries(allProps)
            .filter(([,v]) => v !== null && v !== undefined && typeof v !== 'object')
            .map(([k, v]) => `<Data name="${k}"><value>${String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</value></Data>`)
            .join('\n          ');

          const geomKml = coordsToKml(f.geometry);
          if (!geomKml) return '';

          return `
    <Placemark>
      <name>${name.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</name>
      <description>${desc.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</description>
      <styleUrl>#${styleId}</styleUrl>
      <ExtendedData>
          ${extData}
      </ExtendedData>
      ${geomKml}
    </Placemark>`;
        }).join('');

        folders += `
  <Folder>
    <name>${layer.name.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</name>
    <description>Theme: ${layer.theme} | Batwing KML Export</description>
    ${placemarks}
  </Folder>`;
      }

      const kmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Batwing Export</name>
  <description>Exported from Batwing KML/KMZ/GeoJSON Viewer</description>
  ${styleDefs}
  ${folders}
</Document>
</kml>`;

      const fname = (filename || 'batwing-export').replace(/\.kml$/i, '') + '.kml';
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
      return res.send(kmlBody);
    }

    res.status(400).json({ error: `Unknown format: ${format}` });
  } catch(err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Batwing viewer running on :${PORT}`));
