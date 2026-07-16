// ── MAP INIT ──────────────────────────────────────────────────
const map = L.map('map', { center: [22.5, 82.0], zoom: 5, zoomControl: true });

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
  maxZoom: 18
}).addTo(map);

// ── TIF PATH ──────────────────────────────────────────────────
const TIF_PATH = 'data/landscan-india-2024.tif';

// ── GEOTIFF STATE ─────────────────────────────────────────────
let tifImage  = null;
let tifMeta   = {};
let tifData   = null;
let tifNodata = null;

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

// ── MONITOR PLACEMENT STATE ───────────────────────────────────
let placingMonitors   = false;
let monitorTarget     = null;   // { type:'bbox'|'polygon'|'geojson', layer, geojson, areaSqKm }
let monitorPins       = [];     // L.marker instances
let monitorCircles    = [];     // L.circle instances (2km visual)
let targetMonitorCount = 0;

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

// ── CPCB MONITOR CALCULATION ──────────────────────────────────
function numMonitorsCpcb(pollutant, population) {
  let num = [];
  if (pollutant === 'spm') {
    num = [4];
    if (population < 100000) return num.reduce((a,b)=>a+b,0);
    num.push(population > 1000000 ? Math.floor(4+0.6*900000/100000)+1 : Math.floor(4+0.6*(population-100000)/100000)+1);
    num.push(population > 5000000 ? Math.floor(7.5+0.25*4000000/100000)+1 : Math.floor(7.5+0.25*(population-1000000)/100000)+1);
    if (population > 5000000) num.push(Math.floor(12+0.16*(population-5000000)/100000)+1);
  }
  if (pollutant === 'so2') {
    num = [3];
    if (population < 100000) return num.reduce((a,b)=>a+b,0);
    num.push(population > 1000000 ? Math.floor(2.5+0.5*900000/100000)+1 : Math.floor(2.5+0.5*(population-100000)/100000)+1);
    num.push(population > 10000000 ? Math.floor(6+0.15*9000000/100000)+1 : Math.floor(6+0.15*(population-1000000)/100000)+1);
    if (population > 10000000) num.push(20);
  }
  if (pollutant === 'no2') {
    num = [4];
    if (population < 100000) return num.reduce((a,b)=>a+b,0);
    num.push(population > 1000000 ? Math.floor(4+0.6*900000/100000)+1 : Math.floor(4+0.6*(population-100000)/100000)+1);
    if (population > 1000000) num.push(10);
  }
  if (pollutant === 'co') {
    num = [1];
    if (population < 100000) return num.reduce((a,b)=>a+b,0);
    num.push(population > 5000000 ? Math.floor(1+0.15*4900000/100000)+1 : Math.floor(1+0.15*(population-100000)/100000)+1);
    if (population > 5000000) num.push(Math.floor(6+0.05*(population-5000000)/100000)+1);
  }
  return num.reduce((a,b)=>a+b,0);
}

// ── POPULATION FROM BBOX ──────────────────────────────────────
function computePopulation(south, west, north, east) {
  if (!tifData) return null;
  const { originX, originY, pixelW, pixelH, width, height } = tifMeta;
  const colMin = Math.max(0, Math.floor((west-originX)/pixelW));
  const colMax = Math.min(width-1, Math.ceil((east-originX)/pixelW));
  const rowMin = Math.max(0, Math.floor((originY-north)/pixelH));
  const rowMax = Math.min(height-1, Math.ceil((originY-south)/pixelH));
  if (colMin > colMax || rowMin > rowMax) return 0;
  let total = 0;
  for (let row = rowMin; row <= rowMax; row++)
    for (let col = colMin; col <= colMax; col++) {
      const val = tifData[row*width+col];
      if (val === tifNodata || val < 0) continue;
      total += val;
    }
  return Math.round(total);
}

// ── POPULATION FROM POLYGON ───────────────────────────────────
function pointInPolygon(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length-1; i < ring.length; j = i++) {
    const xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
    if (((yi>py)!==(yj>py)) && px<((xj-xi)*(py-yi))/(yj-yi)+xi) inside=!inside;
  }
  return inside;
}

