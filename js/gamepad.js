/* =========================================================
 * gamepad.js — La manette Xbox 360 / XInput comme INSTRUMENT
 * de musique (API standard Gamepad du navigateur).
 *
 * Modes instrument :
 *  • 🎹 PIANO      — croix + A/B/X/Y = accords, stick D = mélodie
 *  • 🎸 GRILLE     — farette type guitare : les 4 faces sont des
 *                    demi-tons, LB/RB = cases sur le manche,
 *                    LT/RT = cordes graves/aiguës (jusqu'à 5 voix)
 *  • 🎺 SOUFFLÉ    — RT = souffle (gâchette analogique = volume),
 *                    stick G ↕ = hauteur continue (glissando),
 *                    stick G ↔ = trémolo, B = staccato,
 *                    croix = doigtés (12 notes chromatiques)
 *
 * Communs : stick G ↕ / A / Y = fenêtre d'octave · LB ou RT maintenu
 * (piano/grille) = mode ♯ · Start = balayage des 88 touches ·
 * Back = couper toutes les voix. Vibration de la manette à chaque
 * note (rumble XInput) quand l'API le permet.
 * ========================================================= */

const GP_DEADZONE = 0.28;
// Fenêtre jouable par la manette : 4 octaves
const WINDOW_SEMITONES = 48;
const WHITES_PER_WINDOW = 28;
const FULL_LOW = 21, FULL_HIGH = 108; // piano de concert : La0 -> Do8

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
  /** @param {PianoUI[]} pianos — [0] = piano PRINCIPAL (voix sonore + callbacks),
   *  les suivants servent à l'allumage visuel synchronisé des touches */
  constructor(pianos, opts = {}) {
    this.pianos = pianos;
    this.octaveMin = opts.octaveMin ?? 1;
    this.octaveMax = opts.octaveMax ?? 6;
    this.connected = false;
    this.padIndex = null;
    this.held = new Set();          // boutons pressés (ids logiques)
    this.lastOctaveDir = 0;
    this.shiftActive = false;
    this.vibrateSupported = false;
    this.onStatus = opts.onStatus || (() => {});
    this.onInfo = opts.onInfo || (() => {});

    // --- Mode instrument courant (persisté) ---
    this.mode = localStorage.getItem('fs-gp-mode') || 'piano';
    // --- Réglages souffle (mode soufflé) ---
    this.breath = { min: 0.12, max: 1.0, trim: parseFloat(localStorage.getItem('fs-gp-trim') ?? '0'),
                    tremRate: 6.5, vibrWidth: 0.0087 };

    // Voix actives de la manette : tag -> midi (pour libération propre)
    this.voices = new Map();

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

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    setInterval(() => { if (!this.connected) this._rescan(); }, 1500);
  }

  currentOctave() { return this.pianos[0]?.octave ?? 4; }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    localStorage.setItem('fs-gp-mode', mode);
    this.releaseAll();
    const names = { piano: '🎹 Piano', grille: '🎸 Grille de guitare', souffle: '🎺 Instrument soufflé' };
    this.onInfo(`Mode ${names[mode] || mode} activé`);
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
    try { gp = (navigator.getGamepads() || [])[this.padIndex]; } catch (_) { return; }
    if (!gp || !gp.connected) return;
    try { this.poll(gp); } catch (_) { /* ne casse pas l'UI */ }
  }

  /* ---------- Voix ---------- */
  _clampFull(midi) { return Math.max(FULL_LOW, Math.min(FULL_HIGH, midi)); }

  /** Allume une voix (si nouvelle) avec options sonores */
  voiceOn(tag, midiRaw, o = {}) {
    const midi = this._clampFull(Math.round(midiRaw));
    if (this.voices.get(tag) === midi) return false;
    if (this.voices.has(tag)) this.voiceOff(tag);
    this.voices.set(tag, midi);
    // L'ordre importe : pianoMain (index 0) porte la voix sonore + callbacks.
    this.pianos.forEach(p => p.triggerOn(midi, 'pad', o));
    if (o.rumble !== false) this.rumble(o.rumbleStrong ?? 0.45, o.rumbleWeak ?? 0.22, 35);
    return true;
  }

  voiceOff(tag) {
    const midi = this.voices.get(tag);
    if (midi == null) return;
    this.voices.delete(tag);
    this.pianos.forEach(p => p.triggerOff(midi));
  }

  /** Change la hauteur d'une voix existante : glissando fluide si la voix
   *  est bien tenue (retune), sinon nouvelle attaque. */
  voiceRetune(tag, midiRaw) {
    const cur = this.voices.get(tag);
    if (cur == null) return this.voiceOn(tag, midiRaw);
    const midi = this._clampFull(Math.round(midiRaw));
    if (midi === cur) return;
    this.voices.set(tag, midi);
    const vibrato = (tag === 'wind' || tag === 'fret');
    let retuned = false;
    // pianoMain d'abord : il fait glisser la vraie voix (portamento Web Audio)
    if (this.pianos[0] && this.pianos[0].retune(cur, midi)) retuned = true;
    this.pianos.slice(1).forEach(p => {
      for (const t of [...p.pressed]) {
        if (t.endsWith(`:${cur}`)) {
          p.pressed.delete(t);
          p.pressed.add(`${t.slice(0, t.lastIndexOf(':'))}:${midi}`);
          retuned = true;
        }
      }
      p.highlightExternal(cur, false);
      p.highlightExternal(midi, true);
    });
    if (!retuned) { // aucune voix à faire glisser : nouvelle attaque propre
      this.pianos.forEach(p => p.triggerOff(cur));
      this.pianos.forEach(p => p.triggerOn(midi, 'pad', { vibrato }));
    }
  }

  /** Intensité sonore d'une voix tenue (soufflé / dynamique des gâchettes) */
  voiceLevel(tag, level) {
    const midi = this.voices.get(tag);
    if (midi == null) return;
    engine.setVoiceLevel(`m${midi}`, Math.max(0.02, Math.min(1, level)));
  }

  rumble(strong, weak, durationMs) {
    if (!this.vibrateSupported || this.padIndex == null) return;
    try {
      const gp = (navigator.getGamepads() || [])[this.padIndex];
      gp?.vibrationActuator?.playEffect('dual-rumble', {
        duration: durationMs, strongMagnitude: strong, weakMagnitude: weak,
      });
    } catch (_) {}
  }

  /* =========================================================
   * Mapping standard Xbox (XInput) :
   * A=0 B=1 X=2 Y=3 LB=4 RB=5 LT=6 RT=7 Back=8 Start=9
   * L-stick=10 R-stick=11 Dpad↑=12 ↓=13 ←=14 →=15 PS=16
   * ========================================================= */
  poll(gp) {
    const b = gp.buttons.map(x => (typeof x === 'object' ? x.pressed : !!x));
    const v = gp.buttons.map(x => (typeof x === 'object' ? (x.value ?? (x.pressed ? 1 : 0)) : 0));
    const ax = gp.axes || [];
    const base = (this.currentOctave() + 1) * 12; // MIDI du Do de la fenêtre
    const whites = [0, 2, 4, 5, 7, 9, 11];

    // --- Dpad : axes (±1.0, cas Xbox 360/Chrome) OU boutons 12-15 ---
    const dpadUp    = b[12] || ax[1] === -1;
    const dpadDown  = b[13] || ax[1] === 1;
    const dpadLeft  = b[14] || ax[0] === -1;
    const dpadRight = b[15] || ax[0] === 1;

    // --- Changement de fenêtre d'octave (stick G ↕ ou dpad ↑/↓ en modes piano/grille) ---
    const stickYraw = Math.abs(ax[1]) >= 0.99 ? ax[1] : 0;
    if (this.mode !== 'souffle') {
      const dir = (stickYraw < 0 || dpadUp) ? 1 : ((stickYraw > 0 || dpadDown) ? -1 : 0);
      if (dir !== 0 && dir !== this.lastOctaveDir) {
        document.dispatchEvent(new CustomEvent('octave-change', { detail: dir }));
      }
      this.lastOctaveDir = dir;
      if (b[0] && !this.held.has('A')) { this.held.add('A'); document.dispatchEvent(new CustomEvent('octave-change', { detail: -1 })); }
      if (!b[0]) this.held.delete('A');
      if (b[3] && !this.held.has('Y')) { this.held.add('Y'); document.dispatchEvent(new CustomEvent('octave-change', { detail: +1 })); }
      if (!b[3]) this.held.delete('Y');
    } else {
      this.lastOctaveDir = 0;
    }

    if (this.mode === 'piano')   this._pollPiano(b, ax, base, whites, dpadUp, dpadDown, dpadLeft, dpadRight);
    if (this.mode === 'grille')  this._pollFretboard(b, v, ax, base);
    if (this.mode === 'souffle') this._pollWind(b, v, ax, base);

    // --- Start : balayage des 88 touches · Back : couper toutes les voix ---
    if (b[9] && !this.held.has('start')) { this.held.add('start'); this.sweepDemo(); }
    if (!b[9]) this.held.delete('start');
    if (b[8] && !this.held.has('back')) {
      this.held.add('back');
      this.releaseAll();
      this.onInfo('Toutes les voix coupées ⏹');
    }
    if (!b[8]) this.held.delete('back');
  }

  /* ---------------- MODE 🎹 PIANO (hérité, enrichi) ---------------- */
  _pollPiano(b, ax, base, whites, dpadUp, dpadDown, dpadLeft, dpadRight) {
    const shift = !!(b[4] || b[7]);
    if (shift !== this.shiftActive) {
      this.shiftActive = shift;
      this.onInfo(shift ? 'Mode ♯ (dièses)' : 'Mode notes naturelles');
    }

    // Stick droit ↔ : mélodie diatonique continue (suites sans ré-attaque : glissando)
    const inDead = Math.abs(ax[0]) <= GP_DEADZONE || Math.abs(ax[0]) >= 0.99;
    if (!inDead) {
      const whiteIdx = Math.max(0, Math.min(WHITES_PER_WINDOW - 1,
        Math.round(((Math.max(-0.9, Math.min(0.9, ax[0])) + 1) / 2) * (WHITES_PER_WINDOW - 1))));
      const rel = Math.floor(whiteIdx / 7) * 12 + whites[whiteIdx % 7];
      const midi = base + rel + (shift ? 1 : 0);
      this._lastRel = rel + (shift ? 1 : 0);
      if (this.voices.has('rscale')) this.voiceRetune('rscale', midi);
      else this.voiceOn('rscale', midi);
    } else {
      this.voiceOff('rscale');
    }

    // Croix : accords plaqués autour de la note courante
    const chordDefs = { up: [0, 4, 7], right: [0, 4, 7, 11], down: [0, 3, 7], left: [0, 3, 7, 10] };
    const chordKey = dpadUp ? 'up' : dpadRight ? 'right' : dpadDown ? 'down' : dpadLeft ? 'left' : null;
    if (chordKey && !this.held.has('chord')) {
      this.held.add('chord');
      const root = base + (this._lastRel ?? 0);
      this.chordNotes = chordDefs[chordKey].map(iv => root + iv);
      this.chordNotes.forEach((m, i) => this.voiceOn(`ch${i}`, m));
      const quality = (chordKey === 'up' || chordKey === 'right') ? 'majeur' : 'mineur';
      this.onInfo(`Accord ${quality} sur ${midiToName(root)}${chordKey === 'right' || chordKey === 'left' ? ' (avec 7ᵉ)' : ''}`);
    } else if (!chordKey && this.held.has('chord')) {
      this.held.delete('chord');
      ['ch0', 'ch1', 'ch2', 'ch3'].forEach(t => this.voiceOff(t));
      this.chordNotes = null;
    }

    // B / X : glissando demi-tonal montant / descendant (une seule voix qui glisse)
    const stepBtn = b[1] ? 1 : (b[2] ? -1 : 0);
    if (stepBtn !== 0) {
      if (!this.held.has('step')) {
        this.held.add('step');
        this._stepTimer = setInterval(() => {
          let rel = (this._lastRel ?? 0) + stepBtn;
          rel = Math.max(-1, Math.min(WINDOW_SEMITONES - 1, rel));
          this._lastRel = rel;
          if (this.voices.has('step')) this.voiceRetune('step', base + rel);
          else this.voiceOn('step', base + rel);
        }, 140);
      }
    } else if (this.held.has('step')) {
      this.held.delete('step');
      clearInterval(this._stepTimer);
      this.voiceOff('step');
    }

    // RB / LT seuls : quinte / quarte au-dessus de la note courante
    [[5, 7, 'fifth'], [6, 5, 'fourth']].forEach(([idx, iv, tag]) => {
      const pressed = !!b[idx] && !shift;
      if (pressed) this.voiceOn(tag, base + (this._lastRel ?? 0) + iv);
      else this.voiceOff(tag);
    });
  }

  /* ---------------- MODE 🎸 GRILLE DE GUITARE ---------------- */
  _pollFretboard(b, v, ax, base) {
    // Accordage standard E A D G B E ; ancrage = Mi2 (MIDI 40) + fenêtre d'octave
    const octShift = (this.currentOctave() - 4) * 12;
    const anchor = 40 + octShift;
    const strings = [
      { tag: 's6', off: 0,  side: 'LT' }, // Mi grave
      { tag: 's5', off: 5,  side: 'LT' }, // La
      { tag: 's4', off: 10, side: 'LT' }, // Ré
      { tag: 's3', off: 15, side: 'RT' }, // Sol
      { tag: 's2', off: 19, side: 'RT' }, // Si
      { tag: 's1', off: 24, side: 'RT' }, // Mi aigu
    ];
    this._fret = Math.max(0, Math.min(19, this._fret ?? 0));
    const fret = this._fret;

    // LB / RB : reculer / avancer d'une case sur le manche (répétition si maintenu)
    this._repeatEdge('lb', b[4], () => { this._fret = Math.max(0, this._fret - 1); });
    this._repeatEdge('rb', b[5], () => { this._fret = Math.min(19, this._fret + 1); });

    // A B X Y = demi-tons joués sur la corde tenue (frettes 0..3 relatives)
    const heldSemi = [];
    if (b[0]) heldSemi.push(0);
    if (b[1]) heldSemi.push(1);
    if (b[2]) heldSemi.push(2);
    if (b[3]) heldSemi.push(3);

    // LT / RT = gratter cordes graves / aiguës (fonction de profondeur de l'appui)
    const strumLow  = v[6] > 0.3;
    const strumHigh = v[7] > 0.3;

    const active = new Set();
    strings.forEach(st => {
      const sounding = (st.side === 'LT' && strumLow) || (st.side === 'RT' && strumHigh);
      if (!sounding) return;
      const semi = heldSemi.length ? heldSemi[strings.indexOf(st) % heldSemi.length] : 0;
      active.add(st.tag);
      const lvl = st.side === 'LT' ? v[6] : v[7];
      this.voiceOn(st.tag, anchor + st.off + fret + semi, { vibrato: heldSemi.includes(3), rumbleStrong: 0.6 });
      this.voiceLevel(st.tag, 0.25 + lvl * 0.75);
    });

    // Faces seules (sans gâchette) = mélodie sur la corde de Sol (corde pivot)
    if (active.size === 0 && heldSemi.length > 0) {
      const semi = Math.min(...heldSemi);
      active.add('fret');
      this.voiceOn('fret', anchor + 15 + fret + semi, { vibrato: heldSemi.includes(3) });
    }

    // Coupe les voix qui ne sont plus sollicitées
    for (const t of [...this.voices.keys()]) {
      if (!active.has(t) && (t.startsWith('s') || t === 'fret')) this.voiceOff(t);
    }

    // Stick G ↔ : bending ±1 ton (glissando fluide sur les voix actives)
    const bend = Math.abs(ax[0]) >= 0.99 ? 0 : Math.max(-1, Math.min(1, ax[0]));
    if (Math.abs(bend) > GP_DEADZONE && active.size) {
      for (const t of active) this.voiceRetune(t, this.voices.get(t) + bend);
    }

    // Information live (case + note la plus grave entendue)
    if ((strumLow || strumHigh || heldSemi.length) && !this.held.has('fretinfo')) {
      this.held.add('fretinfo');
      const first = [...this.voices.values()][0];
      this.onInfo(`🎸 Case ${fret} · ${first != null ? midiToName(first) : '—'} · ${strumLow || strumHigh ? 'gratté' : 'note tenue'}`);
    } else if (!strumLow && !strumHigh && heldSemi.length === 0) {
      this.held.delete('fretinfo');
    }
  }

  /* ---------------- MODE 🎺 INSTRUMENT SOUFFLÉ ---------------- */
  _pollWind(b, v, ax, base) {
    const br = this.breath;
    const blowing = v[7] > 0.06; // gâchette droite = souffle analogique

    if (!blowing) {
      if (this.voices.has('wind')) this.voiceOff('wind');
      if (this._trem) { clearInterval(this._trem); this._trem = null; }
      if (this._staccTimer) { clearTimeout(this._staccTimer); this._staccTimer = null; }
      if (this._savedVol != null) { engine.setVolume(this._savedVol); this._savedVol = null; }
      this.held.delete('wA'); this.held.delete('wY');
      return;
    }
    if (this._savedVol == null) this._savedVol = engine.settings.volume;

    // --- Doigtés : croix + faces = notes de la gamme des harmoniques ---
    const digMap = [[12, 0], [15, 2], [13, 4], [14, 5], [0, 7], [1, 9], [2, 11], [3, 12]];
    let digited = null;
    for (const [btn, iv] of digMap) if (b[btn]) { digited = iv; break; }

    // --- Hauteur : doigté prioritaire, sinon stick G ↕ continu (glissando) ---
    let midiTarget;
    if (digited != null) {
      this._lastRel = digited;
      midiTarget = base + digited;
    } else {
      const sy = Math.abs(ax[1]) >= 0.99 ? 0 : Math.max(-1, Math.min(1, ax[1]));
      if (Math.abs(sy) > 0.08) {
        midiTarget = base + ((sy + 1) / 2) * (WINDOW_SEMITONES - 1);
      } else {
        midiTarget = base + (this._lastRel ?? 12);
      }
    }

    // --- Mise en route / glissando de la voix tenue ---
    const had = this.voices.has('wind');
    if (!had) {
      this.voiceOn('wind', midiTarget, { vibrato: true, rumbleStrong: 0.2, rumbleWeak: 0.1 });
    } else {
      this.voiceRetune('wind', midiTarget);
    }
    // Intensité du souffle = dynamique de la voix (gâchette + trim)
    this.voiceLevel('wind', Math.max(br.min, Math.min(1, (v[7] + br.trim))));

    // --- Trémolo : stick G ↔ oscille la hauteur autour de la note réelle ---
    const sx = Math.abs(ax[0]) >= 0.99 ? 0 : Math.max(-1, Math.min(1, ax[0]));
    if (Math.abs(sx) > GP_DEADZONE) {
      this._windReal = Math.round(midiTarget);
      const depth = Math.round(Math.abs(sx) * 12) / 12;   // quantifiée : évite de recréer le timer à chaque frame
      const period = Math.max(70, 1000 / (br.tremRate * 2));
      if (!this._trem || this._tremDepth !== depth || this._tremPeriod !== period) {
        if (this._trem) clearInterval(this._trem);
        let up = false;
        this._tremDepth = depth; this._tremPeriod = period;
        this._trem = setInterval(() => {
          up = !up;
          if (this.voices.has('wind')) {
            const real = this._windReal ?? this.voices.get('wind');
            this.voiceRetune('wind', real + (up ? depth : -depth));
          }
        }, period);
      }
    } else if (this._trem) {
      clearInterval(this._trem); this._trem = null;
      this.voiceRetune('wind', midiTarget); // revient à la note juste
    }

    // --- Staccato : X seul = coup de langue (relâche puis retient) ---
    if (b[2] && digited !== 11 && !this._staccTimer && this.voices.has('wind')) {
      const held = this.voices.get('wind');
      this.voiceOff('wind');
      this._staccTimer = setTimeout(() => {
        this._staccTimer = null;
        if (this.mode === 'souffle') this.voiceOn('wind', held, { vibrato: true, rumble: false });
      }, 130);
    }

    // --- A / Y seuls : registre grave / suraigu (±1 octave) ---
    if (b[0] && !b[3] && !this.held.has('wA')) { this.held.add('wA'); document.dispatchEvent(new CustomEvent('octave-change', { detail: -1 })); }
    if (!b[0]) this.held.delete('wA');
    if (b[3] && !b[0] && !this.held.has('wY')) { this.held.add('wY'); document.dispatchEvent(new CustomEvent('octave-change', { detail: +1 })); }
    if (!b[3]) this.held.delete('wY');

    // --- Jauge live du souffle ---
    const pct = Math.round(v[7] * 100);
    if (pct !== this._lastBreathPct) {
      this._lastBreathPct = pct;
      const bar = '▮'.repeat(Math.round(pct / 10)).padEnd(10, '▯');
      const nm = this.voices.get('wind');
      this.onInfo(`Souffle ${bar} ${pct}% · ${nm != null ? midiToName(nm) + ' (' + Math.round(midiToFreq(nm)) + ' Hz)' : '—'}`);
    }
  }

  /* ---------- Utilitaire : appui avec répétition lente ---------- */
  _repeatEdge(tag, pressed, cb) {
    if (pressed) {
      if (!this.held.has(tag)) {
        this.held.add(tag);
        cb();
        this[`_rep_${tag}`] = setInterval(cb, 220);
      }
    } else if (this.held.has(tag)) {
      this.held.delete(tag);
      clearInterval(this[`_rep_${tag}`]);
    }
  }

  /* ---------- Compat API existante ---------- */
  triggerNote(midi) { this.voiceOn('legacy', midi); }
  releaseNote(midi) { for (const [t, m] of [...this.voices]) if (m === midi) this.voiceOff(t); }

  sweepDemo() {
    engine.ensureContext();
    const seq = [];
    for (let m = FULL_LOW; m <= FULL_HIGH; m++) seq.push(m);
    seq.forEach((midi, i) => setTimeout(() => {
      engine.playNote(midiToFreq(midi), 0.12);
      this.pianos.forEach(p => p.highlightExternal(midi, true));
      setTimeout(() => this.pianos.forEach(p => p.highlightExternal(midi, false)), 90);
      if (i % 12 === 0) this.rumble(0.3, 0.1, 20);
    }, i * 22));
    this.onInfo('Balayage des 88 touches ▶');
  }

  releaseAll() {
    for (const tag of [...this.voices.keys()]) this.voiceOff(tag);
    this.voices.clear();
    this.held.clear();
    this.chordNotes = null;
    if (this._stepTimer) { clearInterval(this._stepTimer); this._stepTimer = null; }
    if (this._trem) { clearInterval(this._trem); this._trem = null; }
    if (this._staccTimer) { clearTimeout(this._staccTimer); this._staccTimer = null; }
    ['lb', 'rb'].forEach(t => clearInterval(this[`_rep_${t}`]));
    // rend la main au curseur de volume
    const slider = document.getElementById('volume');
    if (slider) engine.setVolume(slider.value / 100);
    this._savedVol = null;
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
    this.defaults = {};
    this._buildModeButtons();
    this._buildTable();
    this._bindSliders();
    this._bindLive();
  }

  /** Actions musicales selon le mode instrument courant */
  actions() {
    const m = this.synth.mode;
    if (m === 'grille') return [
      { label: 'Gratter cordes graves (Mi·La·Ré)', def: 'LT (analogique)' },
      { label: 'Gratter cordes aiguës (Sol·Si·Mi)', def: 'RT (analogique)' },
      { label: 'Demi-tons sur la corde (farette)', def: 'A B X Y' },
      { label: 'Vibrato de corde', def: 'Y maintenu' },
      { label: 'Case ◀ / ▶ (jusqu\'à la 20ᵉ)', def: 'LB / RB' },
      { label: 'Bending ±1 ton', def: 'Stick G ↔' },
      { label: 'Fenêtre d\'octave', def: 'Stick G ↕ · A / Y' },
      { label: 'Balayage 88 touches', def: 'Start' },
    ];
    if (m === 'souffle') return [
      { label: 'Souffler (intensité = volume)', def: 'RT (gâchette analogique)' },
      { label: 'Hauteur continue (glissando)', def: 'Stick G ↕' },
      { label: 'Doigtés chromatiques (12 notes)', def: 'Croix + A B X Y' },
      { label: 'Staccato (coup de langue)', def: 'B seul' },
      { label: 'Trémolo (plus fort = plus rapide…)', def: 'Stick G ↔' },
      { label: 'Registre grave / suraigu', def: 'A / Y' },
      { label: 'Couper le son', def: 'Back' },
      { label: 'Balayage 88 touches', def: 'Start' },
    ];
    return [
      { label: 'Mélodie diatonique continue', def: 'Stick D ↔' },
      { label: 'Accord majeur / 7ᵉ / mineur / m7', def: 'Croix ↑ → ↓ ←' },
      { label: 'Mode ♯ (tout en dièses)', def: 'LB ou RT maintenu' },
      { label: 'Glissando demi-tonal ▲▼', def: 'B / X maintenus' },
      { label: 'Quinte / quarte au-dessus', def: 'RB / LT' },
      { label: 'Fenêtre d\'octave', def: 'Stick G ↕ · A / Y' },
      { label: 'Balayage 88 touches', def: 'Start' },
      { label: 'Couper toutes les voix', def: 'Back' },
    ];
  }

  _buildModeButtons() {
    const wrap = document.getElementById('gp-modes');
    if (!wrap) return;
    wrap.innerHTML = '';
    [['piano', '🎹 Piano'], ['grille', '🎸 Grille de guitare'], ['souffle', '🎺 Soufflé']].forEach(([id, lbl]) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost gp-mode' + (this.synth.mode === id ? ' active' : '');
      btn.textContent = lbl;
      btn.dataset.mode = id;
      btn.addEventListener('click', () => {
        this.synth.setMode(id);
        this._buildModeButtons();
        this._buildTable();
        this._log(`Mode instrument changé : ${lbl}`);
      });
      wrap.appendChild(btn);
    });
  }

  _buildTable() {
    if (!this.rowsEl) return;
    this.rowsEl.innerHTML = '';
    this.actions().forEach(a => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${a.label}</td><td class="text-aqua font-mono">${a.def}</td>`;
      this.rowsEl.appendChild(tr);
    });
  }

  resetDefaults() {
    this.synth.breath.trim = 0;
    localStorage.setItem('fs-gp-trim', '0');
    const s = document.getElementById('gp-breathtrim');
    if (s) { s.value = 0; const out = document.getElementById('gp-breathtrim-val'); if (out) out.textContent = '+0 %'; }
    this._buildTable();
    this._log('Configuration réinitialisée (mapping Xbox 360 standard).');
  }

  _bindSliders() {
    const el = document.getElementById('gp-breathtrim');
    if (!el) return;
    el.value = Math.round(this.synth.breath.trim * 100);
    el.addEventListener('input', () => {
      this.synth.breath.trim = el.value / 100;
      localStorage.setItem('fs-gp-trim', String(el.value / 100));
      const out = document.getElementById('gp-breathtrim-val');
      if (out) out.textContent = `${el.value > 0 ? '+' : ''}${el.value} %`;
    });
  }

  _bindLive() {
    const tick = () => {
      requestAnimationFrame(tick);
      if (!this.statusEl) return;
      const gp = this.synth.connected && this.synth.padIndex != null
        ? (navigator.getGamepads() || [])[this.synth.padIndex] : null;
      if (!gp) { this.statusEl.textContent = 'Aucune manette détectée — branchez une manette Xbox 360 / XInput.'; return; }
      const btns = gp.buttons.map((x, i) => (x.pressed ? i : null)).filter(n => n !== null);
      const axes = [...gp.axes].map(x => x.toFixed(2)).join(', ');
      const voices = [...this.synth.voices.entries()]
        .map(([t, m]) => `${t}:${midiToName(m)}`).join(' ') || '—';
      this.statusEl.innerHTML =
        `<b class="text-emerald-300">${gamepadDisplayName(gp)}</b> · boutons : ${btns.length ? btns.join(',') : '—'} · axes : ${axes}<br>` +
        `<span class="text-aqua">Voix actives : ${voices}</span>`;
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
