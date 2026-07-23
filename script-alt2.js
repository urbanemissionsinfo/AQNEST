let currentPopulation = null;
// ── MAP INIT ──────────────────────────────────────────────────
const map = L.map('map', { center: [22.5, 82.0], zoom: 5, zoomControl: true });

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
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

// ── TIF PATH ──────────────────────────────────────────────────
const TIF_PATH = 'data/landscan-india-2024-compressed.tif';

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
// ── WEIGHTED URBAN AREA CALCULATIONS ──────────────────────────

function computeWeightedAreaFromBbox(south, west, north, east) {
  if (!tifData) return null;
  const { originX, originY, pixelW, pixelH, width, height } = tifMeta;
  
  const colMin = Math.max(0, Math.floor((west - originX) / pixelW));
  const colMax = Math.min(width - 1, Math.ceil((east - originX) / pixelW));
  const rowMin = Math.max(0, Math.floor((originY - north) / pixelH));
  const rowMax = Math.min(height - 1, Math.ceil((originY - south) / pixelH));
  
  if (colMin > colMax || rowMin > rowMax) return 0;
  
  let numUrb = 0;
  let numRur = 0;
  
  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) {
      const val = tifData[row * width + col];
      if (val === tifNodata || val < 0) continue; // Skip nan/nodata
      
      if (val >= 500) {
        numUrb++;
      } else {
        numRur++;
      }
    }
  }
  
  const cellArea = 0.798; // km2 - matching your Python spatial resolution assumption
  return (cellArea * numUrb) + (0.1 * cellArea * numRur);
}

function computeWeightedAreaFromRing(ring) {
  if (!tifData) return null;
  const { originX, originY, pixelW, pixelH, width, height } = tifMeta;
  
  const lngs = ring.map(c => c[0]), lats = ring.map(c => c[1]);
  const west = Math.min(...lngs), east = Math.max(...lngs);
  const south = Math.min(...lats), north = Math.max(...lats);
  
  const colMin = Math.max(0, Math.floor((west - originX) / pixelW));
  const colMax = Math.min(width - 1, Math.ceil((east - originX) / pixelW));
  const rowMin = Math.max(0, Math.floor((originY - north) / pixelH));
  const rowMax = Math.min(height - 1, Math.ceil((originY - south) / pixelH));
  
  if (colMin > colMax || rowMin > rowMax) return 0;
  
  let numUrb = 0;
  let numRur = 0;
  
  for (let row = rowMin; row <= rowMax; row++) {
    const pixLat = originY - (row + 0.5) * pixelH;
    for (let col = colMin; col <= colMax; col++) {
      const pixLng = originX + (col + 0.5) * pixelW;
      
      if (!pointInPolygon(pixLng, pixLat, ring)) continue;
      
      const val = tifData[row * width + col];
      if (val === tifNodata || val < 0) continue;
      
      if (val >= 500) {
        numUrb++;
      } else {
        numRur++;
      }
    }
  }
  
  const cellArea = 0.798; // km2
  return (cellArea * numUrb) + (0.1 * cellArea * numRur);
}
function computeWeightedAreaFromGeoJSON(geojson) {
  if (!tifData) return null;
  let total = 0;
  
  function processGeometry(geom) {
    if (!geom) return;
    if (geom.type === 'Polygon') {
      const area = computeWeightedAreaFromRing(geom.coordinates[0]);
      if (area) total += area;
    }
    else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach(p => {
        const area = computeWeightedAreaFromRing(p[0]);
        if (area) total += area;
      });
    }
    else if (geom.type === 'GeometryCollection') {
      geom.geometries.forEach(processGeometry);
    }
  }
  
  if (geojson.type === 'FeatureCollection') {
    geojson.features.forEach(f => processGeometry(f.geometry));
  } else if (geojson.type === 'Feature') {
    processGeometry(geojson.geometry);
  } else {
    processGeometry(geojson);
  }
  
  return total;
}
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

