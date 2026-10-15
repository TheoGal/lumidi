// Lumidi - page wiring. All music logic lives in engine.js (LumidiEngine).
(() => {
"use strict";
const E = LumidiEngine;
const $ = (id) => document.getElementById(id);

const statusLog = $("statusLog");
function log(msg){
  const d = document.createElement("div");
  d.textContent = msg;
  statusLog.appendChild(d);
  statusLog.scrollTop = statusLog.scrollHeight;
}
const randomSeed = () => (window.crypto && crypto.getRandomValues)
  ? crypto.getRandomValues(new Uint32Array(1))[0]
  : Math.floor(Math.random() * 4294967296);

// =========================================================================
// State
// =========================================================================
const state = {
  analysis: null,          // { grid, color }
  imageKey: null,          // key detected from the image
  scale: null,             // key the current result was generated in
  melody: null,            // current result (also the "previous" for locks)
  tempo: 120,
  audioCtx: null, playheadRAF: null,
  opts: {
    keyMode: "image", mode: "melody", structure: "phrased", rhythm: "flowing",
    cellPath: "walk", arpOctaves: "2", arpRate: "0.5", chordSize: "3", loopBars: "0",
  },
};

// =========================================================================
// Image loading
// =========================================================================
const dropzone = $("dropzone"), fileInput = $("fileInput"), previewCanvas = $("previewCanvas");
dropzone.addEventListener("click", () => fileInput.click());
["dragenter", "dragover"].forEach(evt => dropzone.addEventListener(evt, e => {
  e.preventDefault(); dropzone.classList.add("drag");
}));
["dragleave", "drop"].forEach(evt => dropzone.addEventListener(evt, e => {
  e.preventDefault(); dropzone.classList.remove("drag");
}));
dropzone.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) loadImageFile(f); });
fileInput.addEventListener("change", e => { if (e.target.files[0]) loadImageFile(e.target.files[0]); });

function loadImageFile(file){
  if (!file.type.startsWith("image/")){ log("That file doesn't look like an image."); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const boxW = dropzone.clientWidth, boxH = dropzone.clientHeight;
    const s = Math.min(boxW / img.width, boxH / img.height);
    previewCanvas.width = Math.round(img.width * s);
    previewCanvas.height = Math.round(img.height * s);
    previewCanvas.getContext("2d").drawImage(img, 0, 0, previewCanvas.width, previewCanvas.height);
    dropzone.classList.add("has-image");
    $("filename").textContent = file.name;

    // Analyse a capped-resolution copy (the grid is only 16×12 cells).
    const ascale = Math.min(1, 480 / Math.max(img.width, img.height));
    const ac = document.createElement("canvas");
    ac.width = Math.max(1, Math.round(img.width * ascale));
    ac.height = Math.max(1, Math.round(img.height * ascale));
    const actx = ac.getContext("2d", { willReadFrequently: true });
    actx.drawImage(img, 0, 0, ac.width, ac.height);
    state.analysis = E.analyzeImage(actx.getImageData(0, 0, ac.width, ac.height));
    state.imageKey = E.detectKey(state.analysis.color);
    $("generateBtn").disabled = false;
    $("rerollBtn").disabled = false;
    renderKeyInfo();
    log(`Loaded ${img.width}×${img.height} - key ${state.imageKey.keyName}`);
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function renderKeyInfo(){
  const info = $("keyInfo");
  info.textContent = "";
  if (!state.imageKey){ info.textContent = "Load an image to detect its key."; return; }
  const random = state.opts.keyMode === "random";
  const shown = random ? (state.scale && state.melody ? state.scale : null) : state.imageKey;
  const line1 = document.createElement("div");
  if (shown){
    line1.append(random ? "Random key: " : "Detected key: ");
    const k = document.createElement("span");
    k.className = "keyname"; k.textContent = shown.keyName;
    line1.append(k);
  } else line1.textContent = "Random key - picked from the seed on generate.";
  info.append(line1);

  const line2 = document.createElement("div");
  const c = state.imageKey;
  line2.textContent = `hue ${c.hue.toFixed(0)}°, saturation ${c.saturation.toFixed(2)}, luma ${c.value.toFixed(2)}`;
  if (state.melody && state.melody.progression.length){
    line2.append(" · ");
    const p = document.createElement("span");
    p.className = "prog";
    p.textContent = E.progressionLabel(state.melody.progression, state.scale, state.melody.mode);
    line2.append(p);
  }
  info.append(line2);
}

// =========================================================================
// Controls
// =========================================================================
document.querySelectorAll(".seg").forEach(seg => {
  const group = seg.dataset.group;
  seg.querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => {
    seg.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.opts[group] = btn.dataset.value;
    updateVisibility();
    if (group === "keyMode") renderKeyInfo();
  }));
});

