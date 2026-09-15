'use strict';

/* ============================================================
 * Konstanten (bewusst fest im Code, keine UI-Regler dafür)
 * ============================================================ */
const Q_MIN = 0.3;
const Q_MAX = 9.9;
const GAIN_MIN = -15;
const GAIN_MAX = 15;

const GRID_POINTS = 400;      // Auflösung des internen Rechen-Gitters
const GRID_F_MIN = 20;        // Hz
const GRID_F_MAX = 20000;     // Hz
const SAMPLE_RATE = 48000;    // nur für die digitale Biquad-Formel relevant
const REFINE_ITERATIONS = 2000; // Hill-Climbing-Nachbesserung
const HIGH_Q_GAIN_PENALTY = 0.005; // leichter Strafterm gegen extreme High-Q/High-Gain-Kombis (wie AutoEQ)

/* ============================================================
 * Hilfsfunktionen
 * ============================================================ */
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// Ausgabe-Auflösung: Freq/Gain auf ganze Zahlen, Q auf eine Nachkommastelle -
// das ist die Präzision, die reale PEQ-Hardware/-Software ohnehin erwartet.
function roundBand(band) {
  return {
    freq: clamp(Math.round(band.freq), GRID_F_MIN, GRID_F_MAX),
    gain: clamp(Math.round(band.gain), GAIN_MIN, GAIN_MAX),
    q: clamp(Math.round(band.q * 10) / 10, Q_MIN, Q_MAX),
  };
}

/* ============================================================
 * Parser: akzeptiert "freq db" pro Zeile, mit beliebigen
 * Text-Headerzeilen davor/dazwischen (wie im hifi-apps.com Export).
 * Whitespace- oder Komma-getrennt.
 * ============================================================ */
function parseFrequencyFile(text) {
  const points = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/[,\t ]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const f = Number(parts[0]);
    const db = Number(parts[1]);
    if (!Number.isFinite(f) || !Number.isFinite(db) || f <= 0) continue;
    points.push({ freq: f, db });
  }
  points.sort((a, b) => a.freq - b.freq);

  // Doppelte/rundungsgleiche Frequenzen mitteln (nicht: letzten Wert nehmen).
  // Rohe, ungeglättete Messungen (z.B. "FR Roh") enthalten oft mehrere sehr
  // eng benachbarte Punkte mit stark schwankenden dB-Werten (Messrauschen) -
  // "letzter gewinnt" würde davon einen zufälligen picken statt zu mitteln.
  const deduped = [];
  for (const p of points) {
    const last = deduped[deduped.length - 1];
    if (last && last.freq === p.freq) {
      last.db = (last.db * last._n + p.db) / (last._n + 1);
      last._n += 1;
    } else {
      deduped.push({ freq: p.freq, db: p.db, _n: 1 });
    }
  }
  return deduped.map((p) => ({ freq: p.freq, db: p.db }));
}

/* ============================================================
 * Log-Gitter + Resampling der Messpunkte darauf
 * ============================================================ */
function buildLogGrid(n = GRID_POINTS, fMin = GRID_F_MIN, fMax = GRID_F_MAX) {
  const grid = new Array(n);
  const logMin = Math.log10(fMin);
  const logMax = Math.log10(fMax);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    grid[i] = Math.pow(10, logMin + t * (logMax - logMin));
  }
  return grid;
}

// Glättung in Bruchteil-Oktaven (wie REW/AutoEQ es vor dem EQ-Fit tun).
// Rohe ("FR Roh") Messungen sind oft von Reflexionen/Kammfiltern übersät
// (einzelne, sehr schmale dB-Sprünge von Punkt zu Punkt) - ohne Glättung
// würde der Fit auf dieses Rauschen reagieren statt auf den echten Trend.
const SMOOTH_OCTAVE_FRACTION = 1 / 6;

