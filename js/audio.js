/* =========================================================
 * audio.js — Moteur Web Audio API
 * Génère les sons à partir des fréquences (OscillatorNode),
 * enveloppe ADSR simplifiée (attaque / relâchement),
 * analyse pour l'oscilloscope + spectre.
 * ========================================================= */

const NOTE_NAMES_FR = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

/** Fréquence d'une note MIDI (tempérament égal, La4 = 440 Hz) */
function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Nom français d'une note MIDI, ex : 60 -> "Do4" */
function midiToName(midi) {
  const name = NOTE_NAMES_FR[midi % 12];
  const oct = Math.floor(midi / 12) - 1;
  return `${name}${oct}`;
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.voices = new Map(); // keyId -> { osc, gain }
    this.settings = {
      waveform: 'sine',
      volume: 0.35,
      attack: 0.02,
      release: 0.35,
    };
  }

  /** À appeler sur un geste utilisateur (politique autoplay) */
  ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.settings.volume;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    return this.ctx;
  }

  setVolume(v) {
    this.settings.volume = v;
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }
  }

  /** Démarre une voix (note maintenue). freq en Hz. */
  noteOn(keyId, freq) {
    this.ensureContext();
    if (this.voices.has(keyId)) this.noteOff(keyId, true);

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = this.settings.waveform;
    osc.frequency.setValueAtTime(freq, t);
    // léger vibrato de richesse : detune aléatoire infime
    osc.detune.setValueAtTime((Math.random() - 0.5) * 4, t);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.001, this.settings.volume > 0 ? 0.9 : 0.001),
      t + Math.max(0.005, this.settings.attack)
    );

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);

    this.voices.set(keyId, { osc, gain, freq });
    return { freq };
  }

  /** Arrête une voix avec le temps de relâchement */
  noteOff(keyId, immediate = false) {
    const voice = this.voices.get(keyId);
    if (!voice) return;
    const t = this.ctx.currentTime;
    const rel = immediate ? 0.03 : Math.max(0.02, this.settings.release);

    try {
      voice.gain.gain.cancelScheduledValues(t);
      voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), t);
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, t + rel);
      voice.osc.stop(t + rel + 0.05);
      if (voice.lfo) voice.lfo.stop(t + rel + 0.05);
    } catch (e) { /* voix déjà stoppée */ }

    this.voices.delete(keyId);
  }

  /** Change la clé ET la hauteur d'une voix tenue (glissando manette sans ré-attaque) */
  noteRetune(oldKeyId, newKeyId, freq) {
    const v = this.voices.get(oldKeyId);
    if (!v || !this.ctx) return;
    const t = this.ctx.currentTime;
    v.freq = freq;
    v.osc.frequency.setTargetAtTime(freq, t, 0.015); // portamento fluide
    if (v.lfoGain) {
      try { v.lfo.frequency.setTargetAtTime(this._vibratoRate(freq), t, 0.05); } catch (_) {}
    }
    this.voices.delete(oldKeyId);
    this.voices.set(newKeyId, v);
  }

  /** Ajuste le volume d'une seule voix (mode soufflé : souffle = dynamique) */
  setVoiceLevel(keyId, level) {
    const v = this.voices.get(keyId);
    if (!v || !this.ctx) return;
    v.gain.gain.setTargetAtTime(Math.max(0.0001, level * 0.9), this.ctx.currentTime, 0.03);
  }

  /** Fréquence d'un vibrato proportionnel à la hauteur de la note
   *  (évite un battement trop lent dans le grave, trop frénétique dans l'aigu) */
  _vibratoRate(freq) {
    return Math.min(8.5, Math.max(3.2, freq / 90));
  }

  /** Active le vibrato (LFO sur la hauteur) d'une voix tenue — manette Xbox */
  setVibrato(keyId, on) {
    const v = this.voices.get(keyId);
    if (!v || !this.ctx) return;
    if (on && v.lfo) return;
    if (!on) {
      if (v.lfoGain) { try { v.lfoGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.06); } catch (_) {} }
      if (v.lfo) { try { v.lfo.stop(this.ctx.currentTime + 0.3); } catch (_) {} }
      v.lfo = null; v.lfoGain = null;
      return;
    }
    const t = this.ctx.currentTime;
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(this._vibratoRate(v.freq || 440), t);
    lfoGain.gain.setValueAtTime(0, t);
    // montée progressive : ~15 cents (quasi quart de demi-ton)
    lfoGain.gain.linearRampToValueAtTime(v.freq * 0.0087, t + 0.35);
    lfo.connect(lfoGain);
    lfoGain.connect(v.osc.detune);
    lfo.start(t);
    v.lfo = lfo; v.lfoGain = lfoGain;
  }

  /** Joue une note auto-stop (pour la lecture de partitions/prises) */
  playNote(freq, durationSec, whenOffset = 0) {
    this.ensureContext();
    const t0 = this.ctx.currentTime + whenOffset;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = this.settings.waveform;
    osc.frequency.setValueAtTime(freq, t0);

    const a = Math.min(0.03, Math.max(0.005, this.settings.attack));
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.9, t0 + a);
    gain.gain.setValueAtTime(0.9, t0 + Math.max(a, durationSec - 0.05));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationSec);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t0);
    osc.stop(t0 + durationSec + 0.05);
    return { osc, gain, startAt: t0, endAt: t0 + durationSec };
  }

  getActiveNotes() {
    return [...this.voices.values()].map(v => v.freq);
  }

  getTimeDomain(arr) {
    if (!this.analyser) return false;
    this.analyser.getByteTimeDomainData(arr);
    return true;
  }

  getFrequencyData(arr) {
    if (!this.analyser) return false;
    this.analyser.getByteFrequencyData(arr);
    return true;
  }
}

// Instance globale partagée par tous les modules
const engine = new AudioEngine();
