/* =========================================================
 * gamepad.js — Support manette Xbox 360 / XInput
 * API standard Gamepad (le navigateur expose les manettes
 * XInput Windows — y compris Xbox 360 — en mapping
 * "standard" identique à celui d'une Xbox One).
 *
 * Configuration spécifique : l'application peut démarrer
 * même si la manette est absente, et se reconnecte toute
 * seule dès qu'une manette Xbox 360/XInput est branchée.
 * ========================================================= */

// Seuils (deadzone) pour les sticks analogiques
const GP_DEADZONE = 0.28;
// Fenêtre jouable par la manette : 4 octaves (48 demi-demi-tons, 28 touches blanches)
const WINDOW_SEMITONES = 48;
const WHITES_PER_WINDOW = 28;

/** Nom lisible du contrôleur détecté */
function gamepadDisplayName(gp) {
  const id = (gp.id || '').toLowerCase();
  if (id.includes('xbox 360') || id.includes('xbox-360')) return 'Manette Xbox 360';
  if (id.includes('xbox one') || id.includes('xbox-one')) return 'Manette Xbox One';
  if (id.includes('xbox wireless')) return 'Manette Xbox Sans Fil';
  if (id.includes('xinput')) return 'Manette XInput';
  if (id.includes('xbox')) return 'Manette Xbox';
  return gp.id ? `Manette (${gp.id.slice(0, 40)})` : 'Manette standard';
}

class GamepadSynth {
  /**
   * @param {PianoUI[]} pianos — pianos synchronisés visuellement
   * @param {object} opts — { octaveMin, octaveMax }
   */
  constructor(pianos, opts = {}) {
    this.pianos = pianos;
    this.octaveMin = opts.octaveMin ?? 1;
    this.octaveMax = opts.octaveMax ?? 5;
    this.connected = false;
    this.padIndex = null;      // index dans navigator.getGamepads()
    this.held = new Set();     // boutons actuellement pressés (id logiques)
    this.lastOctaveDir = 0;    // anti-répétition dpad haut/bas
    this.shiftActive = false;  // LB/RB = décalage dièses
    this.vibrateSupported = false;
    this.onStatus = opts.onStatus || (() => {});
    this.onInfo = opts.onInfo || (() => {});

    window.addEventListener('gamepadconnected', (e) => {
      this.padIndex = e.gamepad.index;
      this.connected = true;
      this.vibrateSupported = typeof e.gamepad.vibrationActuator?.playEffect === 'function';
      this.onStatus(true, gamepadDisplayName(e.gamepad));
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index !== this.padIndex) return;
      this.connected = false;
      this.padIndex = null;
      this.releaseAll();
      this.onStatus(false, null);
    });