function computePopulationFromRing(ring) {
  if (!tifData) return null;
  const { originX, originY, pixelW, pixelH, width, height } = tifMeta;
  const lngs=ring.map(c=>c[0]), lats=ring.map(c=>c[1]);
  const west=Math.min(...lngs), east=Math.max(...lngs), south=Math.min(...lats), north=Math.max(...lats);
  const colMin=Math.max(0,Math.floor((west-originX)/pixelW));
  const colMax=Math.min(width-1,Math.ceil((east-originX)/pixelW));
  const rowMin=Math.max(0,Math.floor((originY-north)/pixelH));
  const rowMax=Math.min(height-1,Math.ceil((originY-south)/pixelH));
  if (colMin>colMax||rowMin>rowMax) return 0;
  let total=0;
  for (let row=rowMin; row<=rowMax; row++) {
    const pixLat = originY-(row+0.5)*pixelH;
    for (let col=colMin; col<=colMax; col++) {
      const pixLng = originX+(col+0.5)*pixelW;
      if (!pointInPolygon(pixLng, pixLat, ring)) continue;
      const val = tifData[row*width+col];
      if (val===tifNodata||val<0) continue;
      total+=val;
    }
  }
  return Math.round(total);
}

function computePopulationFromGeoJSON(geojson) {
  if (!tifData) return null;
  let total=0;
  function processGeometry(geom) {
    if (!geom) return;
    if (geom.type==='Polygon') total+=computePopulationFromRing(geom.coordinates[0]);
    else if (geom.type==='MultiPolygon') geom.coordinates.forEach(p=>total+=computePopulationFromRing(p[0]));
    else if (geom.type==='GeometryCollection') geom.geometries.forEach(processGeometry);
  }
  if (geojson.type==='FeatureCollection') geojson.features.forEach(f=>processGeometry(f.geometry));
  else if (geojson.type==='Feature') processGeometry(geojson.geometry);
  else processGeometry(geojson);
  return total;
}

// ── AREA CALCULATIONS ─────────────────────────────────────────

// Haversine distance in km between two [lat,lng] points
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Spherical excess area of a polygon ring [[lng,lat],...] in km²
function ringAreaKm2(ring) {
  const R = 6371;
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i+1) % n;
    const lng1 = ring[i][0]*Math.PI/180, lng2 = ring[j][0]*Math.PI/180;
    const lat1 = ring[i][1]*Math.PI/180, lat2 = ring[j][1]*Math.PI/180;
    area += (lng2-lng1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs(area * R * R / 2);
}

// Bbox area in km²
function bboxAreaKm2(south, west, north, east) {
  const ring = [[west,south],[west,north],[east,north],[east,south],[west,south]];
  return ringAreaKm2(ring);
}

// Union area of N circles of radius R km at given [lat,lng] points.
// Uses a rasterised grid approach: sample the bounding box at ~200m resolution,
// count grid cells inside at least one circle, multiply by cell area.
function unionCircleAreaKm2(pins, radiusKm) {
  if (pins.length === 0) return 0;

  const lats = pins.map(p => p[0]), lngs = pins.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

  // Expand bounding box by radiusKm in each direction (approx degrees)
  const dLat = radiusKm / 111.0;
  const dLng = radiusKm / (111.0 * Math.cos((minLat+maxLat)/2 * Math.PI/180));

  const south = minLat - dLat, north = maxLat + dLat;
  const west  = minLng - dLng, east  = maxLng + dLng;

  // Grid resolution: ~200 m
  const gridStepKm = 0.2;
  const stepLat = gridStepKm / 111.0;
  const stepLng = gridStepKm / (111.0 * Math.cos((south+north)/2 * Math.PI/180));
  const cellAreaKm2 = gridStepKm * gridStepKm;

  let count = 0;
  for (let lat = south + stepLat/2; lat < north; lat += stepLat) {
    for (let lng = west + stepLng/2; lng < east; lng += stepLng) {
      // Is this cell centre within radiusKm of ANY pin?
      for (let k = 0; k < pins.length; k++) {
        if (haversineKm(lat, lng, pins[k][0], pins[k][1]) <= radiusKm) {
          count++;
          break;
        }
      }
    }
  }
  return count * cellAreaKm2;
}

// Average pairwise distance between all monitor pins
function avgPairwiseDistKm(pins) {
  if (pins.length < 2) return 0;
  let total = 0, pairs = 0;
  for (let i = 0; i < pins.length; i++)
    for (let j = i+1; j < pins.length; j++) {
      total += haversineKm(pins[i][0], pins[i][1], pins[j][0], pins[j][1]);
      pairs++;
    }
  return total / pairs;
}

