/*!
 * Lumidi engine - image → key → melody/chords/arpeggio → MIDI.
 *
 * A JavaScript port of the Lumena C++ library
 * (https://github.com/pixelsncodes/lumena), commit 03fcd8a (2026-07-11).
 * Comments name the upstream file/function each piece comes from.
 *
 * Portions Copyright (c) 2026 Kazi Ahmed, used under the MIT License
 * (see THIRD_PARTY_LICENSE.txt).
 *
 * Differences from the native build, by design:
 *  - The RNG is mulberry32, not std::mt19937, so a seed gives a different
 *    (but still exactly reproducible) result than the native app.
 *  - Diagnostics-only tracks (dbgStrong etc.) are not ported.
 *
 * No DOM access: every function here is pure, so it also runs under Node.
 */
const LumidiEngine = (() => {
"use strict";

// ===========================================================================
// Basics
// ===========================================================================
const TICKS = 960;                       // kTicksPerBeat
const clampUnit = (x) => x < 0 ? 0 : (x > 1 ? 1 : x);
const wrap = (v, span) => span <= 0 ? 0 : ((v % span) + span) % span;
const clampMidi = (v) => v < 0 ? 0 : (v > 127 ? 127 : v);
const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY = [-1, -1, -1, 0, 0, 1, 1, 1];

// Seeded PRNG (mulberry32): a given seed always reproduces the same output.
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng, n) => Math.min(n - 1, Math.floor(rng() * n)); // [0, n)

// ===========================================================================
// Scales - ScaleType.cpp, KeySelector.cpp, Scale.cpp, config/scales.json
// ===========================================================================
const SCALE_INTERVALS = {
  MajorPentatonic: [0,2,4,7,9],
  MinorPentatonic: [0,3,5,7,10],
  Phrygian:        [0,1,3,5,7,8,10],
  Aeolian:         [0,2,3,5,7,8,10],
  Dorian:          [0,2,3,5,7,9,10],
  Mixolydian:      [0,2,4,5,7,9,10],
  Ionian:          [0,2,4,5,7,9,11],
  Lydian:          [0,2,4,6,7,9,11],
  BluesMinor:      [0,3,5,6,7,10],
  HarmonicMinor:   [0,2,3,5,7,8,11],
};
const SCALE_NAMES = {
  MajorPentatonic:"Major Pentatonic", MinorPentatonic:"Minor Pentatonic",
  Phrygian:"Phrygian", Aeolian:"Minor", Dorian:"Dorian", Mixolydian:"Mixolydian",
  Ionian:"Major", Lydian:"Lydian", BluesMinor:"Blues", HarmonicMinor:"Harmonic Minor",
};
const CIRCLE_NAMES = ["C","G","D","A","E","B","F#","C#/Db","Ab","Eb","Bb","F"];
const BASE_ROOT = 60; // C4

// The library used by Random key mode (config/scales.json).
const SCALE_LIBRARY = [
  ["A Minor Pentatonic", 57, "MinorPentatonic"], ["C Major Pentatonic", 60, "MajorPentatonic"],
  ["E Minor Pentatonic", 52, "MinorPentatonic"], ["G Major Pentatonic", 55, "MajorPentatonic"],
  ["D Dorian", 62, "Dorian"], ["E Phrygian", 64, "Phrygian"], ["F Lydian", 65, "Lydian"],
  ["G Mixolydian", 67, "Mixolydian"], ["A Minor", 57, "Aeolian"], ["C Major", 60, "Ionian"],
  ["A Blues", 57, "BluesMinor"], ["D Harmonic Minor", 62, "HarmonicMinor"],
].map(([keyName, rootNote, type]) => ({ keyName, rootNote, type, intervals: SCALE_INTERVALS[type] }));

function chooseScaleType(saturation, value){
  if (saturation < 0.22) return value >= 0.5 ? "MajorPentatonic" : "MinorPentatonic";
  if (saturation >= 0.70){
    if (value < 0.18) return "HarmonicMinor";
    if (value < 0.42) return "BluesMinor";
  }
  const modes = ["Phrygian","Aeolian","Dorian","Mixolydian","Ionian","Lydian"];
  return modes[Math.max(0, Math.min(5, Math.floor(value * 6)))];
}

function detectKey(color){
  let position, type;
  if (color.saturation < 0.05){
    position = 3; type = "MinorPentatonic";           // A minor pentatonic fallback
  } else {
    position = wrap(Math.round(color.hue / 30), 12);
    type = chooseScaleType(color.saturation, color.value);
  }
  return {
    hue: color.hue, saturation: color.saturation, value: color.value,
    position, type, intervals: SCALE_INTERVALS[type],
    rootNote: BASE_ROOT + (position * 7) % 12,
    keyName: CIRCLE_NAMES[position] + " " + SCALE_NAMES[type],
  };
}

function randomKey(rng){ return SCALE_LIBRARY[randInt(rng, SCALE_LIBRARY.length)]; }

// Scale::noteAt - wraps a scale-degree index across octaveSpan octaves.
function noteAt(scale, degree, span){
  const per = scale.intervals.length;
  if (per === 0) return scale.rootNote;
  span = Math.max(1, span);
  const w = wrap(degree, per * span);
  return scale.rootNote + scale.intervals[w % per] + 12 * Math.floor(w / per);
}

// ===========================================================================
// Image analysis - BrightnessGrid.cpp, ColorAnalysis.cpp, Luma.h
// `img` is an ImageData-like {data, width, height}.
// ===========================================================================
function rgbToHsv(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
  let h = 0;
  if (d > 0){
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max <= 0 ? 0 : d / max, v: max };
}

function makeGrid(cols, rows, values){
  return { cols, rows, values, valueAt(c, r){
    return (c < 0 || c >= cols || r < 0 || r >= rows) ? 0 : values[r * cols + c];
  }};
}

function analyzeImage(img, cols = 16, rows = 12){
  const { data, width: w, height: h } = img;
  const luma = new Float64Array(w * h);
  let sinSum = 0, cosSum = 0, satSum = 0, lumaSum = 0;
  for (let i = 0, p = 0; p < w * h; p++, i += 4){
    const r = data[i], g = data[i+1], b = data[i+2];
    const L = 0.2126*r + 0.7152*g + 0.0722*b;           // luma709, 0..255
    luma[p] = L;
    const hsv = rgbToHsv(r, g, b);
    const rad = hsv.h * Math.PI / 180;
    sinSum += hsv.s * Math.sin(rad); cosSum += hsv.s * Math.cos(rad);
    satSum += hsv.s; lumaSum += L / 255;
  }
  // Cells partition each axis exactly (cellSpan): no gaps, no overlap.
  const span = (i, n, extent) => {
    const b = Math.floor(i * extent / n);
    let e = Math.floor((i + 1) * extent / n);
    if (e <= b && b < extent) e = b + 1;
    return [b, e];
  };
  const cell = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++){
    const [y0, y1] = span(r, rows, h);
    for (let c = 0; c < cols; c++){
      const [x0, x1] = span(c, cols, w);
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++){ sum += luma[y*w + x]; n++; }
      cell[r*cols + c] = n ? sum / n : 0;
    }
  }
  // Stretched normalisation (min-max); a flat image stays all zeros.
  let lo = Infinity, hi = -Infinity;
  for (const v of cell){ if (v < lo) lo = v; if (v > hi) hi = v; }
  const values = new Float64Array(cols * rows);
  if (hi > lo) for (let k = 0; k < values.length; k++) values[k] = (cell[k] - lo) / (hi - lo);

  const n = w * h;
  let hue = Math.atan2(sinSum, cosSum) * 180 / Math.PI;
  if (hue < 0) hue += 360;
  return {
    grid: makeGrid(cols, rows, values),
    color: { hue, saturation: n ? satSum / n : 0, value: n ? lumaSum / n : 0 },
  };
}

// ===========================================================================
// Markov chain - TheoryWeights, TransitionMatrix::fromTheory, MelodyChain
// ===========================================================================
const THEORY = {
  intervalDecay: 0.5, repeatWeight: 0.5, thirdRepeatDamping: 0.25,
  tonicGravity: 0.4, centerGravity: 0.3, leapThreshold: 2.0, leapResolution: 4.0,
};