    // Boucle de polling (requestAnimationFrame) + repli setInterval
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    setInterval(() => { if (!this.connected) this._rescan(); }, 1500);
  }

  currentOctave() {
    return this.pianos[0]?.octave ?? 4;
  }

  _rescan() {
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gp of pads) {
        if (gp && gp.connected) {
          this.padIndex = gp.index;
          this.connected = true;
          this.vibrateSupported = typeof gp.vibrationActuator?.playEffect === 'function';
          this.onStatus(true, gamepadDisplayName(gp));
          return;
        }
      }
    } catch (_) { /* API indisponible */ }
  }

  _loop() {
    requestAnimationFrame(this._loop);
    if (!this.connected || this.padIndex == null) return;
    let gp;
    try {
      gp = (navigator.getGamepads() || [])[this.padIndex];
    } catch (_) { return; }
    if (!gp || !gp.connected) return;
    this.poll(gp);
  }

  /** Mapping standard Xbox (XInput) :
   *  A=0 B=1 X=2 Y=3 LB=4 RB=5 LT=6 RT=7 Back=8 Start=9
   *  L-stick=10 R-stick=11 Dpad↑=12 ↓=13 ←=14 →=15 PS=16 */
  /** Mapping standard Xbox (XInput) :
   *  A=0 B=1 X=2 Y=3 LB=4 RB=5 LT=6 RT=7 Back=8 Start=9
   *  L-stick=10 R-stick=11 Dpad haut=12 bas=13 gauche=14 droite=15 PS=16 */
  poll(gp) {
    const b = gp.buttons.map(x => (typeof x === 'object' ? x.pressed : !!x));
    const ax = gp.axes || [];
    const base = (this.currentOctave() + 1) * 12; // MIDI du Do de la fenêtre jouable
    const whites = [0, 2, 4, 5, 7, 9, 11];

    // --- Changement de fenêtre d'octave (stick gauche ou dpad ↑/↓) ---
    // Sur Xbox 360/XInput la croix peut arriver en axes (±1.0) OU en boutons 12-15.
    const dpadUp   = b[12] || ax[1] === -1;
    const dpadDown = b[13] || ax[1] === 1;
    const dpadLeft = b[14] || ax[0] === -1;
    const dpadRight= b[15] || ax[0] === 1;
    const stickY = Math.abs(ax[1]) >= 0.99 ? ax[1] : 0; // ignore les demi-déflections dpad
    const dir = stickY < 0 || dpadUp ? 1 : (stickY > 0 || dpadDown ? -1 : 0);
    if (dir !== 0 && dir !== this.lastOctaveDir) {
      document.dispatchEvent(new CustomEvent('octave-change', { detail: dir }));
    }
    this.lastOctaveDir = dir;

    // --- Mode ♯ : bumper LB ou gâchette RT maintenu ---
    const shift = !!(b[4] || b[7]);
    if (shift !== this.shiftActive) {
      this.shiftActive = shift;
      this.onInfo(shift ? 'Mode ♯ (dièses)' : 'Mode notes naturelles');
    }

    // --- Stick droit horizontal : mélodie diatonique sur toute la fenêtre ---
    const inDead = Math.abs(ax[0]) <= GP_DEADZONE || Math.abs(ax[0]) >= 0.99; // croix => pas mélodie
    if (!inDead) {
      const whiteIdx = Math.max(0, Math.min(WHITES_PER_WINDOW - 1,
        Math.round(((Math.max(-0.9, Math.min(0.9, ax[0])) + 1) / 2) * (WHITES_PER_WINDOW - 1))));
      const rel = Math.floor(whiteIdx / 7) * 12 + whites[whiteIdx % 7];
      const midi = base + rel + (shift ? 1 : 0); // RT+stick = tout en dièses
      if (this._rsMidi != null && this._rsMidi !== midi) this.releaseNote(this._rsMidi);
      this._rsMidi = midi;
      this.triggerNote(midi);
    } else if (this.held.has('rscale')) {
      this.held.delete('rscale');
      if (this._rsMidi != null) { this.releaseNote(this._rsMidi); this._rsMidi = null; }
    } else if (!inDead) {
      this.held.add('rscale');
    }

    // --- Croix directionnelle : accords plaqués autour de la note courante ---
    const chordDefs = { up: [0, 4, 7], right: [0, 4, 7, 11], down: [0, 3, 7], left: [0, 3, 7, 10] };
    const chordKey = dpadUp ? 'up' : dpadRight ? 'right' : dpadDown ? 'down' : dpadLeft ? 'left' : null;
    if (chordKey && !this.held.has('chord')) {
      this.held.add('chord');
      const root = base + (this._lastRel ?? 0);
      this.chordNotes = chordDefs[chordKey].map(iv => root + iv);
      this.chordNotes.forEach(m => this.triggerNote(m));
      const quality = (chordKey === 'up' || chordKey === 'right') ? 'majeur' : 'mineur';
      this.onInfo(`Accord ${quality} sur ${midiToName(root)} (${chordKey === 'right' || chordKey === 'left' ? 'avec 7ᵉ' : 'triade'})`);
    } else if (!chordKey && this.held.has('chord')) {
      this.held.delete('chord');
      (this.chordNotes || []).forEach(m => this.releaseNote(m));
      this.chordNotes = null;
    }

    // --- A : octave inférieure · Y : octave supérieure (sauts instantanés) ---
    if (b[0] && !this.held.has('A')) {
      this.held.add('A');
      document.dispatchEvent(new CustomEvent('octave-change', { detail: -1 }));
    }
    if (!b[0]) this.held.delete('A');
    if (b[3] && !this.held.has('Y')) {
      this.held.add('Y');
      document.dispatchEvent(new CustomEvent('octave-change', { detail: +1 }));
    }
    if (!b[3]) this.held.delete('Y');

    // --- B : glissando demi-tonal (maintenu = monte), X : descend ---
    const stepBtn = b[1] ? 1 : (b[2] ? -1 : 0);
    if (stepBtn !== 0) {
      if (!this.held.has('step')) {
        this.held.add('step');
        this._stepTimer = setInterval(() => {
          let rel = (this._lastRel ?? 0) + stepBtn;
          rel = Math.max(-1, Math.min(WINDOW_SEMITONES - 1, rel));
          const midi = base + rel;
          if (this._stepMidi != null && this._stepMidi !== midi) this.releaseNote(this._stepMidi);
          this._stepMidi = midi;
          this.triggerNote(midi);
        }, 140);
      }
    } else if (this.held.has('step')) {
      this.held.delete('step');
      clearInterval(this._stepTimer);
      if (this._stepMidi != null) { this.releaseNote(this._stepMidi); this._stepMidi = null; }
    }

    // --- RB et LT seuls : quinte / quarte au-dessus de la note courante ---
    const faceNotes = { 5: 7, 6: 5 }; // RB = +7 demi-tons, LT = +5
    Object.keys(faceNotes).forEach(idx => {
      const pressed = !!b[idx] && !shift;
      const tag = `face${idx}`;
      const root = base + (this._lastRel ?? 0);
      const midi = root + faceNotes[idx];
      if (pressed && !this.held.has(tag)) {
        this.held.add(tag);
        this._face = this._face || {};
        this._face[tag] = midi;
        this.triggerNote(midi);
      } else if (!pressed && this.held.has(tag)) {
        this.held.delete(tag);
        if (this._face && this._face[tag] != null) { this.releaseNote(this._face[tag]); this._face[tag] = null; }
      }
    });

    // --- Start : balayage des 88 touches · Back : éteint toutes les voix ---
    if (b[9] && !this.held.has('start')) {
      this.held.add('start');
      this.sweepDemo();
    }
    if (!b[9]) this.held.delete('start');
    if (b[8] && !this.held.has('back')) {
      this.held.add('back');
      this.releaseAll();
      this.onInfo('Toutes les voix coupées ⏹');
    }
    if (!b[8]) this.held.delete('back');
  }

  triggerNote(midi) {
    this._lastRel = midi - (this.currentOctave() + 1) * 12;
    this.pianos.forEach(p => p.triggerOn(midi, 'pad'));
  }

  releaseNote(midi) {
    this.pianos.forEach(p => p.triggerOff(midi));
  }

  sweepDemo() {
    engine.ensureContext();
    // Balayage complet des 88 touches du piano de concert (La0 -> Do8)
    const blacks = [1, 3, 6, 8, 10];
    const seq = [];
    for (let m = 21; m <= 108; m++) seq.push(m);
    const t0 = performance.now();
    seq.forEach((midi, i) => setTimeout(() => {
      engine.playNote(midiToFreq(midi), 0.12);
      this.pianos.forEach(p => p.highlightExternal(midi, true));
      setTimeout(() => this.pianos.forEach(p => p.highlightExternal(midi, false)), 90);
    }, i * 22));
    this.onInfo('Balayage des 88 touches ▶');
  }

  releaseAll() {
    const base = (this.currentOctave() + 1) * 12;
    [0, 12, 13, 16, 26, 39].forEach(rel => this.pianos.forEach(p => p.triggerOff(base + rel)));
    (this.chordNotes || []).forEach(m => this.pianos.forEach(p => p.triggerOff(m)));
    this.chordNotes = null;
    this.held.clear();
  }
}