// Total area of a GeoJSON object in km², summed across every Polygon/MultiPolygon
// part in every feature (outer rings add area, holes subtract it). Unlike picking
// a single "first ring", this correctly handles FeatureCollections and MultiPolygons
// with several disjoint parts (districts, islands, etc.).
function geoJsonAreaKm2(geojson) {
  let total = 0;

  function addPolygon(coords) {
    if (!coords || coords.length === 0) return;
    total += ringAreaKm2(coords[0]);          // outer ring
    for (let i = 1; i < coords.length; i++) {  // holes
      total -= ringAreaKm2(coords[i]);
    }
  }

  function walkGeometry(geom) {
    if (!geom) return;
    if (geom.type === 'Polygon') {
      addPolygon(geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach(addPolygon);
    } else if (geom.type === 'GeometryCollection') {
      geom.geometries.forEach(walkGeometry);
    }
  }

  if (geojson.type === 'FeatureCollection') {
    geojson.features.forEach(f => walkGeometry(f.geometry));
  } else if (geojson.type === 'Feature') {
    walkGeometry(geojson.geometry);
  } else {
    walkGeometry(geojson);
  }

  return Math.abs(total);
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



// ── MONITOR PLACEMENT ─────────────────────────────────────────

function activateMonitorPlacement(target, count) {
  // Clear any existing pins
  clearMonitorPins();
  placingMonitors  = true;
  monitorTarget    = target;
  targetMonitorCount = count;

  const ind = document.getElementById('mode-indicator');
  ind.classList.add('active');
  
  // Enhanced visual feedback in the indicator
  ind.style.backgroundColor = '#164D12';
  ind.style.color = 'white';
  
  ind.innerHTML = `📍 Place Monitor Mode<div class="hint">Click inside shape to place ${count} monitors</div>`;
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
  
  // NEW: Traverse the entire GeoJSON structure
  if (target.type === 'geojson' && target.geojson) {
    let inside = false;
    
    function processGeometry(geom) {
      if (!geom || inside) return; // Stop checking if we already found it
      if (geom.type === 'Polygon') {
        if (pointInPolygon(lng, lat, geom.coordinates[0])) inside = true;
      }
      else if (geom.type === 'MultiPolygon') {
        geom.coordinates.forEach(p => {
          if (pointInPolygon(lng, lat, p[0])) inside = true;
        });
      }
      else if (geom.type === 'GeometryCollection') {
        geom.geometries.forEach(processGeometry);
      }
    }
    
    if (target.geojson.type === 'FeatureCollection') {
      target.geojson.features.forEach(f => processGeometry(f.geometry));
    } else if (target.geojson.type === 'Feature') {
      processGeometry(target.geojson.geometry);
    } else {
      processGeometry(target.geojson);
    }
    
    return inside;
  }

  // Fallback for manually drawn simple polygons
  if (target.ring) return pointInPolygon(lng, lat, target.ring);
  
  return true; // ultimate fallback
}

function calculateNetwork(uid) {
  const widget = document.getElementById(uid);
  const entry  = widget ? widget.closest('.log-entry') : null;
  const target = (entry && entry._target) ? entry._target : monitorTarget;
  if (!target) return;

  const csvPins = target.csvPins || [];
  // Only include newly-placed pins if this widget is the one currently active for placement
  const isActiveWidget = widget && widget.hasAttribute('data-active');
  const placedPins = isActiveWidget
    ? monitorPins.map(m => { const ll = m.getLatLng(); return [ll.lat, ll.lng]; })
    : [];

  const pins = csvPins.concat(placedPins);
  if (pins.length < 2) return;

  const avgDist   = avgNearestNeighborDistKm(pins);
  const unionArea = unionCircleAreaKm2(pins, 2);
  const shapeArea = target.areaSqKm;
  const ratio     = shapeArea ? (unionArea / shapeArea) * 100 : null;

  logNetworkAnalysis(pins.length, avgDist, unionArea, shapeArea, ratio, uid);
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

    const areaSqKm = ring ? geoJsonAreaKm2(geojson) : bboxAreaKm2(sw.lat, sw.lng, ne.lat, ne.lng);
    // NEW: Calculate weighted area
    const weightedArea = computeWeightedAreaFromGeoJSON(geojson);
    const target0 = { type: 'geojson', layer, ring, geojson, areaSqKm, weightedArea};

    const featureCount = geojson.features ? geojson.features.length : 1;
    const entry = document.createElement('div');
    entry.className = 'log-entry info';
    entry.innerHTML = `
      <div class="log-type">📁 FILE · ${name}</div>
      <div class="log-coords">${featureCount} feature${featureCount!==1?'s':''}\nSW: [${sw.lat.toFixed(4)}, ${sw.lng.toFixed(4)}]\nNE: [${ne.lat.toFixed(4)}, ${ne.lng.toFixed(4)}]</div>`;
    const out = document.getElementById('console-output');
    out.appendChild(entry); out.scrollTop = out.scrollHeight;

    const population = computePopulationFromGeoJSON(geojson);
    currentPopulation = population;

    if (population !== null) {
    logPopulation(population, logCount, name, layer, target0);
    
    // --- NEW: Automatically trigger analysis ---
    // We get the latest UID (most recently added entry)
    const out = document.getElementById('console-output');
    const lastEntry = out.lastElementChild;
    const uid = lastEntry.dataset.uid;
    if (uid) {
        calculateNetwork(uid);
    }
    // -------------------------------------------
    
  } else logError('TIF not loaded yet.', logCount);
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
  // NEW: Calculate weighted area
  const weightedArea = computeWeightedAreaFromBbox(sw.lat, sw.lng, ne.lat, ne.lng);

  const target = { type:'bbox', layer: savedRect, areaSqKm, weightedArea};

  const population = computePopulation(sw.lat, sw.lng, ne.lat, ne.lng);
  currentPopulation = population;
  if (population !== null) {
    logPopulation(population, logCount, null, savedRect, target);
    
    // --- NEW: Automatically trigger analysis ---
    // We get the latest UID (most recently added entry)
    const out = document.getElementById('console-output');
    const lastEntry = out.lastElementChild;
    const uid = lastEntry.dataset.uid;
    if (uid) {
        calculateNetwork(uid);
    }
    // -------------------------------------------
    
  } else logError('TIF not loaded yet.', logCount);
  
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
  // NEW: Calculate weighted area
  const weightedArea = computeWeightedAreaFromRing(ring);
  const target = { type:'polygon', layer: poly, ring, areaSqKm,weightedArea };

  const polyGeojson = { type:'Polygon', coordinates:[ring] };
  const population = computePopulationFromGeoJSON(polyGeojson);
  currentPopulation = population;

  if (population !== null) {
    logPopulation(population, logCount, 'Drawn Polygon', poly, target);
    
    // --- NEW: Automatically trigger analysis ---
    // We get the latest UID (most recently added entry)
    const out = document.getElementById('console-output');
    const lastEntry = out.lastElementChild;
    const uid = lastEntry.dataset.uid;
    if (uid) {
        calculateNetwork(uid);
    }
    // -------------------------------------------
    
  } else logError('TIF not loaded yet.', logCount);

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
  entry.innerHTML = `<div class="log-type">✕ ALL CLEARED</div><div class="log-coords">Canvas reset. Ready for new shapes.</div>`;
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
  entry.innerHTML = `<div class="log-type">${label}</div><div class="log-coords">${display}</div>`;
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
    <div class="log-type pop-label">👥 POPULATION · ${label || ('BBOX #'+index)}</div>
    <span class="sub-label"><a href="https://landscan.ornl.gov/">LANDSCAN GLOBAL 2024</a></span>
    <div class="log-coords">
      <span class="pop-big">${millions} Millions \n${areaStr}</span>
      <span class="monitors-label">Min. monitors required</span><span class="sub-label">CPCB guidelines</span>

      <div class="monitors-grid">${monitorsHTML}</div>
    </div>
    <div class="mp-widget" id="${uid}">
      <div class="mp-title">📍 How many new stations do you want to place?</div>
      <div class="mp-row">
        <label class="mp-lbl">Select number of stations: </label>
        <input class="mp-input" type="number" min="1" max="200" value="5" id="${uid}-count"/>
      </div>
      
      <div class="mp-row">
        <button class="mp-btn" onclick="startPlacingFromWidget('${uid}')" style="flex: 1;">▶ Start Placing</button>
        <button class="mp-btn mp-btn-clear" onclick="clearMonitorPinsFromWidget('${uid}')">✕ Clear Pins</button>
      </div>

      <div class="mp-separator">
        <span class="mp-separator-text">or</span>
      </div>

      <div class="mp-row">
        <label class="mp-btn mp-btn-upload" style="display: block; cursor: pointer; text-align: center; width: 100%; margin: 0;">
          ⬆ Upload station locations (GeoJSON)
          <input type="file" id="${uid}-upload-pins" accept=".geojson,.json" style="display:none" onchange="uploadPinsFromWidget('${uid}', event)"/>
        </label>
      </div>
      <div class="mp-placed">0 new placed</div>
      <button class="mp-calc-btn" onclick="calculateNetwork('${uid}')">⬛ Calculate Network Coverage</button>
      <div class="net-result" id="${uid}-result"></div>
    </div>`;

  // Store target reference on the DOM element for retrieval
  entry.dataset.uid = uid;
  entry._target = target;

  out.appendChild(entry); out.scrollTop = out.scrollHeight;  
}

// ── NEW FUNCTION: HANDLE GEOJSON PIN UPLOADS ───────────────────
function uploadPinsFromWidget(uid, event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = ''; // Reset input selection

  const reader = new FileReader();
  reader.onload = function(e) {
    let geojson = null;
    try {
      geojson = JSON.parse(e.target.result);
    } catch (err) {
      logError(`Could not parse Pins GeoJSON: ${err.message}`, logCount);
      return;
    }

    // Stop manual placing mode first and clear existing pins
    stopMonitorPlacement(); // This sets monitorTarget to null
    clearMonitorPins();

    // Track active widget
    document.querySelectorAll('.mp-widget').forEach(w => w.removeAttribute('data-active'));
    const widget = document.getElementById(uid);
    if (widget) widget.setAttribute('data-active', '1');

    // Retrieve target shape
    const entry = widget ? widget.closest('.log-entry') : null;
    const target = entry ? entry._target : null;
    if (!target) return;

    // FIX: Re-assign the global monitorTarget so calculateNetwork() has the reference shape!
    monitorTarget = target;

    // Parse out point coordinates [lat, lng]
    let points = [];
    function extractPoints(geom) {
      if (!geom) return;
      if (geom.type === 'Point') {
        points.push([geom.coordinates[1], geom.coordinates[0]]); // GeoJSON is [lng, lat], Leaflet wants [lat, lng]
      } else if (geom.type === 'GeometryCollection') {
        geom.geometries.forEach(extractPoints);
      }
    }

    if (geojson.type === 'FeatureCollection') {
      geojson.features.forEach(f => extractPoints(f.geometry));
    } else if (geojson.type === 'Feature') {
      extractPoints(geojson.geometry);
    } else {
      extractPoints(geojson);
    }

    if (points.length === 0) {
      logError("No Point features found in the uploaded pins file.", logCount);
      return;
    }

    // Filter points to only those inside target boundary
    const validPoints = points.filter(p => isPointInTarget(p[0], p[1], target));
    const outOfBoundsCount = points.length - validPoints.length;

    if (validPoints.length === 0) {
      logError("All uploaded coordinates fell outside the selected boundary shape.", logCount);
      return;
    }

    // Map each point as a Leaflet Marker & coverage Circle
    validPoints.forEach((p, idx) => {
      const latlng = { lat: p[0], lng: p[1] };
      const pinNum = idx + 1;

      const icon = L.divIcon({
        className: '',
        html: `<div class="monitor-pin">${pinNum}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13]
      });

      const marker = L.marker(latlng, { icon, draggable: true }).addTo(map);

      const circle = L.circle(latlng, {
        radius: 2000,
        color: '#164D12', weight: 1.2,
        fillColor: '#164D12', fillOpacity: 0.08,
        dashArray: '4 3'
      }).addTo(map);

      // Handle dragging properties
      marker.on('drag', function(ev) {
        circle.setLatLng(ev.latlng);
      });
      marker.on('dragend', function(ev) {
        const ll = ev.target.getLatLng();
        if (!isPointInTarget(ll.lat, ll.lng, target)) {
          marker.setLatLng(latlng); // snap back if moved out of shape boundaries
          circle.setLatLng(latlng);
        }
        updateMonitorPlacementUI();
      });

      monitorPins.push(marker);
      monitorCircles.push(circle);
    });

    // Sync input count and UI
    targetMonitorCount = monitorPins.length;
    const countInput = document.getElementById(`${uid}-count`);
    if (countInput) countInput.value = targetMonitorCount;

    updateMonitorPlacementUI();

    if (outOfBoundsCount > 0) {
      logError(`Imported ${validPoints.length} pins inside shape boundary. (${outOfBoundsCount} pins were ignored for falling outside)`, logCount);
    }
  };
  reader.readAsText(file);
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
    const entry    = widget.closest('.log-entry');
    const target   = entry ? entry._target : null;
  }
  stopMonitorPlacement();
}

