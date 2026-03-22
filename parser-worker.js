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

self.onmessage = (event) => {
  if (event.data?.type !== 'parseCsv') return;
  const text = event.data.text || '';
  try {
    const result = parseWigleCsv(text);
    self.postMessage({ type: 'parseResult', payload: result });
  } catch (error) {
    self.postMessage({ type: 'parseError', error: String(error?.message || error) });
  }
};

function parseWigleCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const headerIndex = findHeaderIndex(lines);
  if (headerIndex < 0) {
    throw new Error('Could not detect a CSV header with MAC/latitude/longitude/timestamp-like columns.');
  }

  const headers = parseCsvLine(lines[headerIndex]).map((h) => h.trim());
  const idx = toIndexMap(headers);

  const observations = [];
  let skippedRows = 0;

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

    if (!Number.isFinite(timestamp) || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !mac) {
      skippedRows += 1;
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

  const route = observations.map((o) => ({ timestamp: o.timestamp, latitude: o.latitude, longitude: o.longitude }));
  const types = Array.from(new Set(observations.map((o) => o.type)));
  const uniqueDevices = new Set(observations.map((o) => o.mac)).size;

  return {
    observations,
    route,
    metadata: {
      rowsLoaded: observations.length,
      rowsSkipped: skippedRows,
      uniqueDevices,
      types,
      startTime: observations[0]?.timestamp || null,
      endTime: observations.at(-1)?.timestamp || null,
    },
  };
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