function theoryMatrix(total, perOctave, w){
  const center = (total - 1) / 2, rows = [];
  for (let i = 0; i < total; i++){
    const row = new Float64Array(total);
    let sum = 0;
    for (let j = 0; j < total; j++){
      const dist = Math.abs(i - j);
      const interval = dist === 0 ? w.repeatWeight : Math.pow(w.intervalDecay, dist - 1);
      const mod = j % perOctave;
      const tonic = 1 / (1 + Math.min(mod, perOctave - mod));
      const centre = center > 0 ? Math.max(0, 1 - Math.abs(j - center) / center) : 1;
      row[j] = Math.max(0, interval * (1 + w.tonicGravity*tonic + w.centerGravity*centre));
      sum += row[j];
    }
    for (let j = 0; j < total; j++) row[j] = sum > 0 ? row[j] / sum : 1 / total;
    rows.push(row);
  }
  return rows;
}

function makeChain(matrix, rng, w = THEORY){
  const n = matrix.length;
  let hasHistory = false, arrival = 0, repeatRun = 0;
  return {
    nextBiased(current, target, bias){
      current = Math.max(0, Math.min(n - 1, current));
      const work = Float64Array.from(matrix[current]);
      if (hasHistory && Math.abs(arrival) > w.leapThreshold){       // leap resolution
        const t = current + (arrival > 0 ? -1 : 1);
        if (t >= 0 && t < n) work[t] *= 1 + w.leapResolution;
      }
      if (repeatRun >= 1) work[current] *= w.thirdRepeatDamping;    // third-repeat damping
      let sum = 0; for (const v of work) sum += v;
      for (let j = 0; j < n; j++) work[j] = sum > 0 ? work[j] / sum : 1 / n;

      const b = clampUnit(bias);
      const td = Math.max(0, Math.min(n - 1, Math.round(target)));
      for (let j = 0; j < n; j++) work[j] *= (1 - b);
      work[td] += b;

      const r = rng(); let cum = 0, chosen = n - 1;
      for (let j = 0; j < n; j++){ cum += work[j]; if (r <= cum){ chosen = j; break; } }
      arrival = chosen - current;
      repeatRun = arrival === 0 ? repeatRun + 1 : 0;
      hasHistory = true;
      return chosen;
    },
  };
}

// ===========================================================================
// Shared generator helpers - MelodyGenerator.cpp
// ===========================================================================
const brightnessToDegree = (b, total) => Math.min(total - 1, Math.max(0, Math.floor(clampUnit(b) * total)));
const brightnessToVelocity = (b) => 50 + Math.round(clampUnit(b) * 65);   // 50..115
function applyEnergy(vel, energy){
  const v = Math.round(vel * (0.7 + 0.6 * clampUnit(energy)));
  return v < 1 ? 1 : (v > 127 ? 127 : v);
}
function flowingDuration(b, rng){
  const lengths = [0.5, 1.0, 2.0];
  const weights = [0.15 + b, 0.60, 0.15 + (1 - b)];
  let r = rng() * (weights[0] + weights[1] + weights[2]);
  for (let k = 0; k < 3; k++){ r -= weights[k]; if (r <= 0) return lengths[k]; }
  return 2.0;
}
function localContrast(grid, c, r){
  let lo = 1, hi = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
    const v = grid.valueAt(wrap(c + dx, grid.cols), wrap(r + dy, grid.rows));
    if (v < lo) lo = v; if (v > hi) hi = v;
  }
  return hi > lo ? hi - lo : 0;
}

const MAJOR_STEPS = [0,2,4,5,7,9,11];
const MINOR_STEPS = [0,2,3,5,7,8,10];
const pcsOf = (scale) => scale.intervals.map(iv => wrap(iv, 12));
const scaleIsMajor = (s) => { const p = pcsOf(s); return p.includes(4) && !p.includes(3); };
const scaleIsBlues = (s) => { const p = pcsOf(s); return p.includes(3) && p.includes(6) && p.includes(10); };

// Named pop progressions, one chord per bar (diatonic root degrees).
const PROGRESSIONS = [
  ["I-V-vi-IV", [0,4,5,3]], ["vi-IV-I-V", [5,3,0,4]], ["I-vi-IV-V", [0,5,3,4]],
  ["I-IV-vi-V", [0,3,5,4]], ["I-IV-V-vi", [0,3,4,5]], ["vi-IV-V-I", [5,3,4,0]],
];
// Lock Harmony: an explicit progression draws no RNG; otherwise draw one.
function pickOrDrawProgression(opts, rng){
  return opts.progression && opts.progression.length
    ? opts.progression.slice()
    : PROGRESSIONS[randInt(rng, PROGRESSIONS.length)][1].slice();
}
const tile = (base, count) => Array.from({ length: Math.max(1, count) }, (_, c) => base[c % base.length]);

function diatonicChord(scale, tonicPc, major, deg, size, baseMidi){
  const steps = scale.intervals.length === 7 ? scale.intervals : (major ? MAJOR_STEPS : MINOR_STEPS);
  const out = [];
  for (let k = 0; k < size; k++){
    const d = deg + 2 * k, idx = wrap(d, 7), oct = (d - idx) / 7;
    out.push(clampMidi(baseMidi + tonicPc + steps[idx] + 12 * oct));
  }
  return out;
}
function chordToneRole(note, chord){
  const pc = wrap(note, 12);
  const k = chord.findIndex(c => wrap(c, 12) === pc);
  return k < 0 ? 0 : k;
}
function orderChord(asc, pattern){
  const n = asc.length; let seq = [];
  if (pattern === "down") seq = asc.slice().reverse();
  else if (pattern === "updown"){ seq = asc.slice(); for (let i = n - 2; i >= 1; i--) seq.push(asc[i]); }
  else if (pattern === "converge"){
    let lo = 0, hi = n - 1, takeLo = true;
    while (lo <= hi){ seq.push(takeLo ? asc[lo++] : asc[hi--]); takeLo = !takeLo; }
  } else seq = asc.slice();                         // up, random
  return seq.length ? seq : [0];
}

// Roman numerals for a progression base, for display. Chord quality follows the
// same spelling the engine voices: Chords/Arpeggio use the scale's own steps for
// 7-note scales; the phrased melody uses the parent major/minor.
function progressionLabel(base, scale, mode){
  if (!base || !base.length) return "";
  const steps = (mode !== "melody" && scale.intervals.length === 7)
    ? scale.intervals : (scaleIsMajor(scale) ? MAJOR_STEPS : MINOR_STEPS);
  const ROMAN = ["I","II","III","IV","V","VI","VII"];
  return base.map(d => {
    const r = wrap(d, 7);
    const third = wrap(steps[wrap(r + 2, 7)] - steps[r], 12);
    const fifth = wrap(steps[wrap(r + 4, 7)] - steps[r], 12);
    if (third === 4) return ROMAN[r] + (fifth === 8 ? "+" : "");
    return ROMAN[r].toLowerCase() + (fifth === 6 ? "°" : "");
  }).join("-");
}

// ===========================================================================
// Phrased melody - PhraseBuilder + generatePhrased (MelodyGenerator.cpp)
// ===========================================================================
const REST_PROBABILITY = 0.6;
const PHRASE_END_BIAS = 0.85;
const CADENCE_BEATS = 2.0;
const PHRASE_END_CADENCE_BEATS = 1.5;
const ARP_BRIGHTNESS = 0.7;
const CONTOUR_VEL_LOW = 62, CONTOUR_VEL_HIGH = 112;
const CONTOUR_WEIGHT = 0.7, BRIGHTNESS_WEIGHT = 0.3;
const DYN_MIN = 35, DYN_MAX = 115;
const PEAK_FRACTION = 2/3, PEAK_JITTER = 0.08;
const PHRASE_END_ARC = 0.2, FINAL_PHRASE_SCALE = 0.85;
const BRIGHTNESS_INERTIA = 0.6, MAX_DYN_STEP = 12;
const OCTAVE_LIFT_PROBABILITY = 0.25;
const CONTOUR_SLOPE_THRESHOLD = 0.03;
const TELEPORT_WINDOW_BASE = 2, TELEPORT_WINDOW_REF_COLS = 16;
const REGISTER_BAND_A = 6.0, REGISTER_BAND_B = 9.0;
const PHRASE_COMPASS = 4, FOLD_EDGE_MARGIN = 1;
const MIN_SUBDIVISION_TICKS = TICKS / 64;
const RHYTHM_TEMPLATES = [                 // each sums to two 4/4 bars
  [1,1,1,1, 2,1,1],
  [0.75,0.75,0.5,0.75,0.75,0.5, 0.75,0.75,0.5,0.75,0.75,0.5],
  [0.5,0.5,0.5,0.5,0.75,0.75,0.5, 0.5,0.5,0.5,0.5,0.75,0.75,0.5],
];

