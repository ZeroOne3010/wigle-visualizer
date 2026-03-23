const state = {
  observations: [],
  route: [],
  metadata: null,
  activeTime: null,
  cursor: 0,
  isPlaying: false,
  speed: 1,
  rafId: null,
  lastFrameTime: null,
  checkpoints: [],
  filters: {
    route: true,
    raw: false,
    estimated: true,
    wifi: true,
    bluetooth: true,
    cellular: true,
    confidenceThreshold: 0,
    minObs: 1,
  },
  deviceState: new Map(),
};

const els = {
  fileInput: document.getElementById('fileInput'),
  dropZone: document.getElementById('dropZone'),
  status: document.getElementById('status'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  stepBackBtn: document.getElementById('stepBackBtn'),
  stepFwdBtn: document.getElementById('stepFwdBtn'),
  speedSelect: document.getElementById('speedSelect'),
  timeline: document.getElementById('timeline'),
  timeStart: document.getElementById('timeStart'),
  timeCurrent: document.getElementById('timeCurrent'),
  timeEnd: document.getElementById('timeEnd'),
  filterRoute: document.getElementById('filterRoute'),
  filterRaw: document.getElementById('filterRaw'),
  filterEstimated: document.getElementById('filterEstimated'),
  filterWifi: document.getElementById('filterWifi'),
  filterBluetooth: document.getElementById('filterBluetooth'),
  filterCell: document.getElementById('filterCell'),
  confidenceThreshold: document.getElementById('confidenceThreshold'),
  obsThreshold: document.getElementById('obsThreshold'),
};

const map = L.map('map', { preferCanvas: true }).setView([37.7749, -122.4194], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const routeFullLayer = L.polyline([], { color: '#64748b', weight: 2, opacity: 0.35 }).addTo(map);
const routeTraversedLayer = L.polyline([], { color: '#22d3ee', weight: 4, opacity: 0.9 }).addTo(map);
const playbackMarker = L.circleMarker([0, 0], {
  radius: 6,
  color: '#f8fafc',
  fillColor: '#0ea5e9',
  fillOpacity: 0.95,
  weight: 2,
}).addTo(map);

const rawLayer = L.layerGroup().addTo(map);
const estimatedLayer = L.layerGroup().addTo(map);

const worker = new Worker('parser-worker.js');
worker.addEventListener('message', onWorkerMessage);

wireEvents();

function wireEvents() {
  els.fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
  });

  ['dragenter', 'dragover'].forEach((name) => {
    els.dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      els.dropZone.classList.add('drag');
    });
  });

  ['dragleave', 'drop'].forEach((name) => {
    els.dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      els.dropZone.classList.remove('drag');
    });
  });

  els.dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) parseFile(file);
  });

  els.playPauseBtn.addEventListener('click', togglePlay);
  els.stepBackBtn.addEventListener('click', () => stepBy(-1));
  els.stepFwdBtn.addEventListener('click', () => stepBy(1));
  els.speedSelect.addEventListener('change', () => {
    state.speed = Number(els.speedSelect.value) || 1;
  });

  els.timeline.addEventListener('input', () => {
    const targetTime = Number(els.timeline.value);
    seekToTime(targetTime);
  });

  els.filterRoute.addEventListener('change', () => {
    state.filters.route = els.filterRoute.checked;
    redrawRoute();
  });
  els.filterRaw.addEventListener('change', () => {
    state.filters.raw = els.filterRaw.checked;
    renderRawPoints();
  });
  els.filterEstimated.addEventListener('change', () => {
    state.filters.estimated = els.filterEstimated.checked;
    renderEstimatedDevices();
  });
  els.filterWifi.addEventListener('change', () => {
    state.filters.wifi = els.filterWifi.checked;
    refreshAllLayers();
  });
  els.filterBluetooth.addEventListener('change', () => {
    state.filters.bluetooth = els.filterBluetooth.checked;
    refreshAllLayers();
  });
  els.filterCell.addEventListener('change', () => {
    state.filters.cellular = els.filterCell.checked;
    refreshAllLayers();
  });
  els.confidenceThreshold.addEventListener('input', () => {
    state.filters.confidenceThreshold = Number(els.confidenceThreshold.value);
    renderEstimatedDevices();
  });
  els.obsThreshold.addEventListener('input', () => {
    state.filters.minObs = Math.max(1, Number(els.obsThreshold.value) || 1);
    renderEstimatedDevices();
  });
}

async function parseFile(file) {
  setStatus(`Loading ${file.name}...`);
  setControlsEnabled(false);
  stopPlayback();
  resetMap();

  try {
    const text = await file.text();
    worker.postMessage({ type: 'parseCsv', text });
    setStatus(`Parsing ${file.name} in background worker...`);
  } catch (error) {
    setStatus(`Failed to read file: ${error}`);
  }
}