// Override updateMonitorPlacementUI to target the active widget
function updateMonitorPlacementUI() {
  const widget = document.querySelector('.mp-widget[data-active]');
  if (!widget) return;
  const placed   = monitorPins.length;
  const total    = targetMonitorCount;
  const combined = placed;
  widget.querySelector('.mp-placed').textContent = `${placed} new placed`;
  widget.querySelector('.mp-calc-btn').disabled = combined < 2;
  const ind = document.getElementById('mode-indicator');
  if (placingMonitors) {
    ind.innerHTML = `📍 Place Monitor Mode<div class="hint">${placed}/${total} placed · click inside shape</div>`;
  }

  return combined
}

// ── NETWORK ANALYSIS LOG ──────────────────────────────────────
// Writes result into the widget's own .net-result placeholder (replaces on recalculate)
const num_monitors = updateMonitorPlacementUI();
function logNetworkAnalysis(num_monitors, avgDist, unionArea, shapeArea, ratio, uid) {
  const requiredMonitors = numMonitorsCpcb('spm', currentPopulation);
  // or whichever pollutant you're using as the reference
  const percentRequired = ((num_monitors / requiredMonitors) * 100).toFixed(0);
  // 1. Calculate Individual Scores (0, 2, 5, 8, 10)
  
  // Metric 1: Coverage Ratio (Targeting 90+% as 10)
  const scoreRatio = ratio >= 90 ? 10 : ratio >= 80 ? 9 : ratio >= 70 ? 8 : ratio >= 60 ? 7 : ratio >= 50 ? 6 : ratio >= 40 ? 5 : ratio >= 30 ? 4 : ratio >= 20 ? 3 : ratio >= 10 ? 2 :  1;
  
  // Metric 2: Avg Distance (Assuming <2 is ideal; lower is often better for density)
  const scoreDist = avgDist < 2 ? 10 : avgDist < 3 ? 8 : avgDist < 5 ? 5 : 1;
  
  // Metric 3: Percent required monitors
  const scorePct = percentRequired > 80 ? 10 : percentRequired > 60 ? 7 : percentRequired > 40 ? 5 : percentRequired > 20 ? 2 : percentRequired > 10 ? 1 :0;

  const totalScore = scoreRatio + scoreDist + scorePct;
  
  // Determine color coding
  const getScoreColor = (s) => s > 20 ? '#164D12' : s > 10 ? '#b84c00' : '#d11';
  const totalColor = getScoreColor(totalScore);
  const status = totalScore > 20 ? 'Good' : totalScore > 10 ? 'Okay' : 'Bad';

  const html = `
    <div class="net-result-inner">
      <div class="net-result-header" style="border-bottom: 2px solid ${totalColor}; padding-bottom: 5px; margin-bottom: 10px;">
        <span style="font-weight: bold; font-size: 1.1em;">📡 Network Score: ${totalScore}/30 (${status})</span>
      </div>
      <div class="net-grid">
        <div class="net-card">
          <span class="net-metric-label">Avg. Distance</span>
          <span class="net-metric-val">${avgDist.toFixed(1)}km</span>
          <span class="net-metric-unit">Score: ${scoreDist}/10</span>
        </div>
        <div class="net-card">
          <span class="net-metric-label">Representativeness</span>
          <span class="net-metric-val">${ratio.toFixed(0)}%</span>
          <span class="net-metric-unit">Score: ${scoreRatio}/10</span>
        </div>
        <div class="net-card">
          <span class="net-metric-label">% required monitors</span>
          <span class="net-metric-val">${percentRequired}%</span>
          <span class="net-metric-unit"> Score: ${scorePct}/10</span>
        </div>
      </div>
    </div>`;

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
  entry.innerHTML = `<div class="log-type pop-label">⚠ NOTE · #${index}</div><div class="log-coords">${msg}</div>`;
  out.appendChild(entry); out.scrollTop = out.scrollHeight;
}