class PhraseBuilder {
  constructor(grid, scale, opts, chain, total, rng){
    Object.assign(this, { grid, scale, opts, chain, total, rng });
    this.per = scale.intervals.length;
    this.bias = opts.brightnessBias;
    this.col = Math.floor(grid.cols / 2); this.row = Math.floor(grid.rows / 2);
    this.degree = Math.floor(total / 2);
    this.prevCol = -1; this.prevRow = -1;
    this.contour = "rise"; this.contourIdx = 0; this.contourLen = 1;
    this.octaveLiftedLast = false;
    this.motifAnchorCol = -1; this.motifAnchorRow = -1;
    this.shadowDCol = 0; this.shadowDRow = 0;

    const pcs = pcsOf(scale);
    this.tonicPc = wrap(scale.rootNote, 12);
    this.progMajor = pcs.includes(4) && !pcs.includes(3);
    this.beatsPerBar = opts.beatsPerBar > 0 ? opts.beatsPerBar : 4;
    this.chordPcs = [0, 4, 7];
    this.progression = pickOrDrawProgression(opts, rng);
    this.updateHarmonyTarget(0);
    let sum = 0;
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) sum += localContrast(grid, c, r);
    this.imageDetail = clampUnit(sum / (grid.cols * grid.rows));
    this.pickRhythmTemplate();
  }

  uni01(){ return this.rng(); }
  clampDegree(d){ return d < 0 ? 0 : (d >= this.total ? this.total - 1 : d); }
  pitchClassOf(d){ return this.scale.intervals[wrap(d, this.per)] % 12; }
  noteOf(d){ return noteAt(this.scale, d, this.opts.octaveSpan); }

  // One chord per bar, cycling the progression; triads from the parent major/minor.
  updateHarmonyTarget(beat){
    const tick = Math.round(beat * TICKS);
    const tpb = Math.round(TICKS * this.beatsPerBar);
    const bars = tpb > 0 ? Math.floor(tick / tpb) : 0;
    const root = this.progression[wrap(bars, this.progression.length)];
    const steps = this.progMajor ? MAJOR_STEPS : MINOR_STEPS;
    for (let k = 0; k < 3; k++) this.chordPcs[k] = wrap(this.tonicPc + steps[wrap(root + 2*k, 7)], 12);
  }

  pickRhythmTemplate(){
    const activity = clampUnit(0.5 * clampUnit(this.opts.energy) + 0.5 * this.imageDetail);
    const last = RHYTHM_TEMPLATES.length - 1;
    const weights = RHYTHM_TEMPLATES.map((_, i) => { const m = 1 - Math.abs(activity - i / last); return 0.04 + m*m*m; });
    let r = this.rng() * weights.reduce((a, b) => a + b, 0), pick = last;
    for (let i = 0; i < weights.length; i++){ r -= weights[i]; if (r < 0){ pick = i; break; } }
    this.rhythmTemplate = RHYTHM_TEMPLATES[pick];
  }

  selectContour(c, r){
    const { grid } = this;
    const sx = grid.valueAt(wrap(c+1, grid.cols), r) - grid.valueAt(wrap(c-1, grid.cols), r);
    const sy = grid.valueAt(c, wrap(r+1, grid.rows)) - grid.valueAt(c, wrap(r-1, grid.rows));
    const slope = sx + sy;
    return slope > CONTOUR_SLOPE_THRESHOLD ? "rise" : (slope < -CONTOUR_SLOPE_THRESHOLD ? "fall" : "arch");
  }
  contourDir(){
    if (this.contour === "rise") return 1;
    if (this.contour === "fall") return -1;
    return this.contourIdx < Math.floor((this.contourLen - 1) / 2) ? 1 : -1;
  }

  // Contour-steered walk: move to the neighbour whose brightness change best
  // follows the phrase's rise/fall/arch, never straight back.
  stepCell(){
    const { grid } = this;
    const prevBright = grid.valueAt(this.col, this.row);
    if (this.opts.cellPath === "random"){
      this.col = randInt(this.rng, grid.cols); this.row = randInt(this.rng, grid.rows);
    } else {
      const dir = this.contourDir();
      let bestK = -1, bestScore = -Infinity;
      for (let k = 0; k < 8; k++){
        const nc = wrap(this.col + DX[k], grid.cols), nr = wrap(this.row + DY[k], grid.rows);
        if (nc === this.prevCol && nr === this.prevRow) continue;
        const score = dir * (grid.valueAt(nc, nr) - prevBright);
        if (score > bestScore){ bestScore = score; bestK = k; }
      }
      if (bestK < 0) bestK = 0;
      this.prevCol = this.col; this.prevRow = this.row;
      this.col = wrap(this.col + DX[bestK], grid.cols); this.row = wrap(this.row + DY[bestK], grid.rows);
    }
    this.contourIdx++;
    const brightness = grid.valueAt(this.col, this.row);
    const shadowed = this.shadowDCol !== 0 || this.shadowDRow !== 0;
    const material = shadowed
      ? grid.valueAt(Math.max(0, Math.min(grid.cols-1, this.col + this.shadowDCol)),
                     Math.max(0, Math.min(grid.rows-1, this.row + this.shadowDRow)))
      : brightness;
    return { col: this.col, row: this.row, brightness, material };
  }

  planPhraseCells(count, newRegion){
    this.shadowDCol = 0; this.shadowDRow = 0;
    if (newRegion){
      // B phrase: teleport the walk, but read pitch material from a window
      // around motif A's anchor so B is related to A (Variant C, C-1).
      this.col = randInt(this.rng, this.grid.cols);
      this.row = randInt(this.rng, this.grid.rows);
      if (this.motifAnchorCol >= 0){
        const w = Math.max(1, Math.floor(TELEPORT_WINDOW_BASE * this.grid.cols / TELEPORT_WINDOW_REF_COLS));
        const span = 2*w + 1;
        const relCol = Math.max(0, Math.min(this.grid.cols-1, this.motifAnchorCol + (this.col % span) - w));
        const relRow = Math.max(0, Math.min(this.grid.rows-1, this.motifAnchorRow + (this.row % span) - w));
        this.shadowDCol = relCol - this.col; this.shadowDRow = relRow - this.row;
      }
    }
    this.contour = this.selectContour(this.col, this.row);
    this.contourIdx = 0; this.contourLen = count > 0 ? count : 1;
    this.prevCol = -1; this.prevRow = -1;
    const cells = [];
    for (let i = 0; i < count; i++) cells.push(this.stepCell());
    return cells;
  }

  nearestChordToneDegree(from){
    for (let r = 0; r < this.total; r++){
      for (const s of [from - r, from + r]){
        if (s < 0 || s >= this.total) continue;
        if (this.chordPcs.includes(this.noteOf(s) % 12)) return s;
      }
    }
    return this.clampDegree(from);
  }
  nearestTonicDegree(from){
    let best = from, bestDist = Infinity;
    for (let d = 0; d < this.total; d++){
      if (this.pitchClassOf(d) !== 0) continue;
      const dist = Math.abs(d - from);
      if (dist < bestDist){ bestDist = dist; best = d; }
    }
    return best;
  }

  // The pitch pass, against the real start ticks the timing plan assigned.
  walkDegreesAt(cells, startTicks){
    const complexity = clampUnit(this.opts.arpeggioAmount);
    const phrase = [];
    let entry = -1;
    for (let i = 0; i < cells.length; i++){
      const ending = i + 1 === cells.length;
      const tick = startTicks[i];
      this.updateHarmonyTarget(tick / TICKS);
      const strong = (tick % TICKS) === 0 || i === 0;   // real beats + phrase entry
      if (ending){
        const target = this.nearestChordToneDegree(this.degree);
        this.degree = this.chain.nextBiased(this.degree, target, PHRASE_END_BIAS);
        this.degree = this.nearestChordToneDegree(this.degree);
      } else {
        const imageTarget = brightnessToDegree(cells[i].material, this.total);
        let next = this.chain.nextBiased(this.degree, imageTarget, this.bias);
        if (this.uni01() < complexity * 0.4){                    // Complexity: occasional leap
          const sign = this.uni01() < 0.5 ? -1 : 1;
          next = this.clampDegree(next + sign * (2 + Math.floor(this.uni01() * 2)));
        }
        if (entry >= 0){                                          // register compass
          if (next < entry - PHRASE_COMPASS) next = this.clampDegree(entry - PHRASE_COMPASS);
          if (next > entry + PHRASE_COMPASS) next = this.clampDegree(entry + PHRASE_COMPASS);
        }
        const snapCoin = this.uni01();
        if (strong && snapCoin < 0.6) next = this.nearestChordToneDegree(next);
        const antiStuck = this.uni01();
        if (next === this.degree) next = this.clampDegree(next + (antiStuck < 0.5 ? -1 : 1));
        this.degree = next;
      }
      if (entry < 0) entry = this.degree;
      phrase.push({ degree: this.degree, noteNumber: this.noteOf(this.degree), velocity: 0,
        lengthBeats: 1.0, brightness: cells[i].brightness, col: cells[i].col, row: cells[i].row,
        templated: true });
    }
    return phrase;
  }

  drawCadenceLength(){ return this.rng() < 0.5 ? CADENCE_BEATS : 2 * CADENCE_BEATS; }

  // Approach the final tonic by step (leading tone when the scale has one).
  finishClosingPhrase(phrase, cadenceLength){
    const tonic = this.nearestTonicDegree(this.degree);
    if (phrase.length){
      const aboveOk = tonic + 1 < this.total, belowOk = tonic - 1 >= 0;
      if (aboveOk || belowOk){
        const approach = phrase[phrase.length - 1];
        let step;
        if (belowOk && this.pitchClassOf(tonic - 1) === 11) step = tonic - 1;
        else if (aboveOk && belowOk)
          step = Math.abs(tonic + 1 - approach.degree) <= Math.abs(tonic - 1 - approach.degree) ? tonic + 1 : tonic - 1;
        else step = aboveOk ? tonic + 1 : tonic - 1;
        approach.degree = step; approach.noteNumber = this.noteOf(step);
      }
    }
    this.degree = tonic;
    const b = this.grid.valueAt(this.col, this.row);
    phrase.push({ degree: tonic, noteNumber: this.noteOf(tonic), velocity: brightnessToVelocity(b),
      lengthBeats: cadenceLength, brightness: b, col: this.col, row: this.row, templated: false });
  }

  // A': transpose the motif by one step (image-guided or random), maybe lift an
  // octave, and in Flowing mode re-roll one note's length.
  varyMotif(motif){
    const v = motif.map(n => ({ ...n }));
    if (!v.length) return v;
    let lo = Infinity, hi = -Infinity;
    for (const n of v){ lo = Math.min(lo, n.degree); hi = Math.max(hi, n.degree); }
    const anchor = v[0].degree;
    const regionBright = this.grid.valueAt(this.col, this.row);
    let dImg = Math.max(-2, Math.min(2, brightnessToDegree(regionBright, this.total) - anchor));
    if (dImg === 0) dImg = regionBright >= 0.5 ? 1 : -1;
    const dRand = [-2, -1, 1, 2][randInt(this.rng, 4)];
    let delta = this.uni01() < this.bias ? dImg : dRand;
    delta = Math.max(-1, Math.min(1, delta));
    while (delta !== 0 && (lo + delta < 0 || hi + delta >= this.total)) delta += delta > 0 ? -1 : 1;
    for (const n of v){ n.degree += delta; n.noteNumber = this.noteOf(n.degree); }

    const liftRolled = this.rng() < OCTAVE_LIFT_PROBABILITY;
    let lifted = false;
    if (liftRolled && !this.octaveLiftedLast){
      const hi2 = Math.max(...v.map(n => n.degree));
      if (hi2 + this.per < this.total){
        for (const n of v){ n.degree += this.per; n.noteNumber = this.noteOf(n.degree); }
        lifted = true;
      }
    }
    this.octaveLiftedLast = lifted;

    if (this.opts.rhythm === "flowing"){
      const j = randInt(this.rng, v.length);
      v[j].lengthBeats = [0.5, 1.0, 2.0][randInt(this.rng, 3)];
    }
    return v;
  }

  drawOrnamentPlan(){
    const plan = { fired: false, dirDraw: 0, each: 0.5 };
    const amount = clampUnit(this.opts.arpeggioAmount);
    if (amount <= 0 || this.rng() >= amount) return plan;
    plan.fired = true;
    plan.dirDraw = randInt(this.rng, 2);
    plan.each = randInt(this.rng, 2) === 0 ? 0.5 : 1/3;   // eighths or a triplet
    return plan;
  }
  static ornamentSiteOf(brightness){
    let site = 0, haveBright = false, best = -1;
    brightness.forEach((b, i) => {
      if (b >= ARP_BRIGHTNESS && !haveBright){ site = i; haveBright = true; }
      if (!haveBright && b > best){ best = b; site = i; }
    });
    return site;
  }
  // Replace one note with a quick root/third/fifth figure, kept near the phrase.
  spliceOrnamentFigure(phrase, site, plan){
    const src = phrase[site];
    let lo = Infinity, hi = -Infinity;
    for (const n of phrase){ lo = Math.min(lo, n.degree); hi = Math.max(hi, n.degree); }
    const wLo = lo - 2, wHi = hi + 2;
    const ascOk = src.degree + 4 < this.total, descOk = src.degree - 4 >= 0;
    const ascFits = ascOk && src.degree + 4 <= wHi, descFits = descOk && src.degree - 4 >= wLo;
    let ascending;
    if (ascFits || descFits) ascending = ascFits && (!descFits || plan.dirDraw === 0);
    else ascending = (ascOk || descOk) ? (ascOk && (!descOk || plan.dirDraw === 0)) : plan.dirDraw === 0;
    const step = ascending ? 2 : -2;
    const figure = [0, 1, 2].map(k => {
      const d = this.clampDegree(Math.max(wLo, Math.min(wHi, src.degree + step * k)));
      return { ...src, degree: d, noteNumber: this.noteOf(d), lengthBeats: plan.each, templated: false };
    });
    phrase.splice(site, 1, ...figure);
  }

  // Phrase dynamics: an arch peaking ~2/3 through, tinted by smoothed brightness,
  // slew-limited so velocities swell rather than jump.
  applyPhraseDynamics(phrase, finalPhrase){
    const n = phrase.length;
    if (!n) return;
    const peak = Math.max(0.34, Math.min(0.85, PEAK_FRACTION + (this.rng()*2 - 1) * PEAK_JITTER));
    const endArc = finalPhrase ? 0 : PHRASE_END_ARC;
    const scale = finalPhrase ? FINAL_PHRASE_SCALE : 1;
    let smooth = phrase[0].brightness;
    const target = [];
    for (let i = 0; i < n; i++){
      const t = n > 1 ? i / (n - 1) : 0;
      const arc = t <= peak ? (peak > 0 ? t / peak : 1) : 1 - (1 - endArc) * ((t - peak) / (1 - peak));
      const contourVel = (CONTOUR_VEL_LOW + arc * (CONTOUR_VEL_HIGH - CONTOUR_VEL_LOW)) * scale;
      if (i > 0) smooth = BRIGHTNESS_INERTIA * smooth + (1 - BRIGHTNESS_INERTIA) * phrase[i].brightness;
      const v = Math.round(CONTOUR_WEIGHT * contourVel + BRIGHTNESS_WEIGHT * brightnessToVelocity(smooth));
      target.push(Math.max(DYN_MIN, Math.min(DYN_MAX, v)));
    }
    phrase[0].velocity = target[0];
    for (let i = 1; i < n; i++){
      const prev = phrase[i - 1].velocity;
      let v = Math.max(prev - MAX_DYN_STEP, Math.min(prev + MAX_DYN_STEP, target[i]));
      phrase[i].velocity = Math.max(DYN_MIN, Math.min(DYN_MAX, v));
    }
  }

  rollRest(){ return this.rng() < REST_PROBABILITY; }
  restLength(){ return randInt(this.rng, 2) === 0 ? 0.5 : 1.0; }
  setMotifAnchor(c, r){ this.motifAnchorCol = c; this.motifAnchorRow = r; }

  // B phrases end "open" - on the fifth (or the 2nd) - instead of resolving.
  openBPhraseCadence(phrase){
    if (!phrase.length) return;
    const last = phrase[phrase.length - 1];
    let best = -1, bestDist = Infinity, bestIsFifth = false;
    for (let d = 0; d < this.total; d++){
      const pc = this.pitchClassOf(d), isFifth = pc === 7;
      if (!isFifth && pc !== 2) continue;
      const dist = Math.abs(d - last.degree);
      if (dist < bestDist || (dist === bestDist && isFifth && !bestIsFifth)){ best = d; bestDist = dist; bestIsFifth = isFifth; }
    }
    if (best < 0 || best === last.degree) return;
    last.degree = best; last.noteNumber = this.noteOf(best);
  }
}