// ── MONITOR PLACEMENT ─────────────────────────────────────────

function activateMonitorPlacement(target, count) {
  // Clear any existing pins
  clearMonitorPins();
  placingMonitors  = true;
  monitorTarget    = target;
  targetMonitorCount = count;

  const ind = document.getElementById('mode-indicator');
  ind.classList.add('active');
  ind.innerHTML = `📍 Place Monitor Mode<div class="hint">Click inside shape · ${count} to place</div>`;
  document.body.classList.add('drawing');

  updateMonitorPlacementUI();
}

function clearMonitorPins() {
  monitorPins.forEach(m => map.removeLayer(m));
  monitorCircles.forEach(c => map.removeLayer(c));
  monitorPins = [];
  monitorCircles = [];
}

function stopMonitorPlacement() {
  placingMonitors = false;
  monitorTarget   = null;
  document.body.classList.remove('drawing');
  const ind = document.getElementById('mode-indicator');
  ind.classList.remove('active');
  ind.innerHTML = 'No mode selected<div class="hint">Pick a tool above to start drawing</div>';
}

// Called every time a pin is added or removed
function updateMonitorPlacementUI() {
  const entry = document.getElementById('monitor-placement-entry');
  if (!entry) return;
  const placed = monitorPins.length;
  const total  = targetMonitorCount;
  entry.querySelector('.mp-placed').textContent = `${placed} / ${total} monitors placed`;
  const calcBtn = entry.querySelector('.mp-calc-btn');
  calcBtn.disabled = placed < 2;
  // Update hint in indicator
  const ind = document.getElementById('mode-indicator');
  if (placingMonitors) {
    ind.innerHTML = `📍 Place Monitor Mode<div class="hint">${placed}/${total} placed · click inside shape</div>`;
  }
}

