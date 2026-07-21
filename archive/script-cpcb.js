// ── MAP INIT ──────────────────────────────────────────────────
const map = L.map('map', { center: [22.5, 82.0], zoom: 5, zoomControl: true });

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 18
}).addTo(map);

// ── INDIA OFFICIAL BOUNDARY OVERLAY ──────────────────────────
(async function loadIndiaBoundary() {
  try {
    const resp = await fetch('data/india_boundary.geojson');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const geojson = await resp.json();
    L.geoJSON(geojson, {
      style: {
        color: '#333333',
        weight: 1.8,
        opacity: 1,
        fillColor: 'transparent',
        fillOpacity: 0,
        dashArray: null
      },
      interactive: false
    }).addTo(map);
  } catch (err) {
    console.warn('[Boundary] Could not load india_boundary.geojson:', err.message);
  }
})();

// ── TIF PATH & GEOTIFF STATE ──────────────────────────────────
const TIF_PATH = 'data/landscan-india-2024.tif';
let tifImage  = null;
let tifMeta   = {};
let tifData   = null;
let tifNodata = null;

// ── CSV PATH & STATION STATE ──────────────────────────────────
const CSV_PATH = 'data/cpcb_sites_202607.csv';
let allStations  = [];
let stationLayer = null;

// ── DRAWING STATE ─────────────────────────────────────────────
let mode        = null;
let drawing     = false;
let shapes      = [];
let logCount    = 0;
let bboxStart   = null;
let bboxRect    = null;
let polyPoints  = [];
let polyLine    = null;
let polyMarkers = [];

const finishPolyBtn = document.getElementById('btn-finish-poly');
if (finishPolyBtn) {
  finishPolyBtn.addEventListener('click', function(e) {
    L.DomEvent.stopPropagation(e);
    finishPolygon();
  });
}

// ── LOAD TIF ON STARTUP ───────────────────────────────────────
(async function loadTif() {
  setTifStatus('loading', 'Loading LandScan raster…');
  try {
    const resp = await fetch(TIF_PATH);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — is the file committed to your repo at ${TIF_PATH}?`);
    const arrayBuffer = await resp.arrayBuffer();
    const tif = await GeoTIFF.fromArrayBuffer(arrayBuffer);
    tifImage  = await tif.getImage();
    const bbox    = tifImage.getBoundingBox();
    const fileDir = tifImage.getFileDirectory();
    tifNodata = fileDir.GDAL_NODATA !== undefined ? parseFloat(fileDir.GDAL_NODATA) : null;
    tifMeta = {
      originX: bbox[0], originY: bbox[3],
      pixelW: (bbox[2] - bbox[0]) / tifImage.getWidth(),
      pixelH: (bbox[3] - bbox[1]) / tifImage.getHeight(),
      width: tifImage.getWidth(), height: tifImage.getHeight()
    };
    const rasters = await tifImage.readRasters({ interleave: false });
    tifData = rasters[0];
    setTifStatus('ready', `✓ LandScan loaded · ${tifMeta.width}×${tifMeta.height} px`);
  } catch (err) {
    setTifStatus('error', `✗ ${err.message}`);
  }
})();

function setTifStatus(state, text) {
  const bar  = document.getElementById('tif-status');
  const span = document.getElementById('tif-status-text');
  bar.className = `tif-status ${state}`;
  span.textContent = text;
}

// ── LOAD CSV ON STARTUP ───────────────────────────────────────
(async function loadStations() {
  setStationStatus('loading', 'Loading CPCB stations…');
  try {
    const resp = await fetch(CSV_PATH);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — check that ${CSV_PATH} is committed to your repo`);
    const text = await resp.text();
    allStations = parseCSV(text);
    if (allStations.length === 0) throw new Error('No rows parsed — check CSV has latitude/longitude columns');
    renderStationMarkers();
    setStationStatus('ready', `✓ ${allStations.length} CPCB stations loaded`);
  } catch (err) {
    setStationStatus('error', `✗ ${err.message}`);
  }
})();