// The session groove tiled to real bar lines: how long a note starting at
// `startBeat` lasts before the next template slot boundary.
function barAlignedDuration(startBeat, tmpl){
  let period = 0;
  for (const s of tmpl) period += Math.round(s * TICKS);
  if (period <= 0) return 1;
  const pos = wrap(Math.round(startBeat * TICKS), period);
  let acc = 0;
  for (const s of tmpl){ acc += Math.round(s * TICKS); if (pos < acc) return (acc - pos) / TICKS; }
  return tmpl[tmpl.length - 1];
}
function densitySubdivisions(contrast, amount){
  if (amount <= 0) return 1;
  return 1 + Math.max(0, Math.min(3, Math.round(contrast * amount * 3)));
}
function densityFillDegree(start, end, s, subs, total){
  const cl = (d) => d < 0 ? 0 : (d >= total ? total - 1 : d);
  if (s === 0 || subs <= 1) return cl(start);
  const gap = end - start;
  if (Math.abs(gap) >= 2) return cl(start + Math.min(s, Math.abs(gap) - 1) * Math.sign(gap));
  const nb = start + 1 < total ? start + 1 : start - 1;
  return cl(s % 2 === 1 ? nb : start);
}

function generatePhrased(grid, scale, opts, chain, total, rng){
  const melody = { notes: [], degrees: [], cells: [], phraseStarts: [], progression: [] };
  const builder = new PhraseBuilder(grid, scale, opts, chain, total, rng);
  const motifLen = 3 + randInt(rng, 3);                   // 3..5
  const target = opts.length > 0 ? opts.length : grid.cols * grid.rows;
  const flowing = opts.rhythm === "flowing";
  const densityAmt = clampUnit(opts.imageRhythmAmount);
  const ticksPerBar = Math.round(TICKS * (opts.beatsPerBar > 0 ? opts.beatsPerBar : 4));
  const per = scale.intervals.length;
  const barSum = [], barCount = [];
  let tick = 0, cadenceFolded = false;

  // Fix the whole phrase's timing (onsets, lengths, density splits) before any pitch.
  const planTiming = (count, orn, site, closing, cadenceLen, templatedFlags, ownLens, contrasts) => {
    const slots = [], noteTicks = new Array(count).fill(0);
    let t = tick;
    for (let j = 0; j < count; j++){
      const isSite = orn.fired && j === site;
      const pieces = isSite ? 3 : 1;
      noteTicks[j] = t;
      for (let k = 0; k < pieces; k++){
        const s = { startTick: t, durTicks: 0, subs: 1, anticipation: false };
        const lastSlot = j + 1 === count && k + 1 === pieces;
        const templated = templatedFlags[j] && flowing;
        let dur;
        if (isSite) dur = orn.each;
        else if (closing && j + 1 === count) dur = cadenceLen;
        else if (templated){
          dur = barAlignedDuration(t / TICKS, builder.rhythmTemplate);
          if (dur < 0.5){                                     // sliver -> tied anticipation
            dur += barAlignedDuration(t / TICKS + dur, builder.rhythmTemplate);
            s.anticipation = true;
          }
        } else dur = ownLens[j];
        const settle = lastSlot && !closing;
        if (settle) dur = Math.max(dur, PHRASE_END_CADENCE_BEATS);
        s.durTicks = Math.round(dur * TICKS);
        if (!settle && !isSite && templated && !s.anticipation && densityAmt > 0){
          const n = densitySubdivisions(contrasts[j], densityAmt);
          if (n > 1 && s.durTicks % n === 0 && s.durTicks / n >= MIN_SUBDIVISION_TICKS) s.subs = n;
        }
        slots.push(s);
        t += s.durTicks;
      }
    }
    return { slots, noteTicks };
  };

  const emitPhrase = (slots, phrase) => {
    melody.phraseStarts.push(melody.notes.length);
    slots.forEach((s, e) => {
      const pn = phrase[e];
      const nextDeg = e + 1 < phrase.length ? phrase[e + 1].degree : pn.degree;
      const piece = Math.floor(s.durTicks / s.subs);
      for (let k = 0; k < s.subs; k++){
        const deg = densityFillDegree(pn.degree, nextDeg, k, s.subs, total);
        const note = { noteNumber: noteAt(scale, deg, opts.octaveSpan),
          velocity: applyEnergy(pn.velocity, opts.energy),
          startBeats: (s.startTick + k * piece) / TICKS, lengthBeats: piece / TICKS };
        melody.notes.push(note); melody.degrees.push(deg); melody.cells.push({ col: pn.col, row: pn.row });
        const bar = ticksPerBar > 0 ? Math.floor((s.startTick + k * piece) / ticksPerBar) : 0;
        while (barCount.length <= bar){ barCount.push(0); barSum.push(0); }
        barSum[bar] += note.noteNumber; barCount[bar]++;
      }
    });
    if (slots.length){ const l = slots[slots.length - 1]; tick = l.startTick + l.durTicks; }
  };

  // Fold a whole phrase by octaves toward the previous bar's register.
  const applyRegisterContinuity = (slots, phrase, isB) => {
    if (!phrase.length || !slots.length || ticksPerBar <= 0) return false;
    const firstBar = Math.floor(slots[0].startTick / ticksPerBar);
    let refBar = -1;
    for (let b = 0; b < barCount.length && b <= firstBar; b++) if (barCount[b] > 0) refBar = b;
    if (refBar < 0) return false;
    const ref = barSum[refBar] / barCount[refBar];
    const cur = phrase.reduce((a, n) => a + n.noteNumber, 0) / phrase.length;
    const diff = cur - ref;
    if (Math.abs(diff) <= (isB ? REGISTER_BAND_B : REGISTER_BAND_A)) return false;
    let k = Math.round(diff / 12);
    while (k !== 0){
      if (phrase.every(n => { const d = n.degree - k * per; return d >= 0 && d < total; })){
        for (const n of phrase){ n.degree -= k * per; n.noteNumber = noteAt(scale, n.degree, opts.octaveSpan); }
        return true;
      }
      k += k > 0 ? -1 : 1;
    }
    return false;
  };

  const maybeRest = () => {
    if (!builder.rollRest()) return;
    const rest = builder.restLength() * (1.3 - 0.6 * clampUnit(opts.energy));
    tick += Math.round(Math.round(rest * 2) / 2 * TICKS);
  };

  let motif = [];
  const processWalked = (newRegion, isB, closing, isMotif) => {
    const count = motifLen, walkCount = closing ? count - 1 : count;
    const cells = builder.planPhraseCells(walkCount, newRegion);
    const cadenceLen = closing ? builder.drawCadenceLength() : 0;
    let orn = { fired: false }, site = 0;
    if (!closing){
      orn = builder.drawOrnamentPlan();
      if (orn.fired) site = PhraseBuilder.ornamentSiteOf(cells.map(c => c.brightness));
    }
    const templatedFlags = new Array(count).fill(true);
    const ownLens = new Array(count).fill(1);
    const contrasts = new Array(count).fill(0);
    cells.forEach((c, j) => { contrasts[j] = localContrast(grid, c.col, c.row); });
    if (closing){ templatedFlags[count - 1] = false; ownLens[count - 1] = cadenceLen; }
    const plan = planTiming(count, orn, site, closing, cadenceLen, templatedFlags, ownLens, contrasts);
    const phrase = builder.walkDegreesAt(cells, plan.noteTicks.slice(0, walkCount));
    if (isMotif){
      motif = phrase.map(n => ({ ...n }));
      if (motif.length) builder.setMotifAnchor(motif[0].col, motif[0].row);
    }
    if (isB) builder.openBPhraseCadence(phrase);
    if (closing) builder.finishClosingPhrase(phrase, cadenceLen);
    if (orn.fired) builder.spliceOrnamentFigure(phrase, site, orn);
    if (applyRegisterContinuity(plan.slots, phrase, isB) && closing) cadenceFolded = true;
    builder.applyPhraseDynamics(phrase, closing);
    emitPhrase(plan.slots, phrase);
  };

  // A', A'': repeat the motif verbatim (Repetition) or vary it.
  const processCopied = () => {
    const phrase = rng() < opts.repetition ? motif.map(n => ({ ...n })) : builder.varyMotif(motif);
    const orn = builder.drawOrnamentPlan();
    const site = orn.fired ? PhraseBuilder.ornamentSiteOf(phrase.map(p => p.brightness)) : 0;
    const count = phrase.length;
    const plan = planTiming(count, orn, site, false, 0,
      phrase.map(p => p.templated), phrase.map(p => p.lengthBeats),
      phrase.map(p => localContrast(grid, p.col, p.row)));
    if (orn.fired) builder.spliceOrnamentFigure(phrase, site, orn);
    applyRegisterContinuity(plan.slots, phrase, false);
    builder.applyPhraseDynamics(phrase, false);
    emitPhrase(plan.slots, phrase);
  };

  // Form: A, then A' B A'' B ... until the length target, then a closing phrase.
  processWalked(false, false, false, true);
  let bodyNotes = motifLen, position = 1, phraseTotal = 1;
  while (phraseTotal < 3 || bodyNotes < target - motifLen){
    maybeRest();
    if (position % 2 === 1) processCopied();
    else processWalked(true, true, false, false);
    bodyNotes += motifLen; position++; phraseTotal++;
    if (position > 4096) break;
  }
  maybeRest();
  processWalked(false, false, true, false);

  // Per-bar register rescue on the emitted timeline (the final phrase folds as one group).
  if (ticksPerBar > 0 && melody.notes.length && melody.phraseStarts.length){
    const P = melody.phraseStarts.length;
    const phraseOf = (i) => { let p = 0; for (let q = 0; q < P; q++) if (melody.phraseStarts[q] <= i) p = q; return p; };
    const foldGroup = (idx, cur, ref, band) => {
      const diff = cur - ref;
      if (Math.abs(diff) <= band) return cur;
      let k = Math.round(diff / 12);
      while (k !== 0){
        if (idx.every(i => { const d = melody.degrees[i] - k * per; return d >= FOLD_EDGE_MARGIN && d < total - FOLD_EDGE_MARGIN; })){
          for (const i of idx){ melody.degrees[i] -= k * per; melody.notes[i].noteNumber = noteAt(scale, melody.degrees[i], opts.octaveSpan); }
          return cur - 12 * k;
        }
        k += k > 0 ? -1 : 1;
      }
      return cur;
    };
    const tailStart = melody.phraseStarts[P - 1];
    const byBar = [];
    for (let i = 0; i < tailStart; i++){
      const bar = Math.floor(Math.round(melody.notes[i].startBeats * TICKS) / ticksPerBar);
      while (byBar.length <= bar) byBar.push([]);
      byBar[bar].push(i);
    }
    let ref = -1;
    for (const idx of byBar){
      if (!idx.length) continue;
      let cur = 0, anyB = false;
      for (const i of idx){
        cur += melody.notes[i].noteNumber;
        const p = phraseOf(i);
        if (p % 2 === 0 && p !== 0 && p + 1 !== P) anyB = true;
      }
      cur /= idx.length;
      if (ref >= 0){
        const band = anyB ? REGISTER_BAND_B : REGISTER_BAND_A;
        cur = foldGroup(idx, cur, ref, band);
        if (Math.abs(cur - ref) > band){                  // fold stragglers individually
          const dir = cur > ref ? 1 : -1;
          let sum = 0;
          for (const i of idx){
            let deg = melody.degrees[i];
            while (dir * (noteAt(scale, deg, opts.octaveSpan) - ref) > band){
              const d = deg - dir * per;
              if (d < FOLD_EDGE_MARGIN || d >= total - FOLD_EDGE_MARGIN) break;
              deg = d;
            }
            if (deg !== melody.degrees[i]){ melody.degrees[i] = deg; melody.notes[i].noteNumber = noteAt(scale, deg, opts.octaveSpan); }
            sum += melody.notes[i].noteNumber;
          }
          cur = sum / idx.length;
        }
      }
      ref = cur;
    }
    if (tailStart < melody.notes.length && ref >= 0){
      const tail = [];
      let cur = 0;
      for (let i = tailStart; i < melody.notes.length; i++){ tail.push(i); cur += melody.notes[i].noteNumber; }
      cur /= tail.length;
      if (foldGroup(tail, cur, ref, REGISTER_BAND_A) !== cur) cadenceFolded = true;
    }
  }

  // A folded cadence re-chooses its approach note on the new geometry.
  if (cadenceFolded && melody.notes.length >= 2){
    const n = melody.notes.length - 1;
    const tonic = melody.degrees[n];
    const pcRel = (d) => scale.intervals[wrap(d, per)] % 12;
    const aboveOk = tonic + 1 < total, belowOk = tonic - 1 >= 0;
    if (wrap(melody.notes[n - 1].noteNumber, 12) !== wrap(melody.notes[n].noteNumber, 12) && (aboveOk || belowOk)){
      let step;
      if (belowOk && pcRel(tonic - 1) === 11) step = tonic - 1;
      else if (aboveOk && belowOk){
        const cur = melody.degrees[n - 1];
        step = Math.abs(tonic + 1 - cur) <= Math.abs(tonic - 1 - cur) ? tonic + 1 : tonic - 1;
      } else step = aboveOk ? tonic + 1 : tonic - 1;
      melody.degrees[n - 1] = step; melody.notes[n - 1].noteNumber = noteAt(scale, step, opts.octaveSpan);
    }
  }

  // Loop: trim the final cadence to the last bar line it crosses (keeps >= 2 beats).
  if (opts.loopBars > 0 && melody.notes.length && opts.beatsPerBar > 0){
    const last = melody.notes[melody.notes.length - 1];
    const end = last.startBeats + last.lengthBeats;
    const line = Math.floor(end / opts.beatsPerBar - 1e-9) * opts.beatsPerBar;
    if (line > last.startBeats + CADENCE_BEATS - 1e-9 && line < end - 1e-9) last.lengthBeats = line - last.startBeats;
  }

  melody.progression = builder.progression.slice();
  return melody;
}