function onWorkerMessage(event) {
  const { type, payload, error } = event.data || {};
  if (type === 'parseError') {
    setStatus(`Parse failed: ${error}`);
    return;
  }

  if (type !== 'parseResult') return;

  state.observations = payload.observations || [];
  state.route = payload.route || [];
  state.metadata = payload.metadata || null;

  if (!state.observations.length) {
    setStatus('File parsed, but no usable rows with MAC, timestamp, and coordinates were found.');
    return;
  }

  buildCheckpoints();
  seekToTime(state.metadata.startTime);

  els.timeline.min = String(state.metadata.startTime);
  els.timeline.max = String(state.metadata.endTime);
  els.timeline.step = '1';
  els.timeline.value = String(state.metadata.startTime);

  els.timeStart.textContent = fmtTime(state.metadata.startTime);
  els.timeEnd.textContent = fmtTime(state.metadata.endTime);

  const typeSet = new Set(state.metadata.types || []);
  els.filterCell.disabled = !typeSet.has('cellular');

  routeFullLayer.setLatLngs(state.route.map((p) => [p.latitude, p.longitude]));
  const bounds = L.latLngBounds(state.route.map((p) => [p.latitude, p.longitude]));
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.05));

  setControlsEnabled(true);
  setStatus(
    [
      `Loaded rows: ${state.metadata.rowsLoaded}`,
      `Skipped rows: ${state.metadata.rowsSkipped}`,
      `Unique devices: ${state.metadata.uniqueDevices}`,
      `Types: ${(state.metadata.types || []).join(', ') || 'none'}`,
      `Time range: ${fmtTime(state.metadata.startTime)} → ${fmtTime(state.metadata.endTime)}`,
    ].join('\n')
  );
}

function buildCheckpoints() {
  const interval = 2000;
  state.checkpoints = [];

  let deviceState = new Map();
  for (let i = 0; i < state.observations.length; i += 1) {
    applyObservation(state.observations[i], deviceState);
    if (i % interval === 0) {
      state.checkpoints.push({
        obsIndex: i,
        time: state.observations[i].timestamp,
        snapshot: cloneDeviceState(deviceState),
      });
    }
  }
}

function cloneDeviceState(deviceMap) {
  const copy = new Map();
  for (const [mac, d] of deviceMap.entries()) {
    copy.set(mac, {
      ...d,
      obsCount: d.obsCount,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
    });
  }
  return copy;
}

function seekToTime(targetTime) {
  if (!state.observations.length) return;

  const clamped = Math.min(Math.max(targetTime, state.metadata.startTime), state.metadata.endTime);
  const currentTime = state.activeTime ?? state.metadata.startTime;

  if (clamped >= currentTime) {
    advanceForward(clamped);
  } else {
    rewindTo(clamped);
  }

  state.activeTime = clamped;
  els.timeline.value = String(clamped);
  els.timeCurrent.textContent = fmtTime(clamped);

  redrawRoute();
  renderRawPoints();
  renderEstimatedDevices();
}

function advanceForward(targetTime) {
  while (state.cursor < state.observations.length && state.observations[state.cursor].timestamp <= targetTime) {
    applyObservation(state.observations[state.cursor], state.deviceState);
    state.cursor += 1;
  }
}

function rewindTo(targetTime) {
  const checkpoint = pickCheckpoint(targetTime);
  if (checkpoint) {
    state.deviceState = cloneDeviceState(checkpoint.snapshot);
    state.cursor = checkpoint.obsIndex + 1;
  } else {
    state.deviceState = new Map();
    state.cursor = 0;
  }

  while (state.cursor < state.observations.length && state.observations[state.cursor].timestamp <= targetTime) {
    applyObservation(state.observations[state.cursor], state.deviceState);
    state.cursor += 1;
  }
}

function pickCheckpoint(targetTime) {
  for (let i = state.checkpoints.length - 1; i >= 0; i -= 1) {
    if (state.checkpoints[i].time <= targetTime) return state.checkpoints[i];
  }
  return null;
}

function applyObservation(obs, deviceMap) {
  const existing = deviceMap.get(obs.mac) || createNewDevice(obs);

  const weight = calcWeight(obs);
  const nextTotal = existing.totalWeight + weight;

  existing.estLat = (existing.estLat * existing.totalWeight + obs.latitude * weight) / nextTotal;
  existing.estLon = (existing.estLon * existing.totalWeight + obs.longitude * weight) / nextTotal;

  existing.totalWeight = nextTotal;
  existing.obsCount += 1;
  existing.lastSeen = obs.timestamp;
  existing.latestRssi = obs.rssi;
  existing.latestAccuracy = obs.accuracy;
  if (!existing.ssid && obs.ssid) existing.ssid = obs.ssid;

  const spread = distanceMeters(existing.estLat, existing.estLon, obs.latitude, obs.longitude);
  existing.varianceAccumulator += spread;
  existing.confidenceLevel = computeConfidence(existing);

  deviceMap.set(obs.mac, existing);
}

