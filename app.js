const state = {
  observations: [],
  route: [],
  metadata: null,
  activeTime: null,
  cursor: 0,
  isPlaying: false,
  speed: 4,
  rafId: null,
  lastFrameTime: null,
  checkpoints: [],
  filters: {
    route: true,
    raw: false,
    estimated: true,
    mobilityMode: 'both',
    mobileRenderMode: 'trail',
    wifi: true,
    bluetooth: true,
    cellular: true,
    confidenceThreshold: 0,
    minObs: 1,
  },
  deviceState: new Map(),
  selectedDeviceMac: null,
  viewportSortKey: 'lastSeen',
  viewportSortDir: 'desc',
  ignoreNextViewportMoveEnd: false,
  parseRequestSeq: 0,
  parseRequests: new Map(),
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
  mobilityBoth: document.getElementById('mobilityBoth'),
  mobilityStationary: document.getElementById('mobilityStationary'),
  mobilityMobile: document.getElementById('mobilityMobile'),
  mobileAsSymbols: document.getElementById('mobileAsSymbols'),
  filterWifi: document.getElementById('filterWifi'),
  filterBluetooth: document.getElementById('filterBluetooth'),
  filterCell: document.getElementById('filterCell'),
  confidenceThreshold: document.getElementById('confidenceThreshold'),
  obsThreshold: document.getElementById('obsThreshold'),
  viewportSummary: document.getElementById('viewportSummary'),
  summaryVisibleTotal: document.getElementById('summaryVisibleTotal'),
  summaryVisibleStationary: document.getElementById('summaryVisibleStationary'),
  summaryVisibleMobile: document.getElementById('summaryVisibleMobile'),
  summaryVisibleWifi: document.getElementById('summaryVisibleWifi'),
  summaryVisibleBluetooth: document.getElementById('summaryVisibleBluetooth'),
  summaryVisibleCellular: document.getElementById('summaryVisibleCellular'),
  viewportTableBody: document.getElementById('viewportTableBody'),
  viewportTableHeaders: Array.from(document.querySelectorAll('#viewportTable thead [data-sort]')),
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
    renderViewportPanel();
  });
  els.filterRaw.addEventListener('change', () => {
    state.filters.raw = els.filterRaw.checked;
    renderRawPoints();
    renderViewportPanel();
  });
  els.filterEstimated.addEventListener('change', () => {
    state.filters.estimated = els.filterEstimated.checked;
    renderEstimatedDevices();
    renderViewportPanel();
  });
  [els.mobilityBoth, els.mobilityStationary, els.mobilityMobile].forEach((input) => {
    input.addEventListener('change', () => {
      updateMobilityModeFromInputs();
      renderEstimatedDevices();
      renderViewportPanel();
    });
  });
  els.mobileAsSymbols.addEventListener('change', () => {
    state.filters.mobileRenderMode = els.mobileAsSymbols.checked ? 'symbol' : 'trail';
    if (state.filters.mobileRenderMode !== 'trail') {
      state.selectedDeviceMac = null;
    }
    renderEstimatedDevices();
    renderViewportPanel();
  });
  els.filterWifi.addEventListener('change', () => {
    state.filters.wifi = els.filterWifi.checked;
    refreshAllLayers();
    renderViewportPanel();
  });
  els.filterBluetooth.addEventListener('change', () => {
    state.filters.bluetooth = els.filterBluetooth.checked;
    refreshAllLayers();
    renderViewportPanel();
  });
  els.filterCell.addEventListener('change', () => {
    state.filters.cellular = els.filterCell.checked;
    refreshAllLayers();
    renderViewportPanel();
  });
  els.confidenceThreshold.addEventListener('input', () => {
    state.filters.confidenceThreshold = Number(els.confidenceThreshold.value);
    renderEstimatedDevices();
    renderViewportPanel();
  });
  els.obsThreshold.addEventListener('input', () => {
    state.filters.minObs = Math.max(1, Number(els.obsThreshold.value) || 1);
    renderEstimatedDevices();
    renderViewportPanel();
  });

  for (const header of els.viewportTableHeaders) {
    header.addEventListener('click', () => {
      const sortKey = header.dataset.sort;
      if (!sortKey) return;
      if (state.viewportSortKey === sortKey) {
        state.viewportSortDir = state.viewportSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.viewportSortKey = sortKey;
        state.viewportSortDir = 'asc';
      }
      renderViewportPanel();
    });
  }

  const debouncedMapViewportUpdate = debounce(() => {
    if (state.ignoreNextViewportMoveEnd) {
      state.ignoreNextViewportMoveEnd = false;
      return;
    }
    renderEstimatedDevices();
    renderViewportPanel();
  }, 150);
  map.on('autopanstart', () => {
    state.ignoreNextViewportMoveEnd = true;
  });
  map.on('moveend', debouncedMapViewportUpdate);
  map.on('zoomend', debouncedMapViewportUpdate);
}