// ===========================================================================
// Freeform - the flat theory-weighted walk (generateFreeform)
// ===========================================================================
function generateFreeform(grid, scale, opts, chain, total, rng){
  const melody = { notes: [], degrees: [], cells: [], phraseStarts: [], progression: [] };
  let degree = Math.floor(total / 2), col = Math.floor(grid.cols / 2), row = Math.floor(grid.rows / 2);
  const length = opts.length > 0 ? opts.length : grid.cols * grid.rows;
  let beat = 0;
  for (let i = 0; i < length; i++){
    if (opts.cellPath === "random"){ col = randInt(rng, grid.cols); row = randInt(rng, grid.rows); }
    else if (i > 0){ const k = randInt(rng, 8); col = wrap(col + DX[k], grid.cols); row = wrap(row + DY[k], grid.rows); }
    const b = grid.valueAt(col, row);
    degree = chain.nextBiased(degree, brightnessToDegree(b, total), opts.brightnessBias);
    const len = opts.rhythm === "flowing" ? flowingDuration(b, rng) : 1.0;
    melody.notes.push({ noteNumber: noteAt(scale, degree, opts.octaveSpan),
      velocity: applyEnergy(brightnessToVelocity(b), opts.energy), startBeats: beat, lengthBeats: len });
    melody.degrees.push(degree); melody.cells.push({ col, row });
    beat += len;
  }
  return melody;
}