function createNewDevice(obs) {
  return {
    mac: obs.mac,
    type: obs.type,
    ssid: obs.ssid || '',
    firstSeen: obs.timestamp,
    lastSeen: obs.timestamp,
    estLat: obs.latitude,
    estLon: obs.longitude,
    totalWeight: 0,
    obsCount: 0,
    varianceAccumulator: 0,
    latestRssi: obs.rssi,
    latestAccuracy: obs.accuracy,
    confidenceLevel: 0,
  };
}

function calcWeight(obs) {
  const rssi = Number.isFinite(obs.rssi) ? Math.max(-100, Math.min(-20, obs.rssi)) : -90;
  const rssiNorm = (rssi + 100) / 80;
  const accuracyNorm = 1 / Math.max(3, obs.accuracy || 50);
  return Math.max(0.001, rssiNorm * 0.8 + accuracyNorm * 200 * 0.2);
}

function computeConfidence(device) {
  const countScore = Math.min(1, device.obsCount / 8);
  const spreadAvg = device.obsCount ? device.varianceAccumulator / device.obsCount : 999;
  const spreadScore = spreadAvg < 20 ? 1 : spreadAvg < 60 ? 0.6 : 0.3;
  const gpsScore = device.latestAccuracy < 15 ? 1 : device.latestAccuracy < 40 ? 0.65 : 0.35;
  const total = countScore * 0.45 + spreadScore * 0.35 + gpsScore * 0.2;
  return total > 0.75 ? 2 : total > 0.45 ? 1 : 0;
}

function redrawRoute() {
  if (!state.filters.route) {
    routeFullLayer.setStyle({ opacity: 0 });
    routeTraversedLayer.setStyle({ opacity: 0 });
    playbackMarker.setStyle({ opacity: 0, fillOpacity: 0 });
    return;
  }

  routeFullLayer.setStyle({ opacity: 0.35 });
  routeTraversedLayer.setStyle({ opacity: 0.9 });
  playbackMarker.setStyle({ opacity: 1, fillOpacity: 0.95 });

  const traversed = [];
  for (let i = 0; i < state.cursor; i += 1) {
    const o = state.observations[i];
    traversed.push([o.latitude, o.longitude]);
  }

  routeTraversedLayer.setLatLngs(traversed);
  if (traversed.length) {
    playbackMarker.setLatLng(traversed[traversed.length - 1]);
  }
}

function renderRawPoints() {
  rawLayer.clearLayers();
  if (!state.filters.raw) return;

  const startIndex = Math.max(0, state.cursor - 3500);
  for (let i = startIndex; i < state.cursor; i += 1) {
    const o = state.observations[i];
    if (!passesTypeFilter(o.type)) continue;
    L.circleMarker([o.latitude, o.longitude], {
      radius: 2,
      color: '#94a3b8',
      opacity: 0.5,
      fillOpacity: 0.25,
      weight: 1,
    }).addTo(rawLayer);
  }
}

function renderEstimatedDevices() {
  estimatedLayer.clearLayers();
  if (!state.filters.estimated) return;

  for (const device of state.deviceState.values()) {
    if (!passesTypeFilter(device.type)) continue;
    if (device.obsCount < state.filters.minObs) continue;
    if (device.confidenceLevel < state.filters.confidenceThreshold) continue;

    const style = styleForConfidence(device.confidenceLevel);
    const marker = createEstimatedMarker(device, style);
    marker.bindTooltip(renderDeviceTooltip(device), {
      direction: 'top',
      sticky: true,
      opacity: 0.95,
    });
    marker.addTo(estimatedLayer);
  }
}

function createEstimatedMarker(device, style) {
  const center = [device.estLat, device.estLon];
  const radius = 6 + Math.min(12, Math.log2(device.obsCount + 1) * 2);

  if (device.type === 'bluetooth') {
    return L.polygon(diamondPoints(center[0], center[1], radius), {
      color: style.stroke,
      fillColor: style.fill,
      fillOpacity: style.fillOpacity,
      weight: 2,
    });
  }
  if (device.type === 'cellular') {
    return L.polygon(squarePoints(center[0], center[1], radius), {
      color: style.stroke,
      fillColor: style.fill,
      fillOpacity: style.fillOpacity,
      weight: 2,
    });
  }
  return L.circleMarker(center, {
    radius,
    color: style.stroke,
    fillColor: style.fill,
    fillOpacity: style.fillOpacity,
    weight: 2,
  });
}