function debounce(fn, waitMs = 150) {
  let timeoutId = null;
  return (...args) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timeoutId = null;
      fn(...args);
    }, waitMs);
  };
}

async function parseFile(file) {
  const requestId = createParseRequest(file);
  setStatus(`Loading ${file.name}...`);
  setControlsEnabled(false);
  stopPlayback();
  resetMap();

  try {
    const text = await file.text();
    worker.postMessage({ type: 'parseCsv', text, requestId });
    setStatus(`Parsing ${file.name} in background worker...`);
  } catch (error) {
    state.parseRequests.delete(requestId);
    setStatus(`Failed to read file: ${error}`);
  }
}

function onWorkerMessage(event) {
  const { type, payload, error, requestId } = event.data || {};
  if (type === 'parseError') {
    state.parseRequests.delete(requestId);
    setStatus(`Parse failed: ${error}`);
    return;
  }

  if (type === 'parseNeedsDaySelection') {
    handleDaySelection(payload, requestId);
    return;
  }

  if (type !== 'parseResult') return;
  state.parseRequests.delete(requestId);

  state.observations = payload.observations || [];
  state.route = payload.route || [];
  state.metadata = payload.metadata || null;

  if (!state.observations.length) {
    setStatus('File parsed, but no usable rows with MAC, timestamp, and coordinates were found.');
    return;
  }

  buildCheckpoints();
  const playbackStart = state.metadata.playbackStartTime ?? state.metadata.startTime;
  const playbackEnd = state.metadata.playbackEndTime ?? state.metadata.endTime;
  seekToTime(playbackStart);

  els.timeline.min = String(playbackStart);
  els.timeline.max = String(playbackEnd);
  els.timeline.step = '1';
  els.timeline.value = String(playbackStart);

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
      `Filtered rows (unselected days): ${state.metadata.rowsFilteredByDay || 0}`,
      `Unique devices: ${state.metadata.uniqueDevices}`,
      `Types: ${(state.metadata.types || []).join(', ') || 'none'}`,
      `Loaded day(s): ${(state.metadata.selectedDays || []).join(', ') || 'none'}`,
      `Time range: ${fmtTime(state.metadata.startTime)} → ${fmtTime(state.metadata.endTime)}`,
      `Collapsed idle gaps: ${state.metadata.collapsedGapCount || 0} (${fmtDuration(state.metadata.collapsedGapMs || 0)})`,
    ].join('\n')
  );
}

