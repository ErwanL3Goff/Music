/* =========================================================
 * keyboard.js — Clavier à l'écran + touches physiques
 * Mapping AZERTY/QWERTY, génération des touches,
 * callbacks pour l'enregistreur.
 * ========================================================= */

// Layout "DAW" étendu sur ~2 octaves (25 touches) :
// - Rangée du bas : A Z E R T Y U I O P = do ré mi fa sol la si do ré mi
// - Dièses        : S D _ G H J L ; M , = do# ré# _ fa# sol# la# do# ré# mi#…
// - Alias QWERTY  : W X C V B N = ré mi fa sol la si (rangée haute décalée)
// `rel` = demi-tons depuis le Do de l'octave de base, `afterWhite` = index
// de la touche blanche précédent immédiatement la touche noire.
const KEY_MAP = {
  white: [
    { rel: 0,  key: 'a', alt: 'q' },  // Do
    { rel: 2,  key: 'z', alt: 'w' },  // Ré
    { rel: 4,  key: 'e', alt: 'x' },  // Mi
    { rel: 5,  key: 'r', alt: 'c' },  // Fa
    { rel: 7,  key: 't', alt: 'v' },  // Sol
    { rel: 9,  key: 'y', alt: 'b' },  // La
    { rel: 11, key: 'u', alt: 'n' },  // Si
    { rel: 12, key: 'i', alt: ',' },  // Do+1 (octave supérieure)
    { rel: 14, key: 'o', alt: ';' },  // Ré+1
    { rel: 16, key: 'p', alt: ':' },  // Mi+1
  ],
  black: [
    { rel: 1,  key: 's', afterWhite: 0 },  // Do#
    { rel: 3,  key: 'd', afterWhite: 1 },  // Ré#
    { rel: 6,  key: 'g', afterWhite: 3 },  // Fa#
    { rel: 8,  key: 'h', afterWhite: 4 },  // Sol#
    { rel: 10, key: 'j', afterWhite: 5 },  // La#
    { rel: 13, key: 'l', afterWhite: 7 },  // Do#+1
    { rel: 15, key: 'm', afterWhite: 8 },  // Ré#+1
  ],
};
// Demi-demi-tons correspondant aux touches noires d'une octave (à l'intérieur de KEY_MAP)
const BLACK_SET = new Set([1, 3, 6, 8, 10]);

// Indications de raccouris affichées sur le piano 88 touches (construites depuis KEY_MAP)
const KEY_HINTS = (() => {
  const h = new Map();
  const base = (4 + 1) * 12; // fenêtre par défaut : octave 4
  KEY_MAP.white.forEach(w => h.set(base + w.rel, w.key.toUpperCase()));
  KEY_MAP.black.forEach(b => h.set(base + b.rel, b.key.toUpperCase()));
  return h;
})();


