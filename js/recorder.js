/* =========================================================
 * recorder.js — Enregistrement horodaté des notes + rouleau de piano
 * ========================================================= */

class NoteRecorder {
  constructor() {
    this.recording = false;
    this.take = [];          // { midi, name, freq, start, end }
    this.pending = new Map(); // midi -> startTime (performance.now()/1000)
    this.startTime = 0;
    this.timerId = null;
    this.playbackTimers = [];
  }

  now() { return performance.now() / 1000; }

  onNoteOn(midi, freq) {
    if (!this.recording) return;
    if (this.pending.has(midi)) return;
    this.pending.set(midi, this.now() - this.startTime);
  }

  onNoteOff(midi) {
    if (!this.recording) return;
    const start = this.pending.get(midi);
    if (start === undefined) return;
    this.pending.delete(midi);
    const end = this.now() - this.startTime;
    const ev = {
      midi,
      name: midiToName(midi),
      freq: Math.round(midiToFreq(midi) * 10) / 10,
      start,
      end: Math.max(end, start + 0.05),
    };
    this.take.push(ev);
    UI.updateTake(this);
  }

  start() {
    if (this.recording) return;
    engine.ensureContext();
    this.recording = true;
    this.startTime = this.now();
    UI.setRecUI(true);
    this.timerId = setInterval(() => UI.tickRecTime(this.elapsed()), 100);
  }

  stop() {
    if (!this.recording) return;
    // Clôture les notes encore tenues
    for (const [midi, start] of this.pending) {
      const end = this.now() - this.startTime;
      this.take.push({
        midi, name: midiToName(midi),
        freq: Math.round(midiToFreq(midi) * 10) / 10,
        start, end: Math.max(end, start + 0.05),
      });
    }
    this.pending.clear();
    this.recording = false;
    clearInterval(this.timerId);
    UI.setRecUI(false);
    UI.updateTake(this);
  }

  clear() {
    this.stopPlayback();
    this.take = [];
    this.pending.clear();
    UI.updateTake(this);
    UI.tickRecTime(0);
  }

  elapsed() {
    return this.recording ? this.now() - this.startTime : (this.take.length ? this.take[this.take.length - 1].end : 0);
  }

  totalDuration() {
    return this.take.length ? this.take[this.take.length - 1].end : 0;
  }

  /** Réécoute : rejoue la prise avec le son courant */
  startPlayback(onProgress) {
    this.stopPlayback();
    if (!this.take.length) return;
    engine.ensureContext();
    const t0 = this.now();
    this.take.forEach(ev => {
      const id = setTimeout(() => {
        engine.playNote(ev.freq, ev.end - ev.start);
        UI.flashKey(ev.midi);
      }, (ev.start - 0) * 1000);
      this.playbackTimers.push(id);
    });
    const dur = this.totalDuration();
    const poll = setInterval(() => {
      const e = this.now() - t0;
      if (onProgress) onProgress(Math.min(1, e / dur));
      if (e > dur + 0.2) clearInterval(poll);
    }, 60);
    this.playbackTimers.push(poll);
    this.playbackTimers.push(setTimeout(() => { if (onProgress) onProgress(0); }, dur * 1000 + 250));
  }

  stopPlayback() {
    this.playbackTimers.forEach(t => { clearTimeout(t); clearInterval(t); });
    this.playbackTimers = [];
  }

  /** Convertit la prise en partition quantifiée (grille de noires au tempo choisi) */
  toScore(bpm = 100) {
    const beat = 60 / bpm; // durée d'une noire en s
    const events = [...this.take].sort((a, b) => a.start - b.start);
    const notes = [];
    let cursor = 0; // position en temps (beats)

    for (const ev of events) {
      const pos = ev.start / beat;
      const len = Math.max(0.25, Math.round(((ev.end - ev.start) / beat) * 4) / 4);
      // Silence si écart
      if (pos > cursor + 0.1) {
        const restLen = Math.min(2, Math.max(0.25, Math.round((pos - cursor) * 4) / 4));
        notes.push({ rest: true, dur: restLen });
        cursor += restLen;
      }
      notes.push({ midi: ev.midi, name: ev.name, freq: ev.freq, dur: len });
      cursor = Math.max(cursor, Math.round(pos * 4) / 4) + len;
    }
    return { notes, bpm };
  }
}

/** Dessin du rouleau de piano (canvas) */
function drawPianoRoll(canvas, take) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (!take.length) {
    ctx.fillStyle = 'rgba(148,163,184,.5)';
    ctx.font = '13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Aucune note enregistrée pour le moment…', W / 2, H / 2);
    return;
  }

  const minMidi = Math.min(...take.map(e => e.midi));
  const maxMidi = Math.max(...take.map(e => e.midi));
  const span = Math.max(12, maxMidi - minMidi + 1);
  const dur = Math.max(1, ...take.map(e => e.end));

  // grille horizontale (temps)
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  for (let s = 0; s <= dur; s++) {
    const x = (s / dur) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  const rowH = H / span;
  take.forEach(ev => {
    const x = (ev.start / dur) * W;
    const w = Math.max(4, ((ev.end - ev.start) / dur) * W);
    const y = H - (ev.midi - minMidi + 1) * rowH;
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, '#7c5cff');
    grad.addColorStop(1, '#2dd4bf');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x + 1, y + 1, w - 2, rowH - 2, 4) : ctx.rect(x + 1, y + 1, w - 2, rowH - 2);
    ctx.fill();
    if (w > 26) {
      ctx.fillStyle = 'rgba(10,12,25,.9)';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(ev.name, x + 5, y + rowH / 2 + 3);
    }
  });

  // échelle temps
  ctx.fillStyle = 'rgba(148,163,184,.7)';
  ctx.font = '10px monospace';
  for (let s = 0; s <= dur; s++) {
    ctx.fillText(`${s}s`, (s / dur) * W + 2, 12);
  }
}