// ===========================================================================
// Arpeggio and Chords - generateArpeggiated, generateChords
// ===========================================================================
const HARMONY_BASE_MIDI = 48; // C3

function generateArpeggiated(grid, scale, opts, rng){
  const melody = { notes: [], degrees: [], cells: [], chordTones: [], phraseStarts: [], progression: [] };
  const octaves = Math.max(1, opts.arpOctaves);
  const tonicPc = wrap(scale.rootNote, 12), major = scaleIsMajor(scale);
  const randomPattern = opts.arpPattern === "random";
  const chordSize = scaleIsBlues(scale) ? 4 : 3;           // blues: dominant 7ths
  const rate = opts.arpRate > 0 ? opts.arpRate : 0.5;
  const bpb = opts.beatsPerBar > 0 ? opts.beatsPerBar : 4;
  const perBar = Math.max(1, Math.round(bpb / rate));
  let length = opts.length > 0 ? opts.length : grid.cols * grid.rows, bars;
  if (opts.loopBars > 0){ bars = opts.loopBars; length = bars * perBar; }
  else bars = Math.max(1, Math.ceil(length / perBar));
  const base = pickOrDrawProgression(opts, rng);
  const roots = tile(base, bars);
  melody.progression = base;

  let col = Math.floor(grid.cols / 2), row = Math.floor(grid.rows / 2);
  let currentBar = -1, cycle = [], barChord = [], beat = 0;
  for (let i = 0; i < length; i++){
    if (opts.cellPath === "random"){ col = randInt(rng, grid.cols); row = randInt(rng, grid.rows); }
    else if (i > 0){ const k = randInt(rng, 8); col = wrap(col + DX[k], grid.cols); row = wrap(row + DY[k], grid.rows); }
    const b = grid.valueAt(col, row);
    const bar = Math.min(Math.floor(i / perBar), bars - 1);
    if (bar !== currentBar){
      currentBar = bar;
      const asc = [];
      for (let o = 0; o < octaves; o++) asc.push(...diatonicChord(scale, tonicPc, major, roots[bar], chordSize, HARMONY_BASE_MIDI + 12*o));
      asc.push(diatonicChord(scale, tonicPc, major, roots[bar], 1, HARMONY_BASE_MIDI + 12*octaves)[0]);
      cycle = orderChord(asc, opts.arpPattern);
      barChord = diatonicChord(scale, tonicPc, major, roots[bar], chordSize, HARMONY_BASE_MIDI);
    }
    const within = i % perBar;
    let note = randomPattern ? cycle[randInt(rng, cycle.length)] : cycle[within % cycle.length];
    if (b > 0.82 && note + 12 <= 127) note += 12;            // bright cells sparkle up an octave
    const onBeat = within % 2 === 0, downBeat = within === 0;
    let vel = brightnessToVelocity(b) + (downBeat ? 22 : (onBeat ? 12 : -6)) + Math.trunc(b * 10);
    vel = Math.max(1, Math.min(127, applyEnergy(vel, opts.energy)));
    const swing = 0.2, gate = 0.9;
    let start = beat, len = rate;
    if (!randomPattern){
      if (onBeat) len = rate * (1 + swing);
      else { start = beat + rate * swing; len = rate * (1 - swing); }
    }
    melody.notes.push({ noteNumber: note, velocity: vel, startBeats: start, lengthBeats: len * gate });
    melody.degrees.push(-1); melody.chordTones.push(chordToneRole(note, barChord)); melody.cells.push({ col, row });
    beat += rate;
  }
  return melody;
}