// ── POPULATION HEATMAP LAYER & LEGEND ─────────────────────────
let heatmapLayer = null;
let heatmapLegend = null;

function togglePopulationHeatmap() {
  const btn = document.getElementById('btn-heatmap');

  // 1. If active: remove layer and legend (Toggle OFF)
  if (heatmapLayer) {
    map.removeLayer(heatmapLayer);
    heatmapLayer = null;

    if (heatmapLegend) {
      map.removeControl(heatmapLegend);
      heatmapLegend = null;
    }

    if (btn) btn.classList.remove('active');
    return;
  }

  // 2. Ensure TIF is loaded
  if (!tifData) {
    alert("LandScan TIF is still loading or failed to load.");
    return;
  }

  // 3. Create Heatmap GridLayer
  heatmapLayer = L.gridLayer({ opacity: 0.6, zIndex: 5 });

  heatmapLayer.createTile = function(coords, done) {
    const tile = L.DomUtil.create('canvas', 'leaflet-tile');
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;
    const ctx = tile.getContext('2d');

    const nwPoint = coords.scaleBy(size);
    const { originX, originY, pixelW, pixelH, width, height } = tifMeta;

    const imgData = ctx.createImageData(size.x, size.y);
    const data = imgData.data;

    for (let y = 0; y < size.y; y++) {
      for (let x = 0; x < size.x; x++) {
        const pt = nwPoint.add(L.point(x, y));
        const latlng = map.unproject(pt, coords.z);

        const col = Math.floor((latlng.lng - originX) / pixelW);
        const row = Math.floor((originY - latlng.lat) / pixelH);

        const idx = (y * size.x + x) * 4;

        if (col >= 0 && col < width && row >= 0 && row < height) {
          const val = tifData[row * width + col];

          if (val > 0 && val !== tifNodata) {
            let r, g, b, a;
            if (val < 10)      { r=255; g=255; b=178; a=100; } // < 10
            else if (val < 50) { r=254; g=204; b=92;  a=160; } // 10 - 50
            else if (val < 200){ r=253; g=141; b=60;  a=200; } // 50 - 200
            else if (val < 500){ r=240; g=59;  b=32;  a=230; } // 200 - 500
            else               { r=189; g=0;   b=38;  a=255; } // > 500

            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = a;
          } else {
            data[idx + 3] = 0;
          }
        } else {
          data[idx + 3] = 0;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
    setTimeout(function() { done(null, tile); }, 0);
    return tile;
  };

  heatmapLayer.addTo(map);

  // 4. Create & Add Map Legend Control
  heatmapLegend = L.control({ position: 'bottomright' });

  heatmapLegend.onAdd = function() {
    const div = L.DomUtil.create('div', 'heatmap-legend');
    
    // Header
    div.innerHTML = `<div class="legend-title">Population Density</div>
                     <div class="legend-subtitle">(per ~1 km² cell)</div>`;

    const grades = [0, 10, 50, 200, 500];
    const colors = [
      'rgba(255, 255, 178, 0.7)',
      'rgba(254, 204, 92, 0.8)',
      'rgba(253, 141, 60, 0.85)',
      'rgba(240, 59, 32, 0.9)',
      'rgba(189, 0, 38, 1.0)'
    ];
    const labels = ['< 10', '10 – 50', '50 – 200', '200 – 500', '500+'];

    // Rows
    grades.forEach((grade, i) => {
      div.innerHTML += `
        <div class="legend-row">
          <i style="background:${colors[i]}"></i>
          <span>${labels[i]}</span>
        </div>`;
    });

    return div;
  };

  heatmapLegend.addTo(map);

  if (btn) btn.classList.add('active');
}

// Attach listener if not attached already
const heatmapBtn = document.getElementById('btn-heatmap');
if (heatmapBtn) {
  heatmapBtn.addEventListener('click', togglePopulationHeatmap);
}