class PianoUI {
  /**
   * @param {HTMLElement} container — où dessiner le piano
   * @param {object} opts — { onNoteOn(midi,freq), onNoteOff(midi), octave }
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.octave = opts.octave ?? 4;
    this.keysEl = new Map(); // midi -> element
    this.pressed = new Set(); // midi currently pressed
    this.build();
  }

  midiOfRel(rel) {
    return (this.octave + 1) * 12 + rel; // octave 4 => Do4 = MIDI 60
  }

  build() {
    if (this.container && this.container.id === 'keyboard-full') return this.buildFull();
    this.container.innerHTML = '';
    this.keysEl.clear();

    const whites = KEY_MAP.white;
    const W = 100 / whites.length; // % largeur par touche blanche

    whites.forEach((w, i) => {
      const midi = this.midiOfRel(w.rel);
      const el = document.createElement('div');
      el.className = 'key key-white';
      el.style.left = `${i * W}%`;
      el.style.width = `calc(${W}% - 2px)`;
      el.style.height = '100%';
      el.dataset.midi = midi;
      el.innerHTML = `<span class="key-name">${midiToName(midi)}</span><span class="key-hint">${w.key.toUpperCase()}</span>`;
      this.bindPointer(el, midi);
      this.container.appendChild(el);
      this.keysEl.set(midi, el);
    });

    KEY_MAP.black.forEach(b => {
      const midi = this.midiOfRel(b.rel);
      if (this.keysEl.has(midi)) return; // évite tout doublon de touche
      const el = document.createElement('div');
      el.className = 'key key-black';
      const left = (b.afterWhite + 1) * W; // centrée sur la jointure
      el.style.left = `calc(${left}% - ${W * 0.3}%)`;
      el.style.width = `${W * 0.6}%`;
      el.style.height = '62%';
      el.dataset.midi = midi;
      el.innerHTML = `<span class="key-name" style="color:#cbd5e1;top:auto;bottom:8px;font-size:9px;">${midiToName(midi)}</span><span class="key-hint" style="color:#94a3b8">${b.key.toUpperCase()}</span>`;
      this.bindPointer(el, midi);
      this.container.appendChild(el);
      this.keysEl.set(midi, el);
    });
  }

  /** Piano complet type piano de concert : 88 touches MIDI 21 (La0) → 108 (Do8),
   *  comme sur un clavier maître — toutes les touches sont jouables à la souris. */
  buildFull() {
    this.container.innerHTML = '';
    this.keysEl.clear();
    const LOW = 21, HIGH = 108;               // La0 -> Do8 : standard 88 touches
    const whiteMidis = [];
    for (let m = LOW; m <= HIGH; m++) if (!BLACK_SET.has(m % 12)) whiteMidis.push(m);
    const W = 100 / whiteMidis.length;
    whiteMidis.forEach((midi, i) => {
      const el = document.createElement('div');
      el.className = 'key key-white';
      el.style.left = `${i * W}%`;
      el.style.width = `calc(${W}% - 1px)`;
      el.style.height = '100%';
      el.dataset.midi = midi;
      const hint = KEY_HINTS.get(midi);
      el.innerHTML = `<span class="key-name">${midiToName(midi)}</span>` +
        (hint ? `<span class="key-hint">${hint}</span>` : '');
      this.bindPointer(el, midi);
      this.container.appendChild(el);
      this.keysEl.set(midi, el);
    });
    for (let midi = LOW; midi <= HIGH; midi++) {
      if (!BLACK_SET.has(midi % 12)) continue;
      const after = whiteMidis.indexOf(midi - 1); // touche blanche précédente
      const el = document.createElement('div');
      el.className = 'key key-black';
      el.style.left = `calc(${(after + 1) * W}% - ${W * 0.3}%)`;
      el.style.width = `${W * 0.6}%`;
      el.style.height = '62%';
      el.dataset.midi = midi;
      const hint = KEY_HINTS.get(midi);
      el.innerHTML = `<span class="key-name" style="color:#cbd5e1;top:auto;bottom:6px;font-size:8px;">${midiToName(midi)}</span>` +
        (hint ? `<span class="key-hint" style="color:#94a3b8">${hint}</span>` : '');
      this.bindPointer(el, midi);
      this.container.appendChild(el);
      this.keysEl.set(midi, el);
    }
  }

  setOctave(oct) {
    // Libère les notes en cours avant de reconstruire le piano
    for (const p of [...this.pressed]) {
      const midi = +p.split(':')[1];
      engine.noteOff(`m${midi}`, true);
    }
    this.pressed.clear();
    this.octave = oct;
    this.build();
  }

  bindPointer(el, midi) {
    const down = (e) => {
      e.preventDefault();
      this.triggerOn(midi, 'pointer');
    };
    const up = () => this.triggerOff(midi);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', () => { if (this.pressed.has(`pointer:${midi}`)) this.triggerOff(midi); });
  }

  /** @param {object|null} opts — { vibrato: bool } pour la manette */
  triggerOn(midi, source = 'key', o = null) {
    const tag = `${source}:${midi}`;
    if (this.pressed.has(tag)) return;
    this.pressed.add(tag);
    const freq = midiToFreq(midi);
    const el = this.keysEl.get(midi);
    if (el) el.classList.add('down');
    // Une seule voix sonore : pianoMain possède les callbacks (enregistreur),
    // les autres pianos servent uniquement à l'allumage visuel des touches.
    const isPrimary = this.opts.onNoteOn != null;
    if (isPrimary) engine.noteOn(`m${midi}`, freq);
    if (o && o.vibrato && isPrimary) engine.setVibrato(`m${midi}`, true);
    if (isPrimary && this.opts.onNoteOn) this.opts.onNoteOn(midi, freq);
  }