const sliders = [
  ["tempoRange", "tempoValue", v => `${v} BPM`],
  ["lengthRange", "lengthValue", v => v == 0 ? "auto" : v],
  ["energyRange", "energyValue", v => (v / 100).toFixed(2)],
  ["influenceRange", "influenceValue", v => (v / 100).toFixed(2)],
  ["complexityRange", "complexityValue", v => (v / 100).toFixed(2)],
  ["repetitionRange", "repetitionValue", v => (v / 100).toFixed(2)],
  ["densityRange", "densityValue", v => v == 0 ? "off" : (v / 100).toFixed(2)],
  ["mutateRange", "mutateValue", v => (v / 100).toFixed(2)],
];
for (const [range, out, fmt] of sliders){
  $(range).addEventListener("input", e => { $(out).textContent = fmt(e.target.value); });
}
$("tempoRange").addEventListener("input", e => { state.tempo = +e.target.value; });

// Show only the controls the current mode/structure/rhythm uses.
function updateVisibility(){
  const { mode, structure, rhythm, loopBars } = state.opts;
  document.querySelectorAll(".control-row[data-modes]").forEach(row => {
    let show = row.dataset.modes.split(" ").includes(mode);
    if (show && row.dataset.structure) show = row.dataset.structure === structure;
    if (show && row.dataset.rhythm) show = row.dataset.rhythm === rhythm;
    row.hidden = !show;
  });
  // A loop fills exactly its bars in every mode, so Length has no effect then.
  $("lengthRow").hidden = loopBars !== "0";
  $("lengthLabel").textContent = mode === "chords" ? "Length (chords)" : "Length (notes)";
  $("loopValue").textContent = loopBars === "0" ? "one-shot" : `${loopBars} bar${loopBars === "1" ? "" : "s"}`;
  $("generateBtn").textContent = { melody: "Generate melody", chords: "Generate chords", arpeggio: "Generate arpeggio" }[mode];
}
updateVisibility();

$("randomizeSeedBtn").addEventListener("click", () => { $("seedInput").value = randomSeed(); });

function readSeed(){
  const t = $("seedInput").value.trim();
  return (t === "" ? 20260707 : Math.abs(parseInt(t, 10) || 0)) >>> 0;
}

function readOptions(){
  const o = state.opts;
  return {
    mode: o.mode, structure: o.structure, rhythm: o.rhythm, cellPath: o.cellPath,
    length: +$("lengthRange").value,
    brightnessBias: +$("influenceRange").value / 100,
    arpeggioAmount: +$("complexityRange").value / 100,
    energy: +$("energyRange").value / 100,
    repetition: +$("repetitionRange").value / 100,
    imageRhythmAmount: +$("densityRange").value / 100,
    arpPattern: $("arpPattern").value,
    arpOctaves: +o.arpOctaves, arpRate: +o.arpRate,
    chordSize: +o.chordSize, loopBars: +o.loopBars, beatsPerBar: 4,
  };
}
const readLocks = () => ({
  rhythm: $("lockRhythm").checked, pitch: $("lockPitch").checked, harmony: $("lockHarmony").checked,
});

// =========================================================================
// Generate / re-roll / mutate
// =========================================================================
function generate(){
  if (!state.analysis) return;
  const seed = readSeed();
  const rng = E.mulberry32(seed);
  const opts = readOptions();
  const locks = readLocks();
  const prev = state.melody;

  // Random key draws first from the seed, so a seed reproduces its key too.
  const scale = state.opts.keyMode === "random" ? E.randomKey(rng) : state.imageKey;
  if (locks.harmony && prev && prev.progression.length) opts.progression = prev.progression;

  let melody = E.generate(state.analysis.grid, scale, opts, rng);
  const kept = [];
  if (prev && (locks.rhythm || locks.pitch)){
    melody = E.recombineLocked(prev, melody, locks);
    if (locks.rhythm) kept.push("rhythm");
    if (locks.pitch) kept.push("pitch");
  }
  if (locks.harmony && opts.progression) kept.push("harmony");
  // A pitch lock keeps the old notes, so the result is still in the old key.
  state.scale = locks.pitch && prev ? state.scale : scale;
  setResult(melody);
  log(`Generated ${melody.notes.length} notes (${opts.mode}, seed ${seed}${kept.length ? `, kept ${kept.join(" + ")}` : ""}).`);
}

function setResult(melody){
  state.melody = melody;
  stopPlayback();
  drawRoll(null);
  renderKeyInfo();
  $("playBtn").disabled = false;
  $("downloadBtn").disabled = false;
  $("mutateBtn").disabled = false;
}

$("generateBtn").addEventListener("click", generate);
$("rerollBtn").addEventListener("click", () => { $("seedInput").value = randomSeed(); generate(); });
$("mutateBtn").addEventListener("click", () => {
  if (!state.melody) return;
  const locks = readLocks();
  if (locks.rhythm && locks.pitch){ log("Rhythm and pitch are both locked - nothing to mutate."); return; }
  const amount = +$("mutateRange").value / 100;
  setResult(E.mutate(state.melody, state.scale, locks, amount, E.mulberry32(randomSeed())));
  log(`Mutated ~${Math.round(amount * 100)}% of the notes.`);
});

// =========================================================================
// Piano-roll view
// =========================================================================
function loopLength(m){
  const end = Math.max(...m.notes.map(n => n.startBeats + n.lengthBeats));
  return m.loopBeats || end;
}