// ── CSV PARSER ────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const latIdx  = headers.findIndex(h => h.toLowerCase() === 'latitude');
  const lngIdx  = headers.findIndex(h => h.toLowerCase() === 'longitude');
  const nameIdx = headers.findIndex(h => ['name','station','site','location_name','site_name'].includes(h.toLowerCase()));

  if (latIdx === -1 || lngIdx === -1) {
    throw new Error('CSV must have "latitude" and "longitude" columns');
  }

  const stations = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    const lat  = parseFloat(cols[latIdx]);
    const lng  = parseFloat(cols[lngIdx]);
    if (isNaN(lat) || isNaN(lng)) continue;
    stations.push({
      lat, lng,
      name: nameIdx >= 0 ? (cols[nameIdx] || '').replace(/^"|"$/g, '') : `Station ${i}`
    });
  }
  return stations;
}

function splitCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

// ── STATION MARKERS ───────────────────────────────────────────
function renderStationMarkers() {
  if (stationLayer) map.removeLayer(stationLayer);
  stationLayer = L.layerGroup();

  allStations.forEach(s => {
    L.circle([s.lat, s.lng], {
      radius: 2000,
      color: '#164D12', weight: 0.8,
      fillColor: '#164D12', fillOpacity: 0.06,
      dashArray: '4 3',
      interactive: false
    }).addTo(stationLayer);

    const marker = L.circleMarker([s.lat, s.lng], {
      radius: 5,
      color: '#164D12',
      fillColor: '#164D12',
      fillOpacity: 0.75,
      weight: 1.5
    });
    marker.bindTooltip(s.name, { direction: 'top', offset: [0, -6], className: 'station-tooltip' });
    stationLayer.addLayer(marker);
  });

  stationLayer.addTo(map);
}

function setStationStatus(state, text) {
  const bar  = document.getElementById('station-status');
  const span = document.getElementById('station-status-text');
  if (bar && span) {
    bar.className = `tif-status ${state}`;
    span.textContent = text;
  }
}

// ── POPULATION ENGINES ────────────────────────────────────────
function computePopulation(south, west, north, east) {
  if (!tifData) return null;
  const { originX, originY, pixelW, pixelH, width, height } = tifMeta;
  const colMin = Math.max(0, Math.floor((west - originX) / pixelW));
  const colMax = Math.min(width - 1, Math.ceil((east - originX) / pixelW));
  const rowMin = Math.max(0, Math.floor((originY - north) / pixelH));
  const rowMax = Math.min(height - 1, Math.ceil((originY - south) / pixelH));
  if (colMin > colMax || rowMin > rowMax) return 0;
  let total = 0;
  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) {
      const val = tifData[row * width + col];
      if (val === tifNodata || val < 0) continue;
      total += val;
    }
  }
  return Math.round(total);
}

function computePopulationFromRing(ring) {
  if (!tifData) return null;
  const { originX, originY, pixelW, pixelH, width, height } = tifMeta;
  const lngs = ring.map(c => c[0]), lats = ring.map(c => c[1]);
  const west = Math.min(...lngs), east = Math.max(...lngs), south = Math.min(...lats), north = Math.max(...lats);
  const colMin = Math.max(0, Math.floor((west - originX) / pixelW));
  const colMax = Math.min(width - 1, Math.ceil((east - originX) / pixelW));
  const rowMin = Math.max(0, Math.floor((originY - north) / pixelH));
  const rowMax = Math.min(height - 1, Math.ceil((originY - south) / pixelH));
  if (colMin > colMax || rowMin > rowMax) return 0;
  let total = 0;
  for (let row = rowMin; row <= rowMax; row++) {
    const pixLat = originY - (row + 0.5) * pixelH;
    for (let col = colMin; col <= colMax; col++) {
      const pixLng = originX + (col + 0.5) * pixelW;
      if (!pointInPolygon(pixLng, pixLat, ring)) continue;
      const val = tifData[row * width + col];
      if (val === tifNodata || val < 0) continue;
      total += val;
    }
  }
  return Math.round(total);
}