async function handleDaySelection(payload, requestId) {
  const availableDays = payload?.availableDays || [];
  const latestDay = payload?.latestDay || availableDays.at(-1) || '';
  const file = state.parseRequests.get(requestId);
  if (!file) {
    return;
  }

  const promptText = [
    `This file contains multiple days (${availableDays.length}).`,
    'Enter one or more dates to load (comma-separated YYYY-MM-DD),',
    'or type "all" to load everything.',
    payload?.selectionInvalid ? 'Your previous selection did not match this file. Please choose from the list below.' : '',
    `Available days: ${availableDays.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');

  const response = window.prompt(promptText, latestDay);
  if (response === null) {
    state.parseRequests.delete(requestId);
    setStatus('Day selection canceled. Choose a file again to continue.');
    return;
  }

  const selectedDays = parseSelectedDays(response, availableDays, latestDay);
  if (!selectedDays.length) {
    setStatus(`No valid days selected. Defaulting to latest day: ${latestDay}.`);
    selectedDays.push(latestDay);
  }

  setStatus(`Re-parsing ${file.name} for day(s): ${selectedDays.join(', ')}`);
  const text = await file.text();
  worker.postMessage({ type: 'parseCsv', text, selectedDays, requestId });
}

function parseSelectedDays(input, availableDays, latestDay) {
  const normalized = String(input || '').trim().toLowerCase();
  if (!normalized) return latestDay ? [latestDay] : [];
  if (normalized === 'all') return [...availableDays];
  const requested = normalized.split(',').map((part) => part.trim()).filter(Boolean);
  const requestedSet = new Set(requested);
  return availableDays.filter((day) => requestedSet.has(day.toLowerCase()));
}

function createParseRequest(file) {
  state.parseRequestSeq += 1;
  const requestId = `parse-${state.parseRequestSeq}`;
  state.parseRequests.set(requestId, file);
  return requestId;
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
        time: observationPlaybackTime(state.observations[i]),
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
      trackPoints: (d.trackPoints || []).map((point) => ({ ...point })),
      signalSamples: (d.signalSamples || []).map((sample) => ({ ...sample })),
    });
  }
  return copy;
}

function seekToTime(targetTime) {
  if (!state.observations.length) return;

  const playbackStart = state.metadata.playbackStartTime ?? state.metadata.startTime;
  const playbackEnd = state.metadata.playbackEndTime ?? state.metadata.endTime;
  const clamped = Math.min(Math.max(targetTime, playbackStart), playbackEnd);
  const currentTime = state.activeTime ?? playbackStart;

  if (clamped >= currentTime) {
    advanceForward(clamped);
  } else {
    rewindTo(clamped);
  }

  state.activeTime = clamped;
  els.timeline.value = String(clamped);
  els.timeCurrent.textContent = fmtTime(realTimestampForPlayback(clamped));

  redrawRoute();
  renderRawPoints();
  renderEstimatedDevices();
  renderViewportPanel();
}

function advanceForward(targetTime) {
  while (state.cursor < state.observations.length && observationPlaybackTime(state.observations[state.cursor]) <= targetTime) {
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

  while (state.cursor < state.observations.length && observationPlaybackTime(state.observations[state.cursor]) <= targetTime) {
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

  for (const point of existing.trackPoints) {
    const span = distanceMeters(point.lat, point.lon, obs.latitude, obs.longitude);
    existing.trackSpanMeters = Math.max(existing.trackSpanMeters, span);
  }
  existing.trackPoints.push({ lat: obs.latitude, lon: obs.longitude });
  existing.signalSamples.push({
    timestamp: obs.timestamp,
    rssi: Number.isFinite(obs.rssi) ? obs.rssi : null,
  });

  const spread = distanceMeters(existing.estLat, existing.estLon, obs.latitude, obs.longitude);
  existing.varianceAccumulator += spread;
  existing.confidenceLevel = computeConfidence(existing);
  existing.isMobile = isMobileDevice(existing);

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
    trackSpanMeters: 0,
    trackPoints: [{ lat: obs.latitude, lon: obs.longitude }],
    signalSamples: [],
    latestRssi: obs.rssi,
    latestAccuracy: obs.accuracy,
    confidenceLevel: 0,
    isMobile: false,
  };
}

function calcWeight(obs) {
  const rssi = Number.isFinite(obs.rssi) ? Math.max(-100, Math.min(-20, obs.rssi)) : -90;
  const rssiNorm = (rssi + 100) / 80;
  const accuracyNorm = 1 / Math.max(3, obs.accuracy || 50);
  return Math.max(0.001, rssiNorm * 0.8 + accuracyNorm * 200 * 0.2);
}

function computeConfidence(device) {
  const obsCount = Number(device.obsCount) || 0;
  if (obsCount < 2) return 0;

  const countScore = Math.min(1, obsCount / 8);
  const spreadAvg = obsCount ? device.varianceAccumulator / obsCount : 999;
  const spreadScore = spreadAvg < 20 ? 1 : spreadAvg < 60 ? 0.6 : 0.3;
  const gpsScore = device.latestAccuracy < 15 ? 1 : device.latestAccuracy < 40 ? 0.65 : 0.35;
  const total = countScore * 0.45 + spreadScore * 0.35 + gpsScore * 0.2;
  return total > 0.75 ? 2 : total > 0.45 ? 1 : 0;
}

function effectiveConfidenceLevel(device) {
  return (Number(device.obsCount) || 0) < 2 ? 0 : Number(device.confidenceLevel) || 0;
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
  if (!state.filters.raw && !state.selectedDeviceMac) return;

  if (state.selectedDeviceMac) {
    for (const obs of state.observations) {
      if (obs.mac !== state.selectedDeviceMac) continue;
      if (!passesTypeFilter(obs.type)) continue;
      const color = colorForSignalStrength(obs.rssi);
      L.circleMarker([obs.latitude, obs.longitude], {
        radius: 5,
        color,
        fillColor: color,
        opacity: 0.98,
        fillOpacity: 0.86,
        weight: 1.5,
      }).addTo(rawLayer);
    }
    return;
  }

  const startIndex = Math.max(0, state.cursor - 3500);
  for (let i = startIndex; i < state.cursor; i += 1) {
    const obs = state.observations[i];
    if (!passesTypeFilter(obs.type)) continue;
    L.circleMarker([obs.latitude, obs.longitude], {
      radius: 3.25,
      color: '#cbd5e1',
      fillColor: '#94a3b8',
      opacity: 0.75,
      fillOpacity: 0.45,
      weight: 1,
    }).addTo(rawLayer);
  }
}

function toggleSelectedDevice(mac) {
  state.selectedDeviceMac = state.selectedDeviceMac === mac ? null : mac;
  renderRawPoints();
  renderEstimatedDevices();
  renderViewportPanel();
}

function colorForSignalStrength(rssiValue) {
  const rssi = Number.isFinite(rssiValue) ? rssiValue : -100;
  const clamped = Math.max(-96, Math.min(-38, rssi));
  const normalized = (clamped + 96) / 58;
  const emphasized = Math.pow(normalized, 0.65);

  const stops = [
    { t: 0, rgb: [180, 24, 26] },
    { t: 0.2, rgb: [242, 94, 34] },
    { t: 0.4, rgb: [246, 181, 33] },
    { t: 0.6, rgb: [132, 204, 22] },
    { t: 0.8, rgb: [34, 211, 238] },
    { t: 1, rgb: [37, 99, 235] },
  ];

  let lower = stops[0];
  let upper = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (emphasized >= stops[i].t && emphasized <= stops[i + 1].t) {
      lower = stops[i];
      upper = stops[i + 1];
      break;
    }
  }

  const span = Math.max(0.0001, upper.t - lower.t);
  const t = (emphasized - lower.t) / span;
  const channel = (index) => Math.round(lower.rgb[index] + (upper.rgb[index] - lower.rgb[index]) * t);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function renderEstimatedDevices() {
  estimatedLayer.clearLayers();
  if (!state.filters.estimated) return;

  const visibleDevices = getVisibleEstimatedDevices();
  const selectedDeviceVisible = visibleDevices.some((device) => device.mac === state.selectedDeviceMac);
  if (state.selectedDeviceMac && !selectedDeviceVisible) {
    state.selectedDeviceMac = null;
    renderRawPoints();
  }

  const hasSelectedDevice = Boolean(state.selectedDeviceMac);
  for (const device of visibleDevices) {
    const isSelected = device.mac === state.selectedDeviceMac;
    if (device.isMobile) {
      if (state.filters.mobileRenderMode === 'symbol') {
        const marker = createMobileSymbolMarker(device, hasSelectedDevice, isSelected);
        marker.on('click', (event) => {
          toggleSelectedDevice(device.mac);
          L.popup({ className: 'device-tooltip' })
            .setLatLng(event.latlng)
            .setContent(renderDeviceTooltip(device))
            .openOn(map);
        });
        marker.bindPopup(renderDeviceTooltip(device), {
          className: 'device-tooltip',
        });
        marker.addTo(estimatedLayer);
        if (isSelected) {
          const trail = createMobileTrackLine(device, hasSelectedDevice);
          trail.on('click', () => {
            toggleSelectedDevice(device.mac);
          });
          trail.bindPopup(renderDeviceTooltip(device), {
            className: 'device-tooltip',
          });
          trail.addTo(estimatedLayer);
          trail.bringToFront();
        }
        continue;
      }

      const line = createMobileTrackLine(device, hasSelectedDevice);
      line.on('click', (event) => {
        toggleSelectedDevice(device.mac);
        L.popup({ className: 'device-tooltip' })
          .setLatLng(event.latlng)
          .setContent(renderDeviceTooltip(device))
          .openOn(map);
      });
      line.bindPopup(renderDeviceTooltip(device), {
        className: 'device-tooltip',
      });
      line.addTo(estimatedLayer);

      if (isSelected) {
        line.bringToFront();
      }
      continue;
    }

    const style = styleForConfidence(effectiveConfidenceLevel(device), hasSelectedDevice, isSelected);
    const marker = createEstimatedMarker(device, style);
    marker.on('click', (event) => {
      toggleSelectedDevice(device.mac);
      L.popup({ className: 'device-tooltip' })
        .setLatLng(event.latlng)
        .setContent(renderDeviceTooltip(device))
        .openOn(map);
    });
    marker.addTo(estimatedLayer);
  }
}

function getVisibleEstimatedDevices(
  deviceValues = state.deviceState.values(),
  bounds = map.getBounds()
) {
  if (!state.filters.estimated) return [];
  const visibleDevices = [];
  for (const device of deviceValues) {
    if (!passesEstimatedDeviceFilters(device)) continue;
    if (!isDeviceInViewport(device, bounds)) continue;
    visibleDevices.push(device);
  }
  return visibleDevices;
}

function isDeviceInViewport(device, bounds) {
  if (!bounds || !bounds.isValid()) return true;
  if (!device.isMobile) {
    return bounds.contains([device.estLat, device.estLon]);
  }

  // Mobile-device viewport rule: include a trail only when its latest known
  // track point is inside the current map viewport.
  const latestTrackPoint = device.trackPoints?.[device.trackPoints.length - 1];
  if (latestTrackPoint) {
    return bounds.contains([latestTrackPoint.lat, latestTrackPoint.lon]);
  }
  return bounds.contains([device.estLat, device.estLon]);
}

function renderViewportPanel() {
  const visibleDevices = getVisibleEstimatedDevices();
  const summary = {
    total: visibleDevices.length,
    stationary: 0,
    mobile: 0,
    wifi: 0,
    bluetooth: 0,
    cellular: 0,
  };

  for (const device of visibleDevices) {
    if (device.isMobile) summary.mobile += 1;
    else summary.stationary += 1;

    if (device.type === 'wifi') summary.wifi += 1;
    else if (device.type === 'bluetooth') summary.bluetooth += 1;
    else if (device.type === 'cellular') summary.cellular += 1;
  }

  if (els.summaryVisibleTotal) els.summaryVisibleTotal.textContent = String(summary.total);
  if (els.summaryVisibleStationary) els.summaryVisibleStationary.textContent = String(summary.stationary);
  if (els.summaryVisibleMobile) els.summaryVisibleMobile.textContent = String(summary.mobile);
  if (els.summaryVisibleWifi) els.summaryVisibleWifi.textContent = String(summary.wifi);
  if (els.summaryVisibleBluetooth) els.summaryVisibleBluetooth.textContent = String(summary.bluetooth);
  if (els.summaryVisibleCellular) els.summaryVisibleCellular.textContent = String(summary.cellular);

  updateViewportSortHeaderState();
  if (!els.viewportTableBody) return;

  const sortedDevices = [...visibleDevices].sort(compareViewportDevices);
  const tableColumns = [
    'Name',
    'MAC',
    'Type',
    'Observations',
    'Confidence',
    'Mobility',
    'Last Seen',
    'Track Span',
  ];
  const rows = sortedDevices
    .map((device) => {
      const name = device.ssid || device.mac || 'Unknown';
      const confidence = device.isMobile ? 'N/A (moving)' : confidenceLabel(effectiveConfidenceLevel(device));
      const mobility = device.isMobile ? 'Mobile' : 'Stationary';
      const trackSpan = `${Math.round(device.trackSpanMeters || 0)} m`;
      const values = [
        name,
        device.mac || 'Unknown',
        device.type || 'Unknown',
        String(device.obsCount || 0),
        confidence,
        mobility,
        fmtTime(device.lastSeen),
        trackSpan,
      ];
      return `
        <tr class="${device.mac === state.selectedDeviceMac ? 'is-selected' : ''}" data-device-mac="${escapeHtml(device.mac || '')}">
          ${values
            .map(
              (value, index) =>
                `<td data-label="${escapeHtml(tableColumns[index])}">${escapeHtml(value)}</td>`,
            )
            .join('')}
        </tr>
      `;
    })
    .join('');

  els.viewportTableBody.innerHTML =
    rows ||
    '<tr><td colspan="8">No visible devices match the current filters and viewport.</td></tr>';
  for (const row of els.viewportTableBody.querySelectorAll('tr[data-device-mac]')) {
    row.addEventListener('click', () => {
      const mac = row.getAttribute('data-device-mac');
      if (!mac) return;
      toggleSelectedDevice(mac);
    });
  }
}

function compareViewportDevices(a, b) {
  const dir = state.viewportSortDir === 'desc' ? -1 : 1;
  const key = state.viewportSortKey;
  const toName = (device) => device.ssid || device.mac || '';
  const toConfidenceRank = (device) => (device.isMobile ? -1 : effectiveConfidenceLevel(device));
  const toMobilityText = (device) => (device.isMobile ? 'Mobile' : 'Stationary');

  let left;
  let right;

  if (key === 'name') {
    left = toName(a).toLowerCase();
    right = toName(b).toLowerCase();
  } else if (key === 'mac') {
    left = String(a.mac || '').toLowerCase();
    right = String(b.mac || '').toLowerCase();
  } else if (key === 'type') {
    left = String(a.type || '').toLowerCase();
    right = String(b.type || '').toLowerCase();
  } else if (key === 'obsCount') {
    left = Number(a.obsCount) || 0;
    right = Number(b.obsCount) || 0;
  } else if (key === 'confidence') {
    left = toConfidenceRank(a);
    right = toConfidenceRank(b);
  } else if (key === 'mobility') {
    left = toMobilityText(a).toLowerCase();
    right = toMobilityText(b).toLowerCase();
  } else if (key === 'lastSeen') {
    left = Number(a.lastSeen) || 0;
    right = Number(b.lastSeen) || 0;
  } else if (key === 'trackSpanMeters') {
    left = Number(a.trackSpanMeters) || 0;
    right = Number(b.trackSpanMeters) || 0;
  } else {
    left = Number(a.lastSeen) || 0;
    right = Number(b.lastSeen) || 0;
  }

  if (left < right) return -1 * dir;
  if (left > right) return 1 * dir;
  return 0;
}

function updateViewportSortHeaderState() {
  for (const header of els.viewportTableHeaders) {
    const key = header.dataset.sort;
    if (!key) continue;
    const isActive = key === state.viewportSortKey;
    header.setAttribute('aria-sort', isActive ? (state.viewportSortDir === 'asc' ? 'ascending' : 'descending') : 'none');
  }
}

function passesEstimatedDeviceFilters(device) {
  if (!passesTypeFilter(device.type)) return false;
  if (device.obsCount < state.filters.minObs) return false;
  if (!device.isMobile && effectiveConfidenceLevel(device) < state.filters.confidenceThreshold) return false;
  if (state.filters.mobilityMode === 'mobile' && !device.isMobile) return false;
  if (state.filters.mobilityMode === 'stationary' && device.isMobile) return false;
  return true;
}

function updateMobilityModeFromInputs() {
  if (els.mobilityStationary.checked) {
    state.filters.mobilityMode = 'stationary';
  } else if (els.mobilityMobile.checked) {
    state.filters.mobilityMode = 'mobile';
  } else {
    state.filters.mobilityMode = 'both';
  }
}

function createMobileTrackLine(device, hasSelectedDevice) {
  const latLngs = buildTrackLatLngs(device.trackPoints || []);
  const isSelected = device.mac === state.selectedDeviceMac;
  const style = lineStyleForMobility(device.mac, isSelected, hasSelectedDevice);
  const hitTarget = L.polyline(latLngs, style.hitTarget);
  const outline = L.polyline(latLngs, style.outline);
  const core = L.polyline(latLngs, style.core);
  return L.featureGroup([hitTarget, outline, core]);
}

function buildTrackLatLngs(trackPoints) {
  if (!trackPoints.length) return [];
  const maxPoints = 220;
  if (trackPoints.length <= maxPoints) return trackPoints.map((p) => [p.lat, p.lon]);

  const stride = Math.ceil(trackPoints.length / maxPoints);
  const sampled = [];
  for (let i = 0; i < trackPoints.length; i += stride) {
    const p = trackPoints[i];
    sampled.push([p.lat, p.lon]);
  }
  const lastPoint = trackPoints[trackPoints.length - 1];
  sampled.push([lastPoint.lat, lastPoint.lon]);
  return sampled;
}

function createEstimatedMarker(device, style) {
  const center = [device.estLat, device.estLon];
  const radiusPx = 8 + Math.min(12, Math.log2(device.obsCount + 1) * 2.1);
  const diameterPx = Math.round(radiusPx * 2);
  const markerType = markerTypeClass(device.type);
  const icon = L.divIcon({
    className: 'hotspot-wrapper',
    iconSize: [diameterPx, diameterPx],
    iconAnchor: [diameterPx / 2, diameterPx / 2],
    html: `<span
      class="hotspot-marker ${markerType}"
      style="width:${diameterPx}px;height:${diameterPx}px;border-color:${style.stroke};background:${style.fill};opacity:${style.fillOpacity}"
    ></span>`,
  });
  return L.marker(center, { icon, keyboard: false });
}

function createMobileSymbolMarker(device, hasSelectedDevice, isSelected) {
  const center = mobileSymbolPosition(device);
  const baseShade = mobileShadeForDevice(device.mac);
  const opacity = hasSelectedDevice && !isSelected ? 0.2 : 0.78;
  const radiusPx = 9 + Math.min(10, Math.log2((device.obsCount || 0) + 1) * 1.8);
  const diameterPx = Math.round(radiusPx * 2);
  const markerType = markerTypeClass(device.type);
  const icon = L.divIcon({
    className: 'hotspot-wrapper',
    iconSize: [diameterPx, diameterPx],
    iconAnchor: [diameterPx / 2, diameterPx / 2],
    html: `<span
      class="hotspot-marker ${markerType}"
      style="width:${diameterPx}px;height:${diameterPx}px;border-color:${baseShade};background:${baseShade};opacity:${opacity}"
    ></span>`,
  });
  return L.marker(center, { icon, keyboard: false });
}

function mobileSymbolPosition(device) {
  const latLngs = buildTrackLatLngs(device.trackPoints || []);
  if (latLngs.length) return latLngs[Math.floor(latLngs.length / 2)];
  return [device.estLat, device.estLon];
}

function renderDeviceTooltip(device) {
  const typeLabel = device.type ? String(device.type) : 'Unknown';
  const displayName = device.ssid || device.mac || 'Unknown';
  const confidence = device.isMobile
    ? 'N/A (moving)'
    : Number.isFinite(device.confidenceLevel)
    ? confidenceLabel(effectiveConfidenceLevel(device))
    : 'Unknown';
  const observations = Number.isFinite(device.obsCount) ? String(device.obsCount) : '0';
  const mobility = device.isMobile ? 'Mobile' : 'Stationary';
  const trackSpan = `${Math.round(device.trackSpanMeters || 0)} m`;
  const signalSamples = Array.isArray(device.signalSamples) ? device.signalSamples : [];

  const signalRows = signalSamples.length
    ? signalSamples
        .slice(-40)
        .reverse()
        .map((sample, index) => {
          const sampleNo = signalSamples.length - index;
          const rssiText = Number.isFinite(sample.rssi) ? `${Math.round(sample.rssi)} dBm` : 'Unknown';
          return `<li><span>#${sampleNo}</span><strong>${escapeHtml(rssiText)}</strong></li>`;
        })
        .join('')
    : '<li><span>No signal samples available.</span></li>';

  return `
    <dl class="popup-grid">
      <dt>Type</dt><dd>${escapeHtml(typeLabel)}</dd>
      <dt>Name</dt><dd>${escapeHtml(displayName)}</dd>
      <dt>Mobility</dt><dd>${escapeHtml(mobility)}</dd>
      <dt>Track span</dt><dd>${escapeHtml(trackSpan)}</dd>
      <dt>Confidence</dt><dd>${escapeHtml(confidence)}</dd>
      <dt>Observations</dt><dd>${escapeHtml(observations)}</dd>
    </dl>
    <details class="signal-details">
      <summary>Observation signals (${escapeHtml(observations)})</summary>
      <ol>${signalRows}</ol>
    </details>
  `;
}