function drawRoll(playheadBeats){
  const canvas = $("rollCanvas");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const m = state.melody;
  if (!m || !m.notes.length) return;

  let lo = 127, hi = 0;
  for (const n of m.notes){ lo = Math.min(lo, n.noteNumber); hi = Math.max(hi, n.noteNumber); }
  if (hi === lo) hi = lo + 1;
  const total = loopLength(m), pad = 8;
  const x = b => pad + (b / total) * (w - 2 * pad);
  const y = p => h - pad - ((p - lo) / (hi - lo)) * (h - 2 * pad);

  // Bar lines.
  ctx.strokeStyle = "rgba(101,93,128,.25)"; ctx.lineWidth = 1;
  const barStep = total > 160 ? 16 : 4;
  for (let b = 0; b <= total; b += barStep){
    ctx.beginPath(); ctx.moveTo(Math.round(x(b)) + .5, 4); ctx.lineTo(Math.round(x(b)) + .5, h - 4); ctx.stroke();
  }
  // Notes, brighter when louder.
  ctx.lineCap = "round";
  ctx.lineWidth = total > 200 ? 2 : 3;
  for (const n of m.notes){
    ctx.strokeStyle = `rgba(232,115,92,${0.45 + 0.55 * (n.velocity / 127)})`;
    const py = y(n.noteNumber);
    ctx.beginPath(); ctx.moveTo(x(n.startBeats), py);
    ctx.lineTo(Math.max(x(n.startBeats) + 1, x(n.startBeats + n.lengthBeats) - 1), py); ctx.stroke();
  }
  if (playheadBeats != null){
    ctx.strokeStyle = "#d7a24e"; ctx.lineWidth = 1.5; ctx.lineCap = "butt";
    const px = x(playheadBeats);
    ctx.beginPath(); ctx.moveTo(px, 4); ctx.lineTo(px, h - 4); ctx.stroke();
  }
}
window.addEventListener("resize", () => drawRoll(null));

// =========================================================================
// Preview playback (sine synth). Loops seamlessly when Loop is on.
// =========================================================================
function stopPlayback(){
  if (state.audioCtx){ state.audioCtx.close(); state.audioCtx = null; }
  if (state.playheadRAF){ cancelAnimationFrame(state.playheadRAF); state.playheadRAF = null; }
  $("playBtn").disabled = !state.melody;
  $("stopBtn").disabled = true;
  if (state.melody) drawRoll(null);
}

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

function schedulePass(ctx, master, notes, passStart, secPerBeat){
  for (const n of notes){
    const start = passStart + n.startBeats * secPerBeat;
    const dur = Math.max(0.05, n.lengthBeats * 0.92 * secPerBeat);   // small gap between notes
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = midiToFreq(n.noteNumber);
    const gain = ctx.createGain();
    const peak = 0.10 + (n.velocity / 127) * 0.30;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.012);
    gain.gain.setValueAtTime(peak, Math.max(start + 0.012, start + dur - 0.04));
    gain.gain.linearRampToValueAtTime(0, start + dur);
    osc.connect(gain); gain.connect(master);
    osc.start(start); osc.stop(start + dur + 0.02);
  }
}

$("playBtn").addEventListener("click", () => {
  const m = state.melody;
  if (!m || !m.notes.length) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  state.audioCtx = ctx;
  const secPerBeat = 60 / state.tempo;
  const master = ctx.createGain();
  // Chords stack 3-4 voices: keep the mix out of clipping.
  master.gain.value = m.mode === "chords" ? 0.16 : 0.28;
  master.connect(ctx.destination);

  const looping = !!m.loopBeats;
  const passBeats = loopLength(m);
  const passSec = passBeats * secPerBeat;
  let passStart = ctx.currentTime + 0.05;
  let nextPass = passStart;
  const scheduleAhead = () => {
    // Keep one pass queued ahead of the playhead.
    while (nextPass < ctx.currentTime + passSec + 0.5){
      schedulePass(ctx, master, m.notes, nextPass, secPerBeat);
      nextPass += passSec;
      if (!looping) break;
    }
  };
  scheduleAhead();

  $("playBtn").disabled = true;
  $("stopBtn").disabled = false;
  function tick(){
    const elapsed = (ctx.currentTime - passStart) / secPerBeat;
    if (!looping && elapsed >= passBeats + 0.1){ stopPlayback(); return; }
    if (looping) scheduleAhead();
    drawRoll(Math.max(0, looping ? elapsed % passBeats : elapsed));
    state.playheadRAF = requestAnimationFrame(tick);
  }
  tick();
  log(looping ? "Looping preview - press Stop to end." : "Playing preview.");
});
$("stopBtn").addEventListener("click", stopPlayback);

// =========================================================================
// MIDI download
// =========================================================================
$("downloadBtn").addEventListener("click", () => {
  const m = state.melody;
  if (!m || !m.notes.length) return;
  const blob = new Blob([E.notesToSmf(m.notes, state.tempo, 480)], { type: "audio/midi" });
  const url = URL.createObjectURL(blob);
  const name = `lumidi_${m.mode}_${$("seedInput").value.trim() || "20260707"}.mid`;
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  log(`Downloaded ${name}`);
});
})();