/* ---------- Interface de configuration de la manette ---------- */
class GamepadConfigPanel {
  constructor(synth) {
    this.synth = synth;
    this.rowsEl = document.getElementById('gp-map');
    this.logEl = document.getElementById('gp-log');
    this.statusEl = document.getElementById('gp-status');
    this.infoEl = document.getElementById('gp-info');
    this.state = {}; // nom -> {btn, axis, value}
    this.defaults = {};
    this._buildTable();
    this._bindLive();
  }

  /** Actions configurables (valeurs par défaut = mapping Xbox 360 standard) */
  actions() {
    return [
      { name: 'note_do',   label: 'Do  (fondamentale)',  def: 'dpad↑' },
      { name: 'note_mi',   label: 'Mi  (tierce)',        def: 'dpad→' },
      { name: 'note_sol',  label: 'Sol (quinte)',        def: 'dpad↓' },
      { name: 'note_la',   label: 'La  (sixte)',         def: 'dpad←' },
      { name: 'sharp_mode',label: 'Mode ♯ (dièses)',     def: 'LB / LT / RT' },
      { name: 'oct_up',    label: 'Octave +',            def: 'Stick G ↑' },
      { name: 'oct_down',  label: 'Octave −',            def: 'Stick G ↓' },
      { name: 'melody',    label: 'Mélodie continue',    def: 'Stick D ↔' },
      { name: 'sweep',     label: 'Balayage 88 touches', def: 'Start' },
    ];
  }