function numMonitorsCpcb(pollutant, population) {
  let num = [];
  if (pollutant === 'spm') {
    num = [4];
    if (population < 100000) return num.reduce((a, b) => a + b, 0);
    num.push(population > 1000000 ? Math.floor(4 + 0.6 * 900000 / 100000) + 1 : Math.floor(4 + 0.6 * (population - 100000) / 100000) + 1);
    num.push(population > 5000000 ? Math.floor(7.5 + 0.25 * 4000000 / 100000) + 1 : Math.floor(7.5 + 0.25 * (population - 1000000) / 100000) + 1);
    if (population > 5000000) num.push(Math.floor(12 + 0.16 * (population - 5000000) / 100000) + 1);
  }
  if (pollutant === 'so2') {
    num = [3];
    if (population < 100000) return num.reduce((a, b) => a + b, 0);
    num.push(population > 1000000 ? Math.floor(2.5 + 0.5 * 900000 / 100000) + 1 : Math.floor(2.5 + 0.5 * (population - 100000) / 100000) + 1);
    num.push(population > 10000000 ? Math.floor(6 + 0.15 * 9000000 / 100000) + 1 : Math.floor(6 + 0.15 * (population - 1000000) / 100000) + 1);
    if (population > 10000000) num.push(20);
  }
  if (pollutant === 'no2') {
    num = [4];
    if (population < 100000) return num.reduce((a, b) => a + b, 0);
    num.push(population > 1000000 ? Math.floor(4 + 0.6 * 900000 / 100000) + 1 : Math.floor(4 + 0.6 * (population - 100000) / 100000) + 1);
    if (population > 1000000) num.push(10);
  }
  if (pollutant === 'co') {
    num = [1];
    if (population < 100000) return num.reduce((a, b) => a + b, 0);
    num.push(population > 5000000 ? Math.floor(1 + 0.15 * 4900000 / 100000) + 1 : Math.floor(1 + 0.15 * (population - 100000) / 100000) + 1);
    if (population > 5000000) num.push(Math.floor(6 + 0.05 * (population - 5000000) / 100000) + 1);
  }
  return num.reduce((a, b) => a + b, 0);
}