function generateChords(grid, scale, opts, rng){
  const melody = { notes: [], degrees: [], cells: [], chordTones: [], phraseStarts: [], progression: [] };
  const size = Math.max(2, opts.chordSize);
  const tonicPc = wrap(scale.rootNote, 12), major = scaleIsMajor(scale);
  const bpb = opts.beatsPerBar > 0 ? opts.beatsPerBar : 4;
  const perBar = clampUnit(opts.energy) > 0.55 ? 2 : 1;     // high energy: two chords a bar
  const rate = bpb / perBar;
  let chords = opts.length > 0 ? opts.length : grid.cols * grid.rows;
  if (opts.loopBars > 0) chords = opts.loopBars * perBar;
  chords = Math.max(1, chords);
  let col = Math.floor(grid.cols / 2), row = Math.floor(grid.rows / 2);
  const base = pickOrDrawProgression(opts, rng);
  const roots = tile(base, chords);
  melody.progression = base;

  // Pick the inversion whose top voice is nearest the previous chord's top.
  const voiceLead = (notes, prevTop) => {
    if (prevTop < 0 || notes.length < 2) return notes;
    let best = notes.slice(), cur = notes.slice(), bestDist = Infinity;
    for (let inv = 0; inv < notes.length; inv++){
      const dist = Math.abs(Math.max(...cur) - prevTop);
      if (dist < bestDist){ bestDist = dist; best = cur.slice(); }
      cur[cur.indexOf(Math.min(...cur))] += 12;
    }
    return best.sort((a, b) => a - b);
  };

  let prevTop = -1, beat = 0;
  for (let c = 0; c < chords; c++){
    if (opts.cellPath === "random"){ col = randInt(rng, grid.cols); row = randInt(rng, grid.rows); }
    else if (c > 0){ const k = randInt(rng, 8); col = wrap(col + DX[k], grid.cols); row = wrap(row + DY[k], grid.rows); }
    const b = grid.valueAt(col, row);
    const downBeat = c % perBar === 0;
    const velocity = applyEnergy(Math.round(72 + 30 * clampUnit(b)) + (downBeat ? 8 : 0), opts.energy);
    const pitches = diatonicChord(scale, tonicPc, major, roots[c], size, HARMONY_BASE_MIDI);
    const notes = voiceLead(pitches, prevTop);
    prevTop = Math.max(...notes);
    notes.forEach((n, v) => {
      melody.notes.push({ noteNumber: clampMidi(n), velocity: v + 1 === notes.length ? Math.min(127, velocity + 6) : velocity,
        startBeats: beat, lengthBeats: rate });
      melody.degrees.push(-1); melody.chordTones.push(chordToneRole(n, pitches)); melody.cells.push({ col, row });
    });
    beat += rate;
  }
  return melody;
}

// ===========================================================================
// Post-passes - enforceVariety, padToWholeBars
// ===========================================================================
function enforceVariety(melody, scale, opts, rng){
  const n = melody.notes.length;
  if (n < 6 || melody.degrees.length !== n) return;
  const wantVariety = clampUnit(opts.energy) > 0.4 || clampUnit(opts.arpeggioAmount) > 0.4;
  const usable = scale.intervals.length * opts.octaveSpan;
  if (usable < 4) return;
  const reNote = (i, d) => {
    d = Math.max(0, Math.min(usable - 1, d));
    melody.degrees[i] = d; melody.notes[i].noteNumber = noteAt(scale, d, opts.octaveSpan);
  };
  // 1) No pitch may dominate (> 60%) unless Repetition is near max.
  const counts = new Map();
  for (const nt of melody.notes) counts.set(nt.noteNumber, (counts.get(nt.noteNumber) || 0) + 1);
  let dom = melody.notes[0].noteNumber, domCount = 0;
  for (const [k, v] of counts) if (v > domCount){ domCount = v; dom = k; }
  if (clampUnit(opts.repetition) < 0.8 && domCount > 0.6 * n){
    let seen = 0;
    for (let i = 0; i < n; i++){
      if (melody.notes[i].noteNumber !== dom) continue;
      if ((seen++ % 2) === 1){
        const dir = randInt(rng, 2) ? 1 : -1;
        reNote(i, melody.degrees[i] + dir * (1 + randInt(rng, 2)));
      }
    }
  }
  // 2) At least 4 distinct pitches when activity is wanted.
  if (wantVariety){
    const distinct = () => new Set(melody.notes.map(x => x.noteNumber)).size;
    for (let g = 0; distinct() < 4 && g < 8; g++){
      const i = randInt(rng, n);
      reNote(i, melody.degrees[i] + (randInt(rng, 2) ? 2 : -2));
    }
  }
}

// Make the material exactly a whole number of bars (>= loopBars) for seamless looping.
function padToWholeBars(melody, bpb, loopBars){
  if (!melody.notes.length || bpb <= 0) return;
  let total = 0, lastOnset = 0, finalLen = 0;
  for (const n of melody.notes){
    total = Math.max(total, n.startBeats + n.lengthBeats);
    if (n.startBeats > lastOnset + 1e-9){ lastOnset = n.startBeats; finalLen = n.lengthBeats; }
    else if (n.startBeats > lastOnset - 1e-9) finalLen = Math.max(finalLen, n.lengthBeats);
  }
  let bars = Math.max(1, Math.floor(lastOnset / bpb + 1e-9) + 1, loopBars);
  if (bars * bpb - lastOnset < Math.min(finalLen, CADENCE_BEATS) - 1e-9) bars += 1;
  const target = bars * bpb;
  if (target > total + 1e-9){
    for (const n of melody.notes) if (n.startBeats + n.lengthBeats > total - 1e-9) n.lengthBeats += target - total;
  } else if (total > target + 1e-9){
    for (const n of melody.notes) if (n.startBeats + n.lengthBeats > target + 1e-9) n.lengthBeats = target - n.startBeats;
  }
  melody.loopBeats = target;
}