  _buildTable() {
    if (!this.rowsEl) return;
    this.rowsEl.innerHTML = '';
    this.actions().forEach(a => {
      this.defaults[a.name] = a.def;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${a.label}</td><td class="text-aqua font-mono">${a.def}</td>`;
      this.rowsEl.appendChild(tr);
    });
  }

  resetDefaults() {
    this._buildTable();
    this._log('Configuration réinitialisée (mapping Xbox 360 standard).');
  }

  /** Remappe une action vers une touche physique (pour casques/PC pad non standards) */
  remap(actionName, physicalButton) {
    const a = this.actions().find(x => x.name === actionName);
    if (!a || !this.rowsEl) return;
    const idx = this.actions().indexOf(a);
    const cell = this.rowsEl.children[idx]?.children[1];
    if (cell) cell.textContent = `bouton ${physicalButton}`;
    this._log(`${a.label} → bouton physique ${physicalButton}`);
  }

  _bindLive() {
    // Affiche l'état brut des boutons/sticks quand une manette est connectée
    const tick = () => {
      requestAnimationFrame(tick);
      if (!this.statusEl) return;
      const gp = this.synth.connected && this.synth.padIndex != null
        ? (navigator.getGamepads() || [])[this.synth.padIndex] : null;
      if (!gp) { this.statusEl.textContent = 'Aucune manette détectée — branchez une manette Xbox 360 / XInput.'; return; }
      const btns = gp.buttons.map((x, i) => (x.pressed ? i : null)).filter(v => v !== null);
      const axes = [...gp.axes].map(v => v.toFixed(2)).join(', ');
      this.statusEl.textContent = `${gamepadDisplayName(gp)} · boutons actifs : ${btns.length ? btns.join(',') : '—'} · axes : ${axes}`;
    };
    requestAnimationFrame(tick);
  }

  _log(msg) {
    if (!this.logEl) return;
    const li = document.createElement('li');
    li.textContent = msg;
    this.logEl.prepend(li);
    while (this.logEl.children.length > 12) this.logEl.lastChild.remove();
  }

  setInfo(txt) {
    if (this.infoEl) this.infoEl.textContent = txt;
  }
}

window.GamepadSynth = GamepadSynth;
window.GamepadConfigPanel = GamepadConfigPanel;
window.gamepadDisplayName = gamepadDisplayName;