function isMobileDevice(device) {
  const obsCount = Number(device.obsCount) || 0;
  const spreadAvg = obsCount ? device.varianceAccumulator / obsCount : 0;

  if (spreadAvg > 120) return true;
  if (obsCount < 5) return device.trackSpanMeters > 180;
  return device.trackSpanMeters > 260 && spreadAvg > 55;
}

function styleForConfidence(level, hasSelectedDevice, isSelected) {
  const faded = hasSelectedDevice && !isSelected;
  if (level === 2) return { stroke: faded ? '#3730a3' : '#4f46e5', fill: '#6366f1', fillOpacity: faded ? 0.12 : 0.62 };
  if (level === 1) return { stroke: faded ? '#5b21b6' : '#7c3aed', fill: '#8b5cf6', fillOpacity: faded ? 0.12 : 0.54 };
  return { stroke: faded ? '#1e293b' : '#334155', fill: '#64748b', fillOpacity: faded ? 0.11 : 0.42 };
}

function lineStyleForMobility(mac, selected, hasSelectedTrail) {
  if (selected) {
    return {
      hitTarget: { color: '#000', weight: 16, opacity: 0, lineCap: 'round', lineJoin: 'round' },
      outline: { color: '#0f172a', weight: 2.6, opacity: 0.95, lineCap: 'round', lineJoin: 'round' },
      core: { color: '#22d3ee', weight: 1.4, opacity: 1, lineCap: 'round', lineJoin: 'round' },
    };
  }

  const faded = hasSelectedTrail;
  return {
    hitTarget: { color: '#000', weight: 14, opacity: 0, lineCap: 'round', lineJoin: 'round' },
    outline: {
      color: '#0b1224',
      weight: 2.2,
      opacity: faded ? 0.16 : 0.58,
      lineCap: 'round',
      lineJoin: 'round',
    },
    core: {
      color: mobileShadeForDevice(mac),
      weight: 1.2,
      opacity: faded ? 0.24 : 0.92,
      lineCap: 'round',
      lineJoin: 'round',
    },
  };
}