function renderDeviceTooltip(device) {
  return `
    <dl class="popup-grid">
      <dt>Type</dt><dd>${escapeHtml(device.type)}</dd>
      <dt>Name</dt><dd>${escapeHtml(device.ssid || device.mac || '(unknown)')}</dd>
      <dt>Confidence</dt><dd>${confidenceLabel(device.confidenceLevel)}</dd>
      <dt>Observations</dt><dd>${device.obsCount}</dd>
    </dl>
  `;
}

function styleForConfidence(level) {
  if (level === 2) return { stroke: '#10b981', fill: '#34d399', fillOpacity: 0.62 };
  if (level === 1) return { stroke: '#f59e0b', fill: '#fbbf24', fillOpacity: 0.5 };
  return { stroke: '#ef4444', fill: '#f87171', fillOpacity: 0.3 };
}

function passesTypeFilter(type) {
  if (type === 'wifi') return state.filters.wifi;
  if (type === 'bluetooth') return state.filters.bluetooth;
  if (type === 'cellular') return state.filters.cellular;
  return true;
}

function confidenceLabel(level) {
  return ['Low', 'Medium', 'High'][level] || 'Low';
}

function metersToLatDegrees(meters) {
  return meters / 111320;
}

function metersToLonDegrees(meters, latitude) {
  return meters / (111320 * Math.max(0.2, Math.cos((latitude * Math.PI) / 180)));
}

function squarePoints(lat, lon, radiusMeters) {
  const latDelta = metersToLatDegrees(radiusMeters);
  const lonDelta = metersToLonDegrees(radiusMeters, lat);
  return [
    [lat + latDelta, lon - lonDelta],
    [lat + latDelta, lon + lonDelta],
    [lat - latDelta, lon + lonDelta],
    [lat - latDelta, lon - lonDelta],
  ];
}

function diamondPoints(lat, lon, radiusMeters) {
  const latDelta = metersToLatDegrees(radiusMeters * 1.2);
  const lonDelta = metersToLonDegrees(radiusMeters * 1.2, lat);
  return [
    [lat + latDelta, lon],
    [lat, lon + lonDelta],
    [lat - latDelta, lon],
    [lat, lon - lonDelta],
  ];
}

function togglePlay() {
  if (!state.observations.length) return;
  state.isPlaying = !state.isPlaying;
  els.playPauseBtn.textContent = state.isPlaying ? 'Pause' : 'Play';

  if (state.isPlaying) {
    state.lastFrameTime = null;
    state.rafId = requestAnimationFrame(tick);
  } else {
    stopPlayback();
  }
}

function stopPlayback() {
  state.isPlaying = false;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
  state.lastFrameTime = null;
  els.playPauseBtn.textContent = 'Play';
}

function tick(frameTime) {
  if (!state.isPlaying) return;
  if (state.lastFrameTime == null) state.lastFrameTime = frameTime;

  const dt = frameTime - state.lastFrameTime;
  state.lastFrameTime = frameTime;

  const advanceMs = dt * state.speed;
  const nextTime = Math.min((state.activeTime ?? state.metadata.startTime) + advanceMs, state.metadata.endTime);
  seekToTime(nextTime);

  if (nextTime >= state.metadata.endTime) {
    stopPlayback();
    return;
  }

  state.rafId = requestAnimationFrame(tick);
}

function stepBy(direction) {
  if (!state.observations.length) return;

  const targetIndex = direction > 0 ? Math.min(state.cursor, state.observations.length - 1) : Math.max(0, state.cursor - 2);
  const targetTime = state.observations[targetIndex]?.timestamp;
  if (targetTime != null) seekToTime(targetTime);
}

function refreshAllLayers() {
  redrawRoute();
  renderRawPoints();
  renderEstimatedDevices();
}

function setControlsEnabled(enabled) {
  [
    els.playPauseBtn,
    els.stepBackBtn,
    els.stepFwdBtn,
    els.speedSelect,
    els.timeline,
  ].forEach((el) => {
    el.disabled = !enabled;
  });
}

function setStatus(msg) {
  els.status.textContent = msg;
}

function resetMap() {
  state.deviceState = new Map();
  state.cursor = 0;
  state.activeTime = null;
  routeFullLayer.setLatLngs([]);
  routeTraversedLayer.setLatLngs([]);
  rawLayer.clearLayers();
  estimatedLayer.clearLayers();
}

function fmtTime(ts) {
  if (!ts) return '--';
  return new Date(ts).toLocaleString();
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