// ── GEOMETRY HELPERS ──────────────────────────────────────────
function pointInPolygon(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function ringAreaKm2(ring) {
  const R = 6371;
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const lng1 = ring[i][0] * Math.PI / 180, lng2 = ring[j][0] * Math.PI / 180;
    const lat1 = ring[i][1] * Math.PI / 180, lat2 = ring[j][1] * Math.PI / 180;
    area += (lng2 - lng1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs(area * R * R / 2);
}

function bboxAreaKm2(south, west, north, east) {
  return ringAreaKm2([[west,south],[west,north],[east,north],[east,south],[west,south]]);
}

function unionCircleAreaKm2(pins, radiusKm) {
  if (pins.length === 0) return 0;
  const lats = pins.map(p => p[0]), lngs = pins.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const dLat = radiusKm / 111.0;
  const dLng = radiusKm / (111.0 * Math.cos((minLat + maxLat) / 2 * Math.PI / 180));
  const south = minLat - dLat, north = maxLat + dLat;
  const west  = minLng - dLng, east  = maxLng + dLng;
  const gridStepKm = 0.2;
  const stepLat = gridStepKm / 111.0;
  const stepLng = gridStepKm / (111.0 * Math.cos((south + north) / 2 * Math.PI / 180));
  const cellAreaKm2 = gridStepKm * gridStepKm;
  let count = 0;
  for (let lat = south + stepLat / 2; lat < north; lat += stepLat)
    for (let lng = west + stepLng / 2; lng < east; lng += stepLng)
      for (let k = 0; k < pins.length; k++)
        if (haversineKm(lat, lng, pins[k][0], pins[k][1]) <= radiusKm) { count++; break; }
  return count * cellAreaKm2;
}

function avgNearestNeighborDistKm(pins) {
  if (pins.length < 2) return 0;
  let sumMinDistances = 0;
  for (let i = 0; i < pins.length; i++) {
    let minDist = Infinity;
    for (let j = 0; j < pins.length; j++) {
      if (i === j) continue;
      const dist = haversineKm(pins[i][0], pins[i][1], pins[j][0], pins[j][1]);
      if (dist < minDist) minDist = dist;
    }
    sumMinDistances += minDist;
  }
  return sumMinDistances / pins.length;
}

// ── STATIONS INSIDE SHAPE ─────────────────────────────────────
function stationsInsideBbox(south, west, north, east) {
  return allStations.filter(s => s.lat >= south && s.lat <= north && s.lng >= west && s.lng <= east);
}

function stationsInsideRing(ring) {
  return allStations.filter(s => pointInPolygon(s.lng, s.lat, ring));
}

// ── HIGHLIGHT STATIONS INSIDE SHAPE ──────────────────────────
let highlightLayer = null;
function highlightStations(stations) {
  if (highlightLayer) map.removeLayer(highlightLayer);
  highlightLayer = L.layerGroup();
  stations.forEach((s, i) => {
    const marker = L.circleMarker([s.lat, s.lng], {
      radius: 7,
      color: '#fff',
      fillColor: '#164D12',
      fillOpacity: 1,
      weight: 2
    });
    marker.bindTooltip(`${i + 1}. ${s.name}`, { direction: 'top', offset: [0, -8], className: 'station-tooltip' });
    highlightLayer.addLayer(marker);

    L.circle([s.lat, s.lng], {
      radius: 2000,
      color: '#164D12', weight: 1,
      fillColor: '#164D12', fillOpacity: 0.07,
      dashArray: '4 3'
    }).addTo(highlightLayer);
  });
  highlightLayer.addTo(map);
}

// ── ANALYSE AND LOG ───────────────────────────────────────────
function analyseShape(stations, areaSqKm, shapeLabel, population) {
  const n = stations.length;

  if (n === 0) {
    logResult(shapeLabel, areaSqKm, population, 0, null, null, null);
    return;
  }

  const pins    = stations.map(s => [s.lat, s.lng]);
  const avgDist = n >= 2 ? avgNearestNeighborDistKm(pins) : null;
  const covered = unionCircleAreaKm2(pins, 2);
  const ratio   = (covered / areaSqKm) * 100;

  highlightStations(stations);
  logResult(shapeLabel, areaSqKm, population, n, avgDist, covered, ratio);
}

// ── MODE SELECTOR ─────────────────────────────────────────────
function setMode(m) {
  cancelDrawing();
  mode = m;
  document.getElementById('btn-bbox').classList.toggle('active', m === 'bbox');
  document.getElementById('btn-poly').classList.toggle('active', m === 'polygon');
  const ind = document.getElementById('mode-indicator');
  ind.classList.add('active');
  ind.innerHTML = m === 'bbox'
    ? '⬜ Bounding Box Mode<div class="hint">Click &amp; drag to draw a rectangle</div>'
    : '⬡ Polygon Mode<div class="hint">Click to add vertices · Finish button to close</div>';
  document.body.classList.add('drawing');
}

function cancelDrawing() {
  drawing = false; bboxStart = null;
  if (bboxRect && !shapes.includes(bboxRect)) { map.removeLayer(bboxRect); bboxRect = null; }
  polyPoints = [];
  polyMarkers.forEach(m => map.removeLayer(m)); polyMarkers = [];
  if (polyLine) { map.removeLayer(polyLine); polyLine = null; }
  if (finishPolyBtn) finishPolyBtn.style.display = 'none';
  document.body.classList.remove('drawing');
}

// ── BOUNDING BOX ──────────────────────────────────────────────
map.on('mousedown', function(e) {
  if (mode !== 'bbox') return;
  drawing = true; bboxStart = e.latlng;
  bboxRect = L.rectangle([bboxStart, bboxStart], {
    color: '#164D12', weight: 2, fillColor: '#164D12', fillOpacity: 0.08, dashArray: '6 4'
  }).addTo(map);
  map.dragging.disable();
});

map.on('mousemove', function(e) {
  if (mode !== 'bbox' || !drawing || !bboxRect) return;
  bboxRect.setBounds([bboxStart, e.latlng]);
});

map.on('mouseup', function(e) {
  if (mode !== 'bbox' || !drawing) return;
  drawing = false; map.dragging.enable();
  bboxRect.setStyle({ dashArray: null });

  const bounds = bboxRect.getBounds();
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  shapes.push(bboxRect); bboxRect = null;

  logCount++; updateBadge();
  document.getElementById('console-output').querySelector('.empty-state')?.remove();

  const areaSqKm   = bboxAreaKm2(sw.lat, sw.lng, ne.lat, ne.lng);
  const inside     = stationsInsideBbox(sw.lat, sw.lng, ne.lat, ne.lng);
  const population = computePopulation(sw.lat, sw.lng, ne.lat, ne.lng);
  analyseShape(inside, areaSqKm, `BBOX #${logCount}`, population);

  mode = null;
  document.getElementById('btn-bbox').classList.remove('active');
  resetIndicator();
});

// ── POLYGON ───────────────────────────────────────────────────
map.on('click', function(e) {
  if (mode !== 'polygon') return;
  polyPoints.push(e.latlng);
  const dot = L.circleMarker(e.latlng, {
    radius: 6, color: '#ff6b35', fillColor: '#ff6b35', fillOpacity: 1, weight: 2
  }).addTo(map);
  polyMarkers.push(dot);
  if (polyLine) map.removeLayer(polyLine);
  if (polyPoints.length > 1)
    polyLine = L.polyline(polyPoints, { color: '#ff6b35', weight: 2, dashArray: '6 4' }).addTo(map);
  if (polyPoints.length >= 3 && finishPolyBtn) finishPolyBtn.style.display = 'block';
});

function finishPolygon() {
  if (polyPoints.length < 3) return;
  if (finishPolyBtn) finishPolyBtn.style.display = 'none';
  if (polyLine) { map.removeLayer(polyLine); polyLine = null; }
  polyMarkers.forEach(m => map.removeLayer(m)); polyMarkers = [];
  const finalPoints = [...polyPoints]; polyPoints = [];

  const poly = L.polygon(finalPoints, {
    color: '#ff6b35', weight: 2, fillColor: '#ff6b35', fillOpacity: 0.10
  }).addTo(map);
  shapes.push(poly);

  logCount++; updateBadge();
  document.getElementById('console-output').querySelector('.empty-state')?.remove();

  const ring = finalPoints.map(p => [p.lng, p.lat]);
  ring.push(ring[0]);
  const areaSqKm   = ringAreaKm2(ring);
  const inside     = stationsInsideRing(ring);
  const population = computePopulationFromRing(ring);
  analyseShape(inside, areaSqKm, `POLYGON #${logCount}`, population);

  mode = null;
  document.getElementById('btn-poly').classList.remove('active');
  resetIndicator();
}

// ── FILE UPLOAD ───────────────────────────────────────────────
function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  const reader = new FileReader();
  reader.onload = function(e) {
    const text = e.target.result;
    let geojson;
    try {
      if (file.name.toLowerCase().endsWith('.kml')) {
        const parser = new DOMParser();
        geojson = toGeoJSON ? toGeoJSON.kml(parser.parseFromString(text, 'text/xml'))
                            : JSON.parse(text);
      } else {
        geojson = JSON.parse(text);
      }
    } catch (err) {
      alert(`Could not parse "${file.name}": ${err.message}`); return;
    }

    const layer = L.geoJSON(geojson, {
      style: { color: '#164D12', weight: 2, fillColor: '#164D12', fillOpacity: 0.08 }
    }).addTo(map);
    map.fitBounds(layer.getBounds(), { padding: [30, 30] });
    shapes.push(layer);

    logCount++; updateBadge();
    document.getElementById('console-output').querySelector('.empty-state')?.remove();

    let ring = null;
    function extractRing(geom) {
      if (!geom || ring) return;
      if (geom.type === 'Polygon') ring = geom.coordinates[0];
      else if (geom.type === 'MultiPolygon') ring = geom.coordinates[0][0];
      else if (geom.type === 'GeometryCollection') geom.geometries.forEach(extractRing);
    }
    if (geojson.type === 'FeatureCollection') geojson.features.forEach(f => extractRing(f.geometry));
    else if (geojson.type === 'Feature') extractRing(geojson.geometry);
    else extractRing(geojson);

    const bounds  = layer.getBounds();
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    const areaSqKm   = ring ? ringAreaKm2(ring) : bboxAreaKm2(sw.lat, sw.lng, ne.lat, ne.lng);
    const inside     = ring ? stationsInsideRing(ring) : stationsInsideBbox(sw.lat, sw.lng, ne.lat, ne.lng);
    const population = ring ? computePopulationFromRing(ring) : computePopulation(sw.lat, sw.lng, ne.lat, ne.lng);

    analyseShape(inside, areaSqKm, file.name, population);
  };
  reader.readAsText(file);
}

// ── CLEAR ─────────────────────────────────────────────────────
function clearAll() {
  cancelDrawing();
  shapes.forEach(l => map.removeLayer(l)); shapes = [];
  if (highlightLayer) { map.removeLayer(highlightLayer); highlightLayer = null; }
  logCount = 0; updateBadge();
  const out = document.getElementById('console-output');
  out.innerHTML = '';
  const entry = document.createElement('div');
  entry.className = 'log-entry clear';
  entry.innerHTML = `<div class="log-ts">${timestamp()}</div><div class="log-type">✕ ALL CLEARED</div><div class="log-coords">Canvas reset.</div>`;
  out.appendChild(entry);
  mode = null;
  ['btn-bbox','btn-poly'].forEach(id => document.getElementById(id).classList.remove('active'));
  resetIndicator();
  document.body.classList.remove('drawing');
}

// ── LOGGING ───────────────────────────────────────────────────
function timestamp() {
  const n = new Date();
  return n.toLocaleTimeString('en-IN', { hour12: false }) + '.' + String(n.getMilliseconds()).padStart(3, '0');
}

function updateBadge() {
  document.getElementById('log-count').textContent = logCount === 1 ? '1 shape' : `${logCount} shapes`;
}

function resetIndicator() {
  const ind = document.getElementById('mode-indicator');
  ind.classList.remove('active');
  ind.innerHTML = 'No mode selected<div class="hint">Pick a tool above to start drawing</div>';
  document.body.classList.remove('drawing');
}

function logResult(shapeLabel, areaSqKm, population, n, avgDist, covered, ratio) {
  const out = document.getElementById('console-output');
  const ratioStr   = ratio !== null ? ratio.toFixed(1) + '%' : '—';
  const ratioClass = ratio === null ? '' : ratio >= 75 ? 'net-good' : ratio >= 40 ? 'net-mid' : 'net-low';
  const avgDistStr = avgDist !== null ? avgDist.toFixed(1) + ' km' : '—';
  const coveredStr = covered !== null ? covered.toFixed(0) + ' km²' : '—';

  const pollutants = ['spm','so2','no2','co'];
  const pLabels    = { spm:'SPM', so2:'SO₂', no2:'NO₂', co:'CO' };
  let popHTML = '';
  if (population !== null) {
    const millions  = (population / 1_000_000).toFixed(2);
    const formatted = population.toLocaleString('en-IN');
    const monitorsHTML = pollutants.map(p => {
      const val = numMonitorsCpcb(p, population);
      return `<div class="monitor-card"><span class="monitor-pollutant">${pLabels[p]}</span><span class="monitor-val">${val}</span><span class="monitor-unit">stations</span></div>`;
    }).join('');
    popHTML = `
      <div class="pop-block">
        <div class="pop-block-label">👥 Population <span class="pop-source">· LandScan Global 2024</span></div>
        <span class="pop-big">${millions} Millions \n ${areaSqKm.toFixed(0)} km² </span>
        <span class="monitors-label">Min. monitors required</span><span class="sub-label">CPCB guidelines</span>
        <div class="monitors-grid">${monitorsHTML}</div>
      </div>`;
  } else {
    popHTML = `<div class="pop-block pop-unavail">Population data loading… draw again once LandScan is ready.</div>`;
  }

  const noStationsMsg = n === 0
    ? `<div class="no-stations-msg">No CPCB stations found within this region.</div>`
    : '';

  const entry = document.createElement('div');
  entry.className = 'log-entry network';
  entry.innerHTML = `
    <div class="log-coords">
      ${popHTML}
      <div class="section-divider">📡 Existing CPCB Network · ${n} station${n !== 1 ? 's' : ''}</div>
      ${noStationsMsg}
      ${n > 0 ? `
      <div class="net-grid">
        <div class="net-card">
          <span class="net-metric-label">Stations inside</span>
          <span class="net-metric-val">${n}</span>
          <span class="net-metric-unit">CPCB monitoring sites</span>
        </div>
        <div class="net-card">
          <span class="net-metric-label">Avg. Nearest Neighbor</span>
          <span class="net-metric-val">${avgDistStr}</span>
          <span class="net-metric-unit">to closest station</span>
        </div>
        <div class="net-card">
          <span class="net-metric-label">Area covered</span>
          <span class="net-metric-val">${coveredStr}</span>
          <span class="net-metric-unit">2 km radius, no overlap</span>
        </div>
        <div class="net-card net-card-wide ${ratioClass}">
          <span class="net-metric-label">Network representativeness</span>
          <span class="net-metric-val">${ratioStr}</span>
          <span class="net-metric-unit">of total region area covered</span>
        </div>
      </div>` : ''}
    </div>`;

  out.appendChild(entry);
  out.scrollTop = out.scrollHeight;
}