function smoothGridValues(values, pointsPerOctave, fraction = SMOOTH_OCTAVE_FRACTION) {
  const halfWindow = Math.max(1, Math.round((pointsPerOctave * fraction) / 2));
  const n = values.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let k = -halfWindow; k <= halfWindow; k++) {
      const idx = i + k;
      if (idx < 0 || idx >= n) continue;
      sum += values[idx];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

// Mehrere Kurven (schon auf dasselbe Gitter resampled) zu einer zusammenführen.
// Median ist robuster gegen eine einzelne schlechte/verrauschte Messung als der
// Mittelwert (der jeden Ausreißer voll mit einrechnet) - daher Default.
function aggregateCurves(valueArrays, method = 'median') {
  const n = valueArrays[0].length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const vals = valueArrays.map((arr) => arr[i]).sort((a, b) => a - b);
    if (method === 'mean') {
      out[i] = vals.reduce((s, v) => s + v, 0) / vals.length;
    } else {
      const mid = Math.floor(vals.length / 2);
      out[i] = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    }
  }
  return out;
}

function resampleToGrid(points, grid) {
  const n = points.length;
  const out = new Array(grid.length);
  let idx = 0;
  for (let i = 0; i < grid.length; i++) {
    const f = grid[i];
    if (f <= points[0].freq) { out[i] = points[0].db; continue; }
    if (f >= points[n - 1].freq) { out[i] = points[n - 1].db; continue; }
    while (idx < n - 2 && points[idx + 1].freq < f) idx++;
    const a = points[idx], b = points[idx + 1];
    const logF = Math.log10(f), logA = Math.log10(a.freq), logB = Math.log10(b.freq);
    const t = logB > logA ? (logF - logA) / (logB - logA) : 0;
    out[i] = a.db + t * (b.db - a.db);
  }
  return out;
}

/* ============================================================
 * RBJ Peaking-EQ (Cookbook-Formeln), Magnitude direkt in dB
 * ============================================================ */
function peakingFilterCoeffs(f0, Q, gainDb, fs) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * clamp(f0, 1, fs / 2 - 1) / fs;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);

  const b0 = 1 + alpha * A;
  const b1 = -2 * cosw0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha / A;

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function biquadMagnitudeDb(coeffs, freq, fs) {
  const w = 2 * Math.PI * freq / fs;
  const cosw = Math.cos(w), sinw = Math.sin(w);
  const cos2w = Math.cos(2 * w), sin2w = Math.sin(2 * w);

  const numRe = coeffs.b0 + coeffs.b1 * cosw + coeffs.b2 * cos2w;
  const numIm = -coeffs.b1 * sinw - coeffs.b2 * sin2w;
  const denRe = 1 + coeffs.a1 * cosw + coeffs.a2 * cos2w;
  const denIm = -coeffs.a1 * sinw - coeffs.a2 * sin2w;

  const numMag = Math.hypot(numRe, numIm);
  const denMag = Math.hypot(denRe, denIm) || 1e-12;
  return 20 * Math.log10(numMag / denMag);
}

function bandResponseOnGrid(band, grid, fs = SAMPLE_RATE) {
  const coeffs = peakingFilterCoeffs(band.freq, band.q, band.gain, fs);
  const out = new Array(grid.length);
  for (let i = 0; i < grid.length; i++) out[i] = biquadMagnitudeDb(coeffs, grid[i], fs);
  return out;
}

function sumBandsOnGrid(bands, grid, fs = SAMPLE_RATE) {
  const total = new Array(grid.length).fill(0);
  for (const band of bands) {
    const resp = bandResponseOnGrid(band, grid, fs);
    for (let i = 0; i < grid.length; i++) total[i] += resp[i];
  }
  return total;
}

/* ============================================================
 * Greedy-Fit: größte Abweichung finden -> Band draufsetzen ->
 * Fehler aktualisieren -> wiederholen. Danach Hill-Climbing
 * Nachbesserung als einfacher Ersatz für einen echten Optimizer.
 * ============================================================ */
