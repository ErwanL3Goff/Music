/* =========================================================
 * score.js — Partitions : rendu portée, sauvegarde localStorage,
 * lecture synchronisée avec surlignage.
 * ========================================================= */

const STORAGE_KEY = 'frequence-studio-scores';

class ScoreStore {
  constructor() { this.load(); }

  load() {
    try {
      this.scores = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch (e) { this.scores = []; }
  }

  persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.scores));
  }

  add(score) {
    score.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    score.createdAt = new Date().toISOString();
    this.scores.unshift(score);
    this.persist();
    return score;
  }

  remove(id) {
    this.scores = this.scores.filter(s => s.id !== id);
    this.persist();
  }

  get(id) { return this.scores.find(s => s.id === id); }
}

/** Position verticale d'une note sur la portée (clé de sol) */
function staffPosition(midi) {
  // Diatonique : index de lettre (0=Do … 6=Si) + octave
  const NAMES_DIATONIC = ['Do', 'Ré', 'Mi', 'Fa', 'Sol', 'La', 'Si'];
  const pc = midi % 12;
  const oct = Math.floor(midi / 12) - 1;
  const flatOf = { 1: 'Do', 3: 'Ré', 6: 'Fa', 8: 'Sol', 10: 'La' }; // dièse -> lettre précédente
  let letterIdx, diaOct = oct;
  if (flatOf[pc] !== undefined) {
    letterIdx = NAMES_DIATONIC.indexOf(flatOf[pc]); // position diatonique du dièse = même ligne que sa base
  } else {
    const name = NOTE_NAMES_FR[pc];
    letterIdx = NAMES_DIATONIC.indexOf(name);
  }
  // Position relative à Mi4 (ligne médiane). Mi4 : letterIdx=2, oct=4
  const steps = (diaOct - 4) * 7 + (letterIdx - 2);
  return { steps, isSharp: flatOf[pc] !== undefined };
}

/** Rendu HTML d'une partition dans un conteneur */
function renderStaff(container, notes, opts = {}) {
  container.innerHTML = '';
  const staff = document.createElement('div');
  staff.className = 'staff';
  const stepPx = 8;          // demi-écart de ligne
  const midY = 50;           // px : ligne médiane (Mi4)
  const startX = 44;         // après la clé
  const colW = Math.max(30, opts.colWidth || 42);

  const clef = document.createElement('span');
  clef.className = 'clef';
  clef.textContent = '𝄞';
  staff.appendChild(clef);

  // Les 5 lignes de la portée : Sol4 (steps +2, top 34px) à Si4 (steps -2, top 66px), écart 8px
  [34, 42, 50, 58, 66].forEach(top => {
    const line = document.createElement('div');
    line.className = 'staff-line';
    line.style.top = `${top}px`;
    staff.appendChild(line);
  });

  let x = startX;
  notes.forEach((n, i) => {
    if (n.rest) {
      const r = document.createElement('span');
      r.className = 'rest-glyph';
      r.style.left = `${x}px`;
      r.style.top = `${midY - 14}px`;
      r.textContent = '𝄽';
      r.dataset.index = i;
      staff.appendChild(r);
      x += colW * n.dur;
      return;
    }
    const { steps, isSharp } = staffPosition(n.midi);
    const y = midY - steps * stepPx;

    const glyph = document.createElement('div');
    glyph.className = 'note-glyph';
    if (n.dur >= 1) glyph.classList.add('hollow');
    if (n.dur <= 0.25) glyph.classList.add('beamed');
    glyph.style.left = `${x}px`;
    glyph.style.top = `${y - 6}px`;
    glyph.dataset.index = i;

    if (isSharp) {
      const acc = document.createElement('span');
      acc.className = 'accidental';
      acc.textContent = '♯';
      acc.style.left = `${x - 14}px`;
      acc.style.top = `${y - 12}px`;
      staff.appendChild(acc);
    }

    // lignes supplémentaires (notes au-delà de la portée : top < 34px ou > 66px)
    if (y < 30 || y > 70) {
      const from = y < 34 ? 34 : 66;
      const dir = y < 34 ? -1 : 1;
      for (let ly = from + dir * 8; dir === -1 ? ly >= y : ly <= y; ly += dir * 8) {
        const line = document.createElement('div');
        line.style.cssText = `position:absolute;left:${x - 6}px;top:${ly}px;width:30px;height:1px;background:rgba(255,255,255,.28)`;
        staff.appendChild(line);
      }
    }

    const label = document.createElement('span');
    label.className = 'note-label';
    label.textContent = n.name || midiToName(n.midi);
    label.style.left = `${x}px`;
    label.style.top = `${y + 12}px`;

    staff.appendChild(glyph);
    staff.appendChild(label);
    x += colW * n.dur;
  });

  staff.style.minWidth = `${x + 30}px`;
  container.appendChild(staff);
  return staff;
}

/** Lecteur de partition : planifie via engine.playNote et anime la portée */
class ScorePlayer {
  constructor() {
    this.timers = [];
    this.running = false;
  }

  play(score, staffEl, ui = {}) {
    this.stop();
    const bpm = score.bpm || ui.bpm || 100;
    const beat = 60 / bpm;
    engine.ensureContext();
    this.running = true;
    if (ui.onState) ui.onState(true);

    let t = 0;
    score.notes.forEach((n, i) => {
      const dur = n.dur * beat;
      const glyph = staffEl?.querySelector(`[data-index="${i}"]`);
      if (!n.rest) {
        const id = setTimeout(() => {
          engine.playNote(n.freq || midiToFreq(n.midi), dur * 0.92);
          if (glyph) glyph.classList.add('active');
          if (ui.onNote) ui.onNote(n, i);
          setTimeout(() => glyph && glyph.classList.remove('active'), dur * 1000);
        }, t * 1000);
        this.timers.push(id);
      }
      t += dur;
    });

    const totalMs = t * 1000;
    const startedAt = performance.now();
    const poll = setInterval(() => {
      const p = Math.min(1, (performance.now() - startedAt) / totalMs);
      if (ui.onProgress) ui.onProgress(p);
      if (p >= 1) { clearInterval(poll); this.stop(); if (ui.onEnd) ui.onEnd(); }
    }, 80);
    this.timers.push(poll);
  }

  stop() {
    this.timers.forEach(t => { clearTimeout(t); clearInterval(t); });
    this.timers = [];
    this.running = false;
  }
}