// ===========================================================================
// Entry point - generateMelody
// ===========================================================================
const DEFAULTS = {
  octaveSpan: 2, length: 0, rhythm: "flowing", cellPath: "walk", structure: "phrased",
  brightnessBias: 0.25, arpeggioAmount: 0.15, energy: 0.5, repetition: 0.2,
  mode: "melody", arpPattern: "updown", arpOctaves: 2, arpRate: 0.5,
  chordSize: 3, loopBars: 0, beatsPerBar: 4, imageRhythmAmount: 0, progression: [],
};

function generate(grid, scale, options, rng){
  const opts = { ...DEFAULTS, ...options };
  let melody;
  if (opts.mode === "arpeggio") melody = generateArpeggiated(grid, scale, opts, rng);
  else if (opts.mode === "chords") melody = generateChords(grid, scale, opts, rng);
  else {
    const per = scale.intervals.length, total = per * opts.octaveSpan;
    const chain = makeChain(theoryMatrix(total, per, THEORY), rng, THEORY);
    melody = opts.structure === "freeform"
      ? generateFreeform(grid, scale, opts, chain, total, rng)
      : generatePhrased(grid, scale, opts, chain, total, rng);
    enforceVariety(melody, scale, opts, rng);
  }
  if (opts.loopBars > 0) padToWholeBars(melody, opts.beatsPerBar, opts.loopBars);
  melody.mode = opts.mode;
  return melody;
}

// ===========================================================================
// Lock Rhythm / Pitch and Mutate - recombineLocked, mutate
// ===========================================================================
function nearestScaleNote(scale, midi, span){
  let best = midi, bestDist = Infinity;
  for (let d = 0; d < scale.intervals.length * span; d++){
    const n = noteAt(scale, d, span), dist = Math.abs(n - midi);
    if (dist < bestDist){ bestDist = dist; best = n; }
  }
  return best;
}

function cloneMelody(m){
  return { ...m, notes: m.notes.map(n => ({ ...n })), degrees: (m.degrees || []).slice(),
    cells: (m.cells || []).map(c => ({ ...c })), phraseStarts: (m.phraseStarts || []).slice(),
    progression: (m.progression || []).slice(), chordTones: (m.chordTones || []).slice() };
}

// Timing from one melody, pitch (and velocity/cells) from the other.
function recombineLocked(previous, candidate, locks){
  if (!locks.rhythm && !locks.pitch) return candidate;
  if (locks.rhythm && locks.pitch) return cloneMelody(previous);
  if (!previous || !previous.notes.length) return candidate;
  if (!candidate.notes.length) return cloneMelody(previous);
  const rSrc = locks.rhythm ? previous : candidate;
  const pSrc = locks.pitch ? previous : candidate;
  const n = rSrc.notes.length, pn = pSrc.notes.length;
  const pitchIdx = new Array(n);
  if (rSrc.phraseStarts.length && pSrc.phraseStarts.length){
    // Phrase-aware: phrase p takes phrase p's pitches in order; finals stay finals.
    const rS = rSrc.phraseStarts, pS = pSrc.phraseStarts;
    for (let p = 0; p < rS.length; p++){
      const rBeg = rS[p], rEnd = p + 1 < rS.length ? rS[p + 1] : n;
      const q = Math.min(p, pS.length - 1);
      const pBeg = pS[q], pEnd = q + 1 < pS.length ? pS[q + 1] : pn;
      const K = Math.max(0, pEnd - pBeg);
      for (let i = rBeg; i < rEnd && i < n; i++){
        let pi;
        if (i + 1 === rEnd && pEnd > 0) pi = pEnd - 1;
        else if (K > 0) pi = pBeg + Math.min(i - rBeg, K - 1);
        else pi = pn - 1;
        pitchIdx[i] = Math.min(pi, pn - 1);
      }
    }
  } else {
    for (let i = 0; i < n; i++) pitchIdx[i] = Math.min(i, pn - 1);
  }
  const out = { notes: [], degrees: [], cells: [], phraseStarts: rSrc.phraseStarts.slice(),
    progression: (locks.pitch ? previous : candidate).progression.slice(), mode: rSrc.mode, loopBeats: rSrc.loopBeats };
  for (let i = 0; i < n; i++){
    const pi = pitchIdx[i];
    out.notes.push({ startBeats: rSrc.notes[i].startBeats, lengthBeats: rSrc.notes[i].lengthBeats,
      noteNumber: pSrc.notes[pi].noteNumber, velocity: pSrc.notes[pi].velocity });
    out.degrees.push(pSrc.degrees[pi] ?? 0);
    out.cells.push(pSrc.cells[pi] ? { ...pSrc.cells[pi] } : { col: 0, row: 0 });
  }
  return out;
}

// Nudge ~amount of the notes: pitch by a scale step or two, length by ±½ beat.
function mutate(base, scale, locks, amount, rng, octaveSpan = 2){
  const out = cloneMelody(base);
  if (!out.notes.length || (locks.rhythm && locks.pitch)) return out;
  const amt = clampUnit(amount), span = Math.max(octaveSpan, 2);
  const n = out.notes.length;
  for (let i = 0; i < n; i++){
    if (rng() >= amt) continue;
    if (i + 1 === n) continue;                               // the final note keeps its landing
    if (!locks.pitch){
      const delta = (randInt(rng, 4) < 2 ? 1 : 2) * (rng() < 0.5 ? -1 : 1);
      out.notes[i].noteNumber = nearestScaleNote(scale, out.notes[i].noteNumber + delta * 2, span);
    }
    if (!locks.rhythm){
      const slot = out.notes[i + 1].startBeats - out.notes[i].startBeats;
      const delta = rng() < 0.5 ? -0.5 : 0.5;
      // Page-only guard: notes sharing an onset (chord voices) have no slot to change.
      if (slot <= 0) continue;
      let len = Math.round((out.notes[i].lengthBeats + delta) * 4) / 4;
      len = Math.max(Math.min(0.25, slot), Math.min(slot, len));
      out.notes[i].lengthBeats = len;
    }
  }
  return out;
}

// ===========================================================================
// Standard MIDI File (format 0) - MidiSequence + MidiFileWriter
// ===========================================================================
function vlq(value){
  const bytes = [value & 0x7f];
  value >>>= 7;
  while (value > 0){ bytes.unshift((value & 0x7f) | 0x80); value >>>= 7; }
  return bytes;
}

function notesToSmf(notes, tempoBpm, ppq = 480){
  const events = [];
  notes.forEach((n, order) => {
    if (n.lengthBeats <= 0) return;
    const on = Math.round(n.startBeats * ppq);
    let off = Math.round((n.startBeats + n.lengthBeats) * ppq);
    if (off <= on) off = on + 1;
    const pitch = clampMidi(n.noteNumber);
    events.push({ tick: on, type: 1, pitch, vel: Math.max(1, clampMidi(n.velocity)), order });
    events.push({ tick: off, type: 0, pitch, vel: 0, order });
  });
  // Note-offs before note-ons at the same tick; stable otherwise.
  events.sort((a, b) => a.tick - b.tick || a.type - b.type || a.order - b.order);
  const mpq = Math.round(60000000 / tempoBpm);
  const track = [0x00, 0xFF, 0x51, 0x03, (mpq >> 16) & 0xff, (mpq >> 8) & 0xff, mpq & 0xff];
  let last = 0;
  for (const e of events){
    track.push(...vlq(e.tick - last)); last = e.tick;
    track.push(e.type === 1 ? 0x90 : 0x80, e.pitch, e.type === 1 ? e.vel : 0);
  }
  track.push(0x00, 0xFF, 0x2F, 0x00);
  const len = track.length;
  return new Uint8Array([
    0x4D,0x54,0x68,0x64, 0,0,0,6, 0,0, 0,1, (ppq >> 8) & 0xff, ppq & 0xff,
    0x4D,0x54,0x72,0x6B, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...track,
  ]);
}

return {
  mulberry32, analyzeImage, detectKey, randomKey, SCALE_LIBRARY, noteAt,
  generate, recombineLocked, mutate, notesToSmf, progressionLabel, DEFAULTS,
};
})();

if (typeof module !== "undefined" && module.exports) module.exports = LumidiEngine;