function fitPeq(points, { fMin, fMax, numBands }) {
  if (points.length < 2) throw new Error('Zu wenige Datenpunkte in der Datei.');
  if (!(fMax > fMin)) throw new Error('Max-Frequenz muss größer als Min-Frequenz sein.');

  const grid = buildLogGrid();
  const pointsPerOctave = (grid.length - 1) / Math.log2(GRID_F_MAX / GRID_F_MIN);
  const measured = smoothGridValues(resampleToGrid(points, grid), pointsPerOctave);

  const rangeIdx = [];
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] >= fMin && grid[i] <= fMax) rangeIdx.push(i);
  }
  if (rangeIdx.length < 3) {
    throw new Error('Gewählter Frequenzbereich ist zu schmal.');
  }
  const rangeLoIdx = rangeIdx[0];
  const rangeHiIdx = rangeIdx[rangeIdx.length - 1];

  const target = rangeIdx.reduce((s, i) => s + measured[i], 0) / rangeIdx.length;

  const error = measured.map((v) => v - target);
  const bands = [];

  for (let b = 0; b < numBands; b++) {
    let bestI = rangeIdx[0];
    let bestAbs = Math.abs(error[bestI]);
    for (const i of rangeIdx) {
      const a = Math.abs(error[i]);
      if (a > bestAbs) { bestAbs = a; bestI = i; }
    }
    if (bestAbs < 0.05) break; // schon flach genug, keine weiteren Bänder nötig

    const f0 = grid[bestI];
    const peakVal = error[bestI];
    const halfAbs = Math.abs(peakVal) / 2;
    const sign = Math.sign(peakVal);

    // Bandbreiten-Schätzung bleibt innerhalb des gewählten Frequenzfensters -
    // sonst würde z.B. bei "nur Hochtöner" ein Peak nahe der unteren Grenze
    // seine Breite über Werte außerhalb des Fensters schätzen.
    let lo = bestI;
    while (lo > rangeLoIdx && Math.sign(error[lo]) === sign && Math.abs(error[lo]) > halfAbs) lo--;
    let hi = bestI;
    while (hi < rangeHiIdx && Math.sign(error[hi]) === sign && Math.abs(error[hi]) > halfAbs) hi++;

    const fLo = grid[lo], fHi = grid[hi];
    let q = fHi > fLo ? f0 / (fHi - fLo) : 1.4;
    if (!Number.isFinite(q) || q <= 0) q = 1.4;
    q = clamp(q, Q_MIN, Q_MAX);

    const gain = clamp(-peakVal, GAIN_MIN, GAIN_MAX);

    const band = { freq: f0, q, gain };
    bands.push(band);

    // resp ist das, was auf "measured" addiert wird -> auch die Fehlerkurve
    // (measured - target) bekommt resp addiert, nicht subtrahiert.
    const resp = bandResponseOnGrid(band, grid);
    for (let i = 0; i < grid.length; i++) error[i] += resp[i];
  }

  // Mehr Bänder -> mehr Parameter zum Nachjustieren -> mehr Iterationen, sonst
  // bekäme bei z.B. 40 Bändern jedes einzelne im Schnitt viel zu wenig
  // Gelegenheit, sich vom groben Anfangs-Schätzwert wegzubewegen.
  const refineIterations = clamp(numBands * 100, REFINE_ITERATIONS, 6000);
  refineBands(bands, grid, measured, target, rangeIdx, refineIterations);
  // Nach dem Runden auf ganze dB kann ein Band bei Gain 0 landen - das ist ein
  // Peaking-Filter ohne jede Wirkung (No-Op) und verschwendet nur einen der
  // gewünschten Bänder-Slots, also raus damit.
  const rounded = bands.map(roundBand).filter((b) => b.gain !== 0);
  rounded.sort((a, b) => a.freq - b.freq);
  return { bands: rounded, grid, measured, target };
}