map.on('click', function(e) {
  // Monitor placement click
  if (placingMonitors && monitorTarget) {
    const latlng = e.latlng;

    // Check point is inside the shape
    if (!isPointInTarget(latlng.lat, latlng.lng, monitorTarget)) {
      // Flash the mode indicator red briefly
      const ind = document.getElementById('mode-indicator');
      ind.style.borderColor = '#b84c00';
      ind.style.color = '#b84c00';
      setTimeout(() => {
        ind.style.borderColor = '';
        ind.style.color = '';
      }, 800);
      return;
    }

    const pinNum = monitorPins.length + 1;

    // Numbered marker
    const icon = L.divIcon({
      className: '',
      html: `<div class="monitor-pin">${pinNum}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
    const marker = L.marker(latlng, { icon, draggable: true }).addTo(map);

    // 2 km circle
    const circle = L.circle(latlng, {
      radius: 2000,
      color: '#164D12', weight: 1.2,
      fillColor: '#164D12', fillOpacity: 0.08,
      dashArray: '4 3'
    }).addTo(map);

    // Update circle on drag
    marker.on('drag', function(ev) {
      circle.setLatLng(ev.latlng);
    });
    marker.on('dragend', function(ev) {
      const ll = ev.target.getLatLng();
      if (!isPointInTarget(ll.lat, ll.lng, monitorTarget)) {
        marker.setLatLng(latlng); // snap back
        circle.setLatLng(latlng);
      }
      updateMonitorPlacementUI();
    });

    monitorPins.push(marker);
    monitorCircles.push(circle);
    updateMonitorPlacementUI();

    // Auto-stop if reached target count
    if (monitorPins.length >= targetMonitorCount) {
      const ind = document.getElementById('mode-indicator');
      ind.innerHTML = `✓ ${targetMonitorCount} monitors placed<div class="hint">Click Calculate or add more</div>`;
      placingMonitors = false;
      document.body.classList.remove('drawing');
    }
    return;
  }

  // Polygon drawing click
  if (mode !== 'polygon') return;
  polyPoints.push(e.latlng);
  const dot = L.circleMarker(e.latlng, {
    radius: 6, color: '#164D12', fillColor: '#164D12', fillOpacity: 1, weight: 2
  }).addTo(map);
  polyMarkers.push(dot);
  if (polyLine) map.removeLayer(polyLine);
  if (polyPoints.length > 1)
    polyLine = L.polyline(polyPoints, { color: '#164D12', weight: 2, dashArray: '6 4' }).addTo(map);
  if (polyPoints.length >= 3 && finishPolyBtn) finishPolyBtn.style.display = 'block';
});

function isPointInTarget(lat, lng, target) {
  if (target.type === 'bbox') {
    const b = target.layer.getBounds();
    return lat >= b.getSouth() && lat <= b.getNorth() && lng >= b.getWest() && lng <= b.getEast();
  }
  // polygon / geojson — use ray casting on the ring
  if (target.ring) return pointInPolygon(lng, lat, target.ring);
  return true; // fallback
}

function calculateNetwork(uid) {
  if (monitorPins.length < 2) return;
  const pins = monitorPins.map(m => { const ll = m.getLatLng(); return [ll.lat, ll.lng]; });

  const avgDist   = avgPairwiseDistKm(pins);
  const unionArea = unionCircleAreaKm2(pins, 2);
  const shapeArea = monitorTarget ? monitorTarget.areaSqKm : null;
  const ratio     = shapeArea ? (unionArea / shapeArea) * 100 : null;

  // Find result container: active widget's placeholder, or uid from button
  const activeWidget = document.querySelector('.mp-widget[data-active]');
  const resultUid = activeWidget ? activeWidget.id : uid;
  logNetworkAnalysis(pins.length, avgDist, unionArea, shapeArea, ratio, resultUid);
}

// ── FILE UPLOAD ───────────────────────────────────────────────
function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  const reader = new FileReader();
  reader.onload = function(e) {
    const text = e.target.result;
    const name = file.name;
    let geojson = null;
    try {
      if (name.toLowerCase().endsWith('.kml')) {
        const parser = new DOMParser();
        geojson = toGeoJSON.kml(parser.parseFromString(text, 'text/xml'));
      } else {
        geojson = JSON.parse(text);
      }
    } catch (err) {
      logError(`Could not parse "${name}": ${err.message}`, logCount+1);
      return;
    }
    const hasFeatures = geojson && (
      (geojson.features && geojson.features.length > 0) ||
      ['Polygon','MultiPolygon','Feature'].includes(geojson.type)
    );
    if (!hasFeatures) { logError(`No valid geometry found in "${name}".`, logCount+1); return; }

    const layer = L.geoJSON(geojson, {
      style: { color: '#164D12', weight: 2, fillColor: '#164D12', fillOpacity: 0.10 }
    }).addTo(map);
    map.fitBounds(layer.getBounds(), { padding: [30, 30] });
    shapes.push(layer);

    const bounds = layer.getBounds();
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    logCount++; updateBadge();
    document.getElementById('console-output').querySelector('.empty-state')?.remove();

    // Extract first ring for point-in-polygon
    let ring = null;
    function extractRing(geom) {
      if (!geom) return;
      if (geom.type === 'Polygon') ring = ring || geom.coordinates[0];
      else if (geom.type === 'MultiPolygon') ring = ring || geom.coordinates[0][0];
      else if (geom.type === 'GeometryCollection') geom.geometries.forEach(extractRing);
    }
    if (geojson.type === 'FeatureCollection') geojson.features.forEach(f => extractRing(f.geometry));
    else if (geojson.type === 'Feature') extractRing(geojson.geometry);
    else extractRing(geojson);

    const areaSqKm = ring ? ringAreaKm2(ring) : bboxAreaKm2(sw.lat, sw.lng, ne.lat, ne.lng);

    const featureCount = geojson.features ? geojson.features.length : 1;
    const entry = document.createElement('div');
    entry.className = 'log-entry info';
    entry.innerHTML = `
      <div class="log-ts">${timestamp()}</div>
      <div class="log-type">📁 FILE · ${name}</div>
      <div class="log-coords">${featureCount} feature${featureCount!==1?'s':''}\nSW: [${sw.lat.toFixed(4)}, ${sw.lng.toFixed(4)}]\nNE: [${ne.lat.toFixed(4)}, ${ne.lng.toFixed(4)}]</div>`;
    const out = document.getElementById('console-output');
    out.appendChild(entry); out.scrollTop = out.scrollHeight;

    const population = computePopulationFromGeoJSON(geojson);
    if (population !== null) logPopulation(population, logCount, name, layer, { type:'geojson', layer, ring, areaSqKm });
    else logError('TIF not loaded yet.', logCount);
  };
  reader.readAsText(file);
}

// ── MODE SELECTOR ─────────────────────────────────────────────
function setMode(m) {
  stopMonitorPlacement();
  clearMonitorPins();
  cancelDrawing();
  mode = m;
  document.getElementById('btn-bbox').classList.toggle('active', m==='bbox');
  document.getElementById('btn-poly').classList.toggle('active', m==='polygon');
  const ind = document.getElementById('mode-indicator');
  ind.classList.add('active');
  ind.innerHTML = m==='bbox'
    ? '⬜ Bounding Box Mode<div class="hint">Click &amp; drag to draw a rectangle</div>'
    : '⬡ Polygon Mode<div class="hint">Click to add vertices · Finish button to close</div>';
  document.body.classList.add('drawing');
}

function cancelDrawing() {
  drawing = false; bboxStart = null;
  if (bboxRect && !shapes.includes(bboxRect)) { map.removeLayer(bboxRect); bboxRect = null; }
  polyPoints = [];
  polyMarkers.forEach(m => map.removeLayer(m));
  polyMarkers = [];
  if (polyLine) { map.removeLayer(polyLine); polyLine = null; }
  if (finishPolyBtn) finishPolyBtn.style.display = 'none';
  document.body.classList.remove('drawing');
}

// ── BOUNDING BOX ──────────────────────────────────────────────
map.on('mousedown', function(e) {
  if (mode !== 'bbox') return;
  drawing = true; bboxStart = e.latlng;
  bboxRect = L.rectangle([bboxStart, bboxStart], {
    color: '#164D12', weight: 2, fillColor: '#164D12', fillOpacity: 0.10, dashArray: '6 4'
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
  shapes.push(bboxRect);
  const savedRect = bboxRect;
  bboxRect = null;

  logCoords({ type:'BoundingBox',
    southWest: { lat:+sw.lat.toFixed(6), lng:+sw.lng.toFixed(6) },
    northEast: { lat:+ne.lat.toFixed(6), lng:+ne.lng.toFixed(6) }
  });

  const areaSqKm = bboxAreaKm2(sw.lat, sw.lng, ne.lat, ne.lng);
  const target = { type:'bbox', layer: savedRect, areaSqKm };

  const population = computePopulation(sw.lat, sw.lng, ne.lat, ne.lng);
  if (population !== null) logPopulation(population, logCount, null, savedRect, target);
  else logError('TIF not loaded yet.', logCount);
  mode = null;
  document.getElementById('btn-bbox').classList.remove('active');
  const ind = document.getElementById('mode-indicator');
  ind.classList.remove('active');
  ind.innerHTML = 'No mode selected<div class="hint">Pick a tool above to start drawing</div>';
  document.body.classList.remove('drawing');
});

// ── POLYGON ───────────────────────────────────────────────────
function finishPolygon() {
  if (polyPoints.length < 3) return;
  if (finishPolyBtn) finishPolyBtn.style.display = 'none';
  if (polyLine) { map.removeLayer(polyLine); polyLine = null; }
  polyMarkers.forEach(m => map.removeLayer(m)); polyMarkers = [];
  const finalPoints = [...polyPoints]; polyPoints = [];

  const poly = L.polygon(finalPoints, {
    color: '#164D12', weight: 2, fillColor: '#ff6b35', fillOpacity: 0.12
  }).addTo(map);
  shapes.push(poly);

  logCoords({ type:'Polygon',
    vertices: finalPoints.map((p,i)=>({ index:i, lat:+p.lat.toFixed(6), lng:+p.lng.toFixed(6) })),
    count: finalPoints.length
  });

  const ring = finalPoints.map(p=>[p.lng,p.lat]);
  ring.push(ring[0]);
  const areaSqKm = ringAreaKm2(ring);
  const target = { type:'polygon', layer: poly, ring, areaSqKm };

  const polyGeojson = { type:'Polygon', coordinates:[ring] };
  const population = computePopulationFromGeoJSON(polyGeojson);
  if (population !== null) logPopulation(population, logCount, 'Drawn Polygon', poly, target);
  else logError('TIF not loaded yet.', logCount);

  mode = null;
  document.getElementById('btn-poly').classList.remove('active');
  const ind = document.getElementById('mode-indicator');
  ind.classList.remove('active');
  ind.innerHTML = 'No mode selected<div class="hint">Pick a tool above to start drawing</div>';
  document.body.classList.remove('drawing');
}

// ── CLEAR ALL ─────────────────────────────────────────────────
function clearAll() {
  stopMonitorPlacement();
  clearMonitorPins();
  cancelDrawing();
  shapes.forEach(l => map.removeLayer(l)); shapes = [];
  logCount = 0; updateBadge();
  const out = document.getElementById('console-output');
  out.innerHTML = '';
  const entry = document.createElement('div');
  entry.className = 'log-entry clear';
  entry.innerHTML = `<div class="log-ts">${timestamp()}</div><div class="log-type">✕ ALL CLEARED</div><div class="log-coords">Canvas reset. Ready for new shapes.</div>`;
  out.appendChild(entry);
  mode = null;
  ['btn-bbox','btn-poly'].forEach(id => document.getElementById(id).classList.remove('active'));
  const ind = document.getElementById('mode-indicator');
  ind.classList.remove('active');
  ind.innerHTML = 'No mode selected<div class="hint">Pick a tool above to start drawing</div>';
  document.body.classList.remove('drawing');
}

// ── LOGGING HELPERS ───────────────────────────────────────────
function timestamp() {
  const n = new Date();
  return n.toLocaleTimeString('en-IN', { hour12:false })+'.'+String(n.getMilliseconds()).padStart(3,'0');
}

function updateBadge() {
  document.getElementById('log-count').textContent = logCount===1?'1 shape':`${logCount} shapes`;
}

function logCoords(coords) {
  logCount++; updateBadge();
  const out = document.getElementById('console-output');
  out.querySelector('.empty-state')?.remove();
  const label = coords.type==='BoundingBox' ? `⬜ BBOX #${logCount}` : `⬡ POLYGON #${logCount}`;
  const display = coords.type==='BoundingBox'
    ? `SW: [${coords.southWest.lat}, ${coords.southWest.lng}]\nNE: [${coords.northEast.lat}, ${coords.northEast.lng}]`
    : coords.vertices.map(v=>`[${v.lat}, ${v.lng}]`).join('\n');
  const entry = document.createElement('div');
  entry.className = 'log-entry info';
  entry.innerHTML = `<div class="log-ts">${timestamp()}</div><div class="log-type">${label}</div><div class="log-coords">${display}</div>`;
  out.appendChild(entry); out.scrollTop = out.scrollHeight;
}

// logPopulation now also renders the monitor placement widget
function logPopulation(population, index, label, layer, target) {
  const out = document.getElementById('console-output');
  const millions   = (population/1_000_000).toFixed(2);
  const formatted  = population.toLocaleString('en-IN');
  const pollutants = ['spm','so2','no2','co'];
  const pLabels    = { spm:'SPM', so2:'SO₂', no2:'NO₂', co:'CO' };
  const areaStr    = target ? target.areaSqKm.toFixed(1)+' km²' : '—';

  const monitorsHTML = pollutants.map(p => {
    const n = numMonitorsCpcb(p, population);
    return `<div class="monitor-card"><span class="monitor-pollutant">${pLabels[p]}</span><span class="monitor-val">${n}</span><span class="monitor-unit">stations</span></div>`;
  }).join('');

  // Unique id for this entry's placement widget
  const uid = `mp-${Date.now()}`;

  const entry = document.createElement('div');
  entry.className = 'log-entry population';
  entry.innerHTML = `
    <div class="log-ts">${timestamp()}</div>
    <div class="log-type pop-label">👥 POPULATION · ${label || ('BBOX #'+index)}</div>
    <div class="log-coords">
      <span class="pop-big">${millions}M</span>
      <span class="pop-raw">${formatted} people · ${areaStr}</span>
      <span class="monitors-label">Min. monitors required · CPCB guidelines</span>
      <div class="monitors-grid">${monitorsHTML}</div>
    </div>
    <div class="mp-widget" id="${uid}">
      <div class="mp-title">📍 Place Your Monitors</div>
      <div class="mp-row">
        <label class="mp-lbl">How many stations?</label>
        <input class="mp-input" type="number" min="1" max="200" value="${numMonitorsCpcb('spm',population)}" id="${uid}-count"/>
      </div>
      <div class="mp-row">
        <button class="mp-btn" onclick="startPlacingFromWidget('${uid}')">▶ Start Placing</button>
        <button class="mp-btn mp-btn-clear" onclick="clearMonitorPinsFromWidget('${uid}')">✕ Clear Pins</button>
      </div>
      <div class="mp-placed">0 / ? monitors placed</div>
      <button class="mp-calc-btn" disabled onclick="calculateNetwork('${uid}')">⬛ Calculate Network Coverage</button>
      <div class="net-result" id="${uid}-result"></div>
    </div>`;

  // Store target reference on the DOM element for retrieval
  entry.dataset.uid = uid;
  entry._target = target;

  out.appendChild(entry); out.scrollTop = out.scrollHeight;
}

function startPlacingFromWidget(uid) {
  const entry  = document.getElementById(uid).closest('.log-entry');
  const target = entry ? entry._target : null;
  if (!target) return;
  const count  = parseInt(document.getElementById(`${uid}-count`).value, 10) || 1;

  // Store reference to this widget so updateMonitorPlacementUI can find it
  document.querySelectorAll('.mp-widget').forEach(w => w.removeAttribute('data-active'));
  document.getElementById(uid).setAttribute('data-active', '1');

  clearMonitorPins();
  activateMonitorPlacement(target, count);
}

function clearMonitorPinsFromWidget(uid) {
  clearMonitorPins();
  const widget = document.getElementById(uid);
  if (widget) {
    widget.querySelector('.mp-placed').textContent = '0 / ? monitors placed';
    widget.querySelector('.mp-calc-btn').disabled = true;
  }
  stopMonitorPlacement();
}

// Override updateMonitorPlacementUI to target the active widget
function updateMonitorPlacementUI() {
  const widget = document.querySelector('.mp-widget[data-active]');
  if (!widget) return;
  const placed = monitorPins.length;
  const total  = targetMonitorCount;
  widget.querySelector('.mp-placed').textContent = `${placed} / ${total} monitors placed`;
  widget.querySelector('.mp-calc-btn').disabled = placed < 2;
  const ind = document.getElementById('mode-indicator');
  if (placingMonitors) {
    ind.innerHTML = `📍 Place Monitor Mode<div class="hint">${placed}/${total} placed · click inside shape</div>`;
  }
}

// ── NETWORK ANALYSIS LOG ──────────────────────────────────────
// Writes result into the widget's own .net-result placeholder (replaces on recalculate)
function logNetworkAnalysis(n, avgDist, unionArea, shapeArea, ratio, uid) {
  const ratioStr   = ratio !== null ? ratio.toFixed(1)+'%' : '—';
  const ratioClass = ratio !== null && ratio >= 75 ? 'net-good' : ratio !== null && ratio >= 40 ? 'net-mid' : 'net-low';

  const html = `
    <div class="net-result-inner">
      <div class="net-result-header">
        <span class="net-label-inline">📡 Network Analysis · ${n} stations</span>
        <span class="net-result-ts">${timestamp()}</span>
      </div>
      <div class="net-grid">
        <div class="net-card">
          <span class="net-metric-label">Avg. distance</span>
          <span class="net-metric-val">${avgDist.toFixed(1)}</span>
          <span class="net-metric-unit">km between stations</span>
        </div>
        <div class="net-card">
          <span class="net-metric-label">Area covered</span>
          <span class="net-metric-val">${unionArea.toFixed(0)}</span>
          <span class="net-metric-unit">km² (2 km radius, no overlap)</span>
        </div>
        <div class="net-card net-card-wide ${ratioClass}">
          <span class="net-metric-label">Network representativeness</span>
          <span class="net-metric-val">${ratioStr}</span>
          <span class="net-metric-unit">of total shape area covered</span>
        </div>
      </div>
    </div>`;

  // Replace contents of the result placeholder inside this widget
  const placeholder = document.getElementById(uid + '-result');
  if (placeholder) {
    placeholder.innerHTML = html;
    placeholder.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function logError(msg, index) {
  const out = document.getElementById('console-output');
  const entry = document.createElement('div');
  entry.className = 'log-entry pop-error';
  entry.innerHTML = `<div class="log-ts">${timestamp()}</div><div class="log-type pop-label">⚠ NOTE · #${index}</div><div class="log-coords">${msg}</div>`;
  out.appendChild(entry); out.scrollTop = out.scrollHeight;
}