  /** Remplace une voix tenue par une autre hauteur sans ré-attaque
   *  (glissando / bending / soufflé de la manette Xbox).
   *  Retourne true si la bascule a pu être faite sans ré-enclencher l'enveloppe. */
  retune(oldMidi, newMidi) {
    if (oldMidi == null || oldMidi === newMidi) return false;
    const freq = midiToFreq(newMidi);
    let done = false;
    for (const tag of [...this.pressed]) {
      if (!tag.endsWith(`:${oldMidi}`)) continue;
      this.pressed.delete(tag);
      this.pressed.add(`${tag.slice(0, tag.lastIndexOf(':'))}:${newMidi}`);
      done = true;
    }
    if (!done) return false; // plus aucune source sur oldMidi : rien à glisser
    const elOld = this.keysEl.get(oldMidi);
    const elNew = this.keysEl.get(newMidi);
    if (elOld && ![...this.pressed].some(p => p.endsWith(`:${oldMidi}`))) elOld.classList.remove('down');
    if (elNew) elNew.classList.add('down');
    if (this.opts.onNoteOn != null) engine.noteRetune(`m${oldMidi}`, `m${newMidi}`, freq);
    return true;
  }

  triggerOff(midi) {
    // Retire uniquement les tags correspondant exactement à ce midi
    let removed = false;
    for (const p of [...this.pressed]) {
      if (p.endsWith(`:${midi}`)) { this.pressed.delete(p); removed = true; }
    }
    if (!removed) return;
    const stillDown = [...this.pressed].some(p => p.endsWith(`:${midi}`));
    if (stillDown) return;
    const el = this.keysEl.get(midi);
    if (el) el.classList.remove('down');
    if (this.opts.onNoteOn != null) { // voix sonore = piano principal
      engine.setVibrato(`m${midi}`, false);
      engine.noteOff(`m${midi}`);
    }
    if (this.opts.onNoteOff) this.opts.onNoteOff(midi);
  }

  highlightExternal(midi, on) {
    const el = this.keysEl.get(midi);
    if (el) el.classList.toggle('down', on);
  }
}

/** Gestion du clavier physique global */
class PhysicalKeyboard {
  constructor(pianos) {
    this.pianos = pianos; // [PianoUI,...] — tous sont synchronisés visuellement
    this.map = this.buildMap();
    this.held = new Map(); // keyCode -> midi

    window.addEventListener('keydown', (e) => this.onDown(e));
    window.addEventListener('keyup', (e) => this.onUp(e));
    window.addEventListener('blur', () => this.releaseAll());
  }

  buildMap() {
    const m = new Map();
    const add = (code, rel) => m.set(code, rel);
    // Blanches — rangée du bas : A Z E R T Y U I O P (2 octaves + tierce mineure sup.)
    add('KeyA', 0);  add('KeyZ', 2);  add('KeyE', 4);  add('KeyR', 5);
    add('KeyT', 7);  add('KeyY', 9);  add('KeyU', 11); add('KeyI', 12);
    add('KeyO', 14); add('KeyP', 16);
    // Dièses — S D G H J + L ; M , (octave supérieure)
    add('KeyS', 1);  add('KeyD', 3);  add('KeyG', 6);  add('KeyH', 8);
    add('KeyJ', 10); add('KeyL', 13); add('Semicolon', 14); add('KeyM', 15);
    add('Comma', 16);
    // Alias QWERTY courants (rangée haute décalée d'un cran)
    add('KeyW', 2);  add('KeyX', 4);  add('KeyC', 5);  add('KeyF', 5);
    add('KeyV', 7);  add('KeyB', 9);  add('KeyN', 11); add('KeyQ', 0);
    return m;
  }

  currentOctave() {
    return this.pianos[0]?.octave ?? 4;
  }

  onDown(e) {
    if (e.repeat) return;
    // Ignore si l'utilisateur tape dans un champ texte
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;

    // Changement d'octave avec +/-
    if (e.code === 'Minus' || e.code === 'Equal') {
      const dir = e.code === 'Equal' ? 1 : -1;
      document.dispatchEvent(new CustomEvent('octave-change', { detail: dir }));
      return;
    }

    const rel = this.map.get(e.code);
    if (rel === undefined) return;
    e.preventDefault();
    const midi = (this.currentOctave() + 1) * 12 + rel;
    if (this.held.has(e.code)) return;
    this.held.set(e.code, midi);
    this.pianos.forEach(p => p.triggerOn(midi, 'phys'));
  }

  onUp(e) {
    const midi = this.held.get(e.code);
    if (midi === undefined) return;
    this.held.delete(e.code);
    this.pianos.forEach(p => p.triggerOff(midi));
  }

  releaseAll() {
    for (const [, midi] of this.held) this.pianos.forEach(p => p.triggerOff(midi));
    this.held.clear();
  }
}
