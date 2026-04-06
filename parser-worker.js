const TYPE_MAP = {
  wifi: 'wifi',
  wlan: 'wifi',
  'wi-fi': 'wifi',
  bluetooth: 'bluetooth',
  bt: 'bluetooth',
  ble: 'bluetooth',
  cell: 'cellular',
  cellular: 'cellular',
  lte: 'cellular',
  gsm: 'cellular',
  nr: 'cellular',
  '5g': 'cellular',
};
const GAP_COLLAPSE_THRESHOLD_MS = 2 * 60 * 1000;

self.onmessage = (event) => {
  if (event.data?.type !== 'parseCsv') return;
  const text = event.data.text || '';
  const selectedDays = Array.isArray(event.data.selectedDays) ? event.data.selectedDays : null;
  const requestId = event.data.requestId || null;
  try {
    const result = parseWigleCsv(text, selectedDays);
    if (result?.needsDaySelection) {
      self.postMessage({ type: 'parseNeedsDaySelection', payload: result, requestId });
    } else {
      self.postMessage({ type: 'parseResult', payload: result, requestId });
    }
  } catch (error) {
    self.postMessage({ type: 'parseError', error: String(error?.message || error), requestId });
  }
};

function parseWigleCsv(text, selectedDays = null) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const headerIndex = findHeaderIndex(lines);
  if (headerIndex < 0) {
    throw new Error('Could not detect a CSV header with MAC/latitude/longitude/timestamp-like columns.');
  }

  const headers = parseCsvLine(lines[headerIndex]).map((h) => h.trim());
  const idx = toIndexMap(headers);
  const days = collectDays(lines, headerIndex, idx);
  const availableDays = Array.from(days.keys()).sort();

  if (availableDays.length > 1 && !selectedDays?.length) {
    return {
      needsDaySelection: true,
      availableDays,
      latestDay: availableDays.at(-1) || null,
    };
  }

  const matchedSelectedDays = selectedDays?.length
    ? selectedDays.filter((value) => availableDays.includes(value))
    : [];
  if (selectedDays?.length && !matchedSelectedDays.length && availableDays.length) {
    return {
      needsDaySelection: true,
      availableDays,
      latestDay: availableDays.at(-1) || null,
      selectionInvalid: true,
    };
  }

  const selectedDaySet = matchedSelectedDays.length ? new Set(matchedSelectedDays) : null;

  const observations = [];
  let skippedRows = 0;
  let filteredRows = 0;

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const row = parseCsvLine(line);

    const mac = getField(row, idx, ['MAC']);
    const firstSeen = getField(row, idx, ['FirstSeen']);
    const latRaw = getField(row, idx, ['CurrentLatitude', 'Lat']);
    const lonRaw = getField(row, idx, ['CurrentLongitude', 'Lon', 'Lng']);
    const rssiRaw = getField(row, idx, ['RSSI']);
    const accuracyRaw = getField(row, idx, ['AccuracyMeters']);
    const typeRaw = getField(row, idx, ['Type']);

    const timestamp = Date.parse(firstSeen);
    const latitude = Number(latRaw);
    const longitude = Number(lonRaw);
    const dayKey = Number.isFinite(timestamp) ? toUtcDayKey(timestamp) : '';

    if (!Number.isFinite(timestamp) || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !mac) {
      skippedRows += 1;
      continue;
    }
    if (selectedDaySet && !selectedDaySet.has(dayKey)) {
      filteredRows += 1;
      continue;
    }

    const observation = {
      rowIndex: i,
      timestamp,
      latitude,
      longitude,
      altitude: asNum(getField(row, idx, ['AltitudeMeters'])),
      accuracy: normalizeAccuracy(asNum(accuracyRaw)),
      rssi: asNum(rssiRaw),
      channel: getField(row, idx, ['Channel']) || '',
      type: normalizeType(typeRaw),
      mac: mac.trim(),
      ssid: getField(row, idx, ['SSID']) || '',
      authMode: getField(row, idx, ['AuthMode']) || '',
      firstSeen,
    };

    observations.push(observation);
  }

  observations.sort((a, b) => a.timestamp - b.timestamp || a.rowIndex - b.rowIndex);
  const { collapsedGapMs, collapsedGapCount } = applyPlaybackTimeline(observations);

  const route = observations.map((o) => ({ timestamp: o.timestamp, latitude: o.latitude, longitude: o.longitude }));
  const types = Array.from(new Set(observations.map((o) => o.type)));
  const uniqueDevices = new Set(observations.map((o) => o.mac)).size;

  return {
    observations,
    route,
    metadata: {
      rowsLoaded: observations.length,
      rowsSkipped: skippedRows,
      rowsFilteredByDay: filteredRows,
      uniqueDevices,
      types,
      startTime: observations[0]?.timestamp || null,
      endTime: observations.at(-1)?.timestamp || null,
      playbackStartTime: observations[0]?.playbackTime || null,
      playbackEndTime: observations.at(-1)?.playbackTime || null,
      collapsedGapMs,
      collapsedGapCount,
      availableDays,
      selectedDays:
        selectedDaySet && selectedDaySet.size ? Array.from(selectedDaySet).sort() : [...availableDays],
    },
  };
}

function applyPlaybackTimeline(observations) {
  if (!observations.length) {
    return { collapsedGapMs: 0, collapsedGapCount: 0 };
  }

  let playbackTime = observations[0].timestamp;
  let collapsedGapMs = 0;
  let collapsedGapCount = 0;
  observations[0].playbackTime = playbackTime;

  for (let i = 1; i < observations.length; i += 1) {
    const gapMs = Math.max(0, observations[i].timestamp - observations[i - 1].timestamp);
    if (gapMs > GAP_COLLAPSE_THRESHOLD_MS) {
      collapsedGapMs += gapMs;
      collapsedGapCount += 1;
    } else {
      playbackTime += gapMs;
    }
    observations[i].playbackTime = playbackTime;
  }

  return { collapsedGapMs, collapsedGapCount };
}

function collectDays(lines, headerIndex, idx) {
  const dayMap = new Map();
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const row = parseCsvLine(line);
    const firstSeen = getField(row, idx, ['FirstSeen']);
    const timestamp = Date.parse(firstSeen);
    if (!Number.isFinite(timestamp)) continue;
    const dayKey = toUtcDayKey(timestamp);
    dayMap.set(dayKey, (dayMap.get(dayKey) || 0) + 1);
  }
  return dayMap;
}

function toUtcDayKey(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function findHeaderIndex(lines) {
  for (let i = 0; i < Math.min(lines.length, 60); i += 1) {
    const cols = parseCsvLine(lines[i]).map((c) => c.trim());
    const hasMac = cols.includes('MAC');
    const hasLat = cols.includes('CurrentLatitude') || cols.includes('Lat');
    const hasLon = cols.includes('CurrentLongitude') || cols.includes('Lon') || cols.includes('Lng');
    if (hasMac && hasLat && hasLon) return i;
  }
  return -1;
}

function toIndexMap(headers) {
  const out = {};
  headers.forEach((h, i) => {
    out[h] = i;
  });
  return out;
}

function getField(row, idx, names) {
  for (const name of names) {
    if (idx[name] !== undefined) return row[idx[name]];
  }
  return '';
}

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeAccuracy(v) {
  if (!Number.isFinite(v) || v <= 0) return 50;
  return v;
}

function normalizeType(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return TYPE_MAP[key] || (key.includes('blu') ? 'bluetooth' : key.includes('cell') ? 'cellular' : 'wifi');
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