function mobileShadeForDevice(mac) {
  const shades = ['#cbd5e1', '#b6c2d1', '#a5b4c8', '#94a3b8', '#7f90a8', '#6f8199'];
  const key = String(mac || '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return shades[hash % shades.length];
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

function markerTypeClass(type) {
  if (type === 'bluetooth') return 'hotspot-marker--bluetooth';
  if (type === 'cellular') return 'hotspot-marker--cellular';
  return 'hotspot-marker--wifi';
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
  const playbackStart = state.metadata.playbackStartTime ?? state.metadata.startTime;
  const playbackEnd = state.metadata.playbackEndTime ?? state.metadata.endTime;
  const nextTime = Math.min((state.activeTime ?? playbackStart) + advanceMs, playbackEnd);
  seekToTime(nextTime);

  if (nextTime >= playbackEnd) {
    stopPlayback();
    return;
  }

  state.rafId = requestAnimationFrame(tick);
}

function stepBy(direction) {
  if (!state.observations.length) return;

  const targetIndex = direction > 0 ? Math.min(state.cursor, state.observations.length - 1) : Math.max(0, state.cursor - 2);
  const targetTime = observationPlaybackTime(state.observations[targetIndex]);
  if (targetTime != null) seekToTime(targetTime);
}

function refreshAllLayers() {
  redrawRoute();
  renderRawPoints();
  renderEstimatedDevices();
  renderViewportPanel();
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
  state.selectedDeviceMac = null;
  state.cursor = 0;
  state.activeTime = null;
  routeFullLayer.setLatLngs([]);
  routeTraversedLayer.setLatLngs([]);
  rawLayer.clearLayers();
  estimatedLayer.clearLayers();
  renderViewportPanel();
}

function observationPlaybackTime(observation) {
  if (!observation) return null;
  return observation.playbackTime ?? observation.timestamp;
}

function realTimestampForPlayback(playbackTime) {
  if (!state.observations.length) return null;
  let left = 0;
  let right = state.observations.length - 1;
  let best = 0;
  while (left <= right) {
    const mid = (left + right) >> 1;
    const midTime = observationPlaybackTime(state.observations[mid]);
    if (midTime <= playbackTime) {
      best = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return state.observations[best]?.timestamp ?? playbackTime;
}

function fmtTime(ts) {
  if (!ts) return '--';
  return new Date(ts).toLocaleString();
}

function fmtDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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