function refineBands(bands, grid, measured, target, rangeIdx, iterations = REFINE_ITERATIONS) {
  if (bands.length === 0) return;
  const n = grid.length;
  const bandResp = bands.map((b) => bandResponseOnGrid(b, grid));
  const total = new Array(n).fill(0);
  for (const resp of bandResp) {
    for (let i = 0; i < n; i++) total[i] += resp[i];
  }

  function lossOf(totalArr) {
    let sse = 0;
    for (const i of rangeIdx) {
      const d = measured[i] + totalArr[i] - target;
      sse += d * d;
    }
    let penalty = 0;
    for (const b of bands) penalty += HIGH_Q_GAIN_PENALTY * b.q * Math.abs(b.gain);
    return sse / rangeIdx.length + penalty;
  }

  let currentLoss = lossOf(total);

  for (let iter = 0; iter < iterations; iter++) {
    const bi = Math.floor(Math.random() * bands.length);
    const band = bands[bi];
    const backup = { freq: band.freq, q: band.q, gain: band.gain };
    const t = 1 - iter / iterations; // einfaches Annealing: Schritte werden kleiner

    const roll = Math.random();
    if (roll < 0.34) {
      const factor = 1 + (Math.random() * 2 - 1) * 0.15 * t;
      band.freq = clamp(band.freq * factor, grid[0], grid[grid.length - 1]);
    } else if (roll < 0.67) {
      band.q = clamp(band.q + (Math.random() * 2 - 1) * 1.5 * t, Q_MIN, Q_MAX);
    } else {
      band.gain = clamp(band.gain + (Math.random() * 2 - 1) * 2 * t, GAIN_MIN, GAIN_MAX);
    }

    const newResp = bandResponseOnGrid(band, grid);
    const newTotal = total.slice();
    for (let i = 0; i < n; i++) newTotal[i] += newResp[i] - bandResp[bi][i];

    const newLoss = lossOf(newTotal);
    if (newLoss < currentLoss) {
      currentLoss = newLoss;
      bandResp[bi] = newResp;
      for (let i = 0; i < n; i++) total[i] = newTotal[i];
    } else {
      band.freq = backup.freq;
      band.q = backup.q;
      band.gain = backup.gain;
    }
  }
}

/* ============================================================
 * Export: Equalizer-APO-Textformat
 * ============================================================ */
function bandsToEqualizerApoText(bands) {
  return bands
    .map((b, i) => {
      const idx = i + 1;
      const freq = Math.round(b.freq);
      const gain = Math.round(b.gain);
      const q = (Math.round(b.q * 10) / 10).toFixed(1);
      return `Filter ${idx}: ON PK Fc ${freq} Hz Gain ${gain} dB Q ${q}`;
    })
    .join('\n');
}

/* ============================================================
 * Chart-Rendering (Canvas 2D, log-X, dB-Y)
 * ============================================================ */
const NICE_FREQS = [20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000];

function niceStep(range) {
  const rawSteps = [1, 2, 5, 10, 20];
  for (const s of rawSteps) {
    if (range / s <= 8) return s;
  }
  return 20;
}

// Canvas auf CSS-Größe + devicePixelRatio einrichten und leeren.
function setupChartCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 900;
  const cssH = canvas.clientHeight || 420;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);
  return { ctx, W: cssW, H: cssH };
}

// dB-Anzeigebereich aus einer oder mehreren Werte-Arrays bestimmen (mit Padding).
function computeYRange(valueArrays) {
  let yMin = Infinity, yMax = -Infinity;
  for (const arr of valueArrays) {
    for (const v of arr) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) { yMin = -10; yMax = 10; }
  const rawSpan = Math.max(yMax - yMin, 6);
  return { yMin: yMin - rawSpan * 0.12, yMax: yMax + rawSpan * 0.12 };
}

// Achsen, Gitterlinien + Hintergrund zeichnen; liefert Koordinaten-Umrechner zurück.
function drawChartFrame(ctx, { W, H, yMin, yMax }) {
  const padL = 48, padR = 16, padT = 16, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const logLo = Math.log10(GRID_F_MIN), logHi = Math.log10(GRID_F_MAX);
  const xOf = (f) => padL + ((Math.log10(f) - logLo) / (logHi - logLo)) * plotW;
  const yOf = (db) => padT + ((yMax - db) / (yMax - yMin)) * plotH;

  ctx.fillStyle = '#f7f8fa';
  ctx.fillRect(padL, padT, plotW, plotH);
  ctx.strokeStyle = '#d0d5dd';
  ctx.strokeRect(padL, padT, plotW, plotH);

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#667085';
  ctx.strokeStyle = '#e4e7ec';
  const yStep = niceStep((yMax - yMin) / 6) || 5;
  const yStart = Math.ceil(yMin / yStep) * yStep;
  for (let db = yStart; db <= yMax; db += yStep) {
    const y = yOf(db);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(db.toFixed(0), padL - 6, y);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const f of NICE_FREQS) {
    const x = xOf(f);
    if (x < padL - 1 || x > padL + plotW + 1) continue;
    ctx.strokeStyle = '#e4e7ec';
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = '#667085';
    const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
    ctx.fillText(label, x, padT + plotH + 4);
  }

  return { padL, padT, padR, padB, plotW, plotH, xOf, yOf };
}

function drawSeriesLine(ctx, grid, xOf, yOf, values, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let i = 0; i < grid.length; i++) {
    const x = xOf(grid[i]);
    const y = yOf(values[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawLegend(ctx, padL, padT, items) {
  let lx = padL + 8, ly = padT + 8;
  ctx.font = '11px system-ui, sans-serif';
  for (const [color, label] of items) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly, 10, 3);
    ctx.fillStyle = '#344054';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 14, ly + 1);
    lx += 14 + ctx.measureText(label).width + 16;
  }
}

function drawChart(canvas, data) {
  const { grid, measured, corrected, filterSum, fMin, fMax, bands } = data;
  const { ctx, W, H } = setupChartCanvas(canvas);
  const { yMin, yMax } = computeYRange([measured, corrected]);
  const { padL, padT, plotW, plotH, xOf, yOf } = drawChartFrame(ctx, { W, H, yMin, yMax });

  // gewähltes Frequenzfenster markieren
  ctx.fillStyle = 'rgba(79, 70, 229, 0.06)';
  const xFMin = clamp(xOf(clamp(fMin, GRID_F_MIN, GRID_F_MAX)), padL, padL + plotW);
  const xFMax = clamp(xOf(clamp(fMax, GRID_F_MIN, GRID_F_MAX)), padL, padL + plotW);
  ctx.fillRect(xFMin, padT, xFMax - xFMin, plotH);
  ctx.strokeStyle = '#4f46e5';
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(xFMin, padT); ctx.lineTo(xFMin, padT + plotH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(xFMax, padT); ctx.lineTo(xFMax, padT + plotH); ctx.stroke();
  ctx.setLineDash([]);

  // Original (grau)
  drawSeriesLine(ctx, grid, xOf, yOf, measured, '#98a2b3', 1.5);
  // Summe der Filter (blau)
  if (bands.length) drawSeriesLine(ctx, grid, xOf, yOf, filterSum, '#2970ff', 1.25);
  // Ergebnis (grün)
  drawSeriesLine(ctx, grid, xOf, yOf, corrected, '#12b76a', 2);

  // Bandmarker (an der Kurvenoberkante, Position = Mittenfrequenz)
  ctx.fillStyle = '#f04438';
  for (const b of bands) {
    const x = xOf(b.freq);
    if (x < padL || x > padL + plotW) continue;
    ctx.beginPath();
    ctx.arc(x, padT + 6, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  drawLegend(ctx, padL, padT, [
    ['#98a2b3', 'Original (1/6 Okt. geglättet)'],
    ['#2970ff', 'Filtersumme'],
    ['#12b76a', 'Ergebnis (korrigiert)'],
  ]);
}

// Vergleichs-Chart für den "Mehrere Messungen zusammenführen"-Schritt:
// alle Einzelkurven dünn/hell, die zusammengeführte Kurve dick/farbig.
const MERGE_CURVE_COLOR = 'rgba(152, 162, 179, 0.6)';
const MERGE_RESULT_COLOR = '#e04f39';

function drawMergeChart(canvas, { grid, curves, merged }) {
  const { ctx, W, H } = setupChartCanvas(canvas);
  const { yMin, yMax } = computeYRange([...curves, merged]);
  const { padL, padT, xOf, yOf } = drawChartFrame(ctx, { W, H, yMin, yMax });

  for (const curve of curves) drawSeriesLine(ctx, grid, xOf, yOf, curve, MERGE_CURVE_COLOR, 1);
  drawSeriesLine(ctx, grid, xOf, yOf, merged, MERGE_RESULT_COLOR, 2.25);

  drawLegend(ctx, padL, padT, [
    [MERGE_CURVE_COLOR, `Einzelmessungen (${curves.length})`],
    [MERGE_RESULT_COLOR, 'Zusammengeführt'],
  ]);
}
