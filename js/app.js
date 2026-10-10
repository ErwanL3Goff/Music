/* =========================================================
 * app.js — Point d'entrée : UI globale, onglets, visualiseur,
 * câblage synthé / clavier / enregistreur / partitions.
 * ========================================================= */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- Instances ----------
const recorder = new NoteRecorder();
const store = new ScoreStore();
const scorePlayer = new ScorePlayer();

let pianoMain = null;   // piano de l'onglet Jouer
let pianoRec = null;    // piano de l'onglet Enregistrer
let composerNotes = []; // notes de la partition en cours d'édition
let selectedScoreId = null;

// ---------- Objet UI partagé (utilisé par recorder.js) ----------
const UI = {
  setRecUI(on) {
    $('#btn-rec').disabled = on;
    $('#btn-stop').disabled = !on;
    const st = $('#rec-status');
    st.textContent = on ? '● REC' : 'PRÊT';
    st.className = 'badge ' + (on ? 'badge-rec' : 'badge-idle');
    if (!on) {
      const has = recorder.take.length > 0;
      $('#btn-playtake').disabled = !has;
      $('#btn-clear-take').disabled = !has;
      $('#btn-save-score').disabled = !has;
    } else {
      $('#btn-playtake').disabled = true;
      $('#btn-save-score').disabled = true;
    }
  },

  tickRecTime(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    const d = Math.floor((sec % 1) * 10);
    $('#rec-time').textContent = `${m}:${s}.${d}`;
  },

  updateTake(rec) {
    $('#take-count').textContent = `${rec.take.length} note(s)`;
    drawPianoRoll($('#roll-canvas'), rec.take);
    const log = $('#take-log');
    log.innerHTML = '';
    rec.take.slice(-40).reverse().forEach(ev => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="t">${ev.start.toFixed(2)}→${ev.end.toFixed(2)}s</span>
                      <span class="n">${ev.name}</span>
                      <span class="f">${ev.freq} Hz</span>`;
      log.appendChild(li);
    });
    UI.setRecUI(rec.recording);
  },

  flashKey(midi) {
    [pianoMain, pianoRec].forEach(p => {
      if (!p) return;
      p.highlightExternal(midi, true);
      setTimeout(() => p.highlightExternal(midi, false), 250);
    });
  },
};

// ---------- Onglets ----------
function initTabs() {
  $$('#tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#tabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.tab-panel').forEach(p => p.classList.add('hidden'));
      $(`#panel-${btn.dataset.tab}`).classList.remove('hidden');
      resizeScope();
    });
  });
}

// ---------- Synthé ----------
function initSynthControls() {
  $('#waveform').addEventListener('change', e => { engine.settings.waveform = e.target.value; });
  $('#volume').addEventListener('input', e => {
    engine.setVolume(e.target.value / 100);
    $('#vol-val').textContent = `${e.target.value}%`;
  });
  $('#attack').addEventListener('input', e => {
    engine.settings.attack = e.target.value / 100;
    $('#att-val').textContent = `${(e.target.value / 100).toFixed(2)} s`;
  });
  $('#release').addEventListener('input', e => {
    engine.settings.release = e.target.value / 100;
    $('#rel-val').textContent = `${(e.target.value / 100).toFixed(2)} s`;
  });
  $('#octave').addEventListener('input', e => setOctave(+e.target.value));

  document.addEventListener('octave-change', (e) => {
    const v = Math.min(6, Math.max(2, +$('#octave').value + e.detail));
    $('#octave').value = v;
    setOctave(v);
  });

  $('#btn-demo').addEventListener('click', playScaleDemo);
}

function setOctave(oct) {
  $('#oct-val').textContent = oct;
  [pianoMain, pianoRec].forEach(p => p && p.setOctave(oct));
  buildFreqTable(oct);
}

function playScaleDemo() {
  engine.ensureContext();
  const base = (+$('#octave').value + 1) * 12;
  const scale = [0, 2, 4, 5, 7, 9, 11, 12];
  scale.forEach((rel, i) => {
    setTimeout(() => {
      const midi = base + rel;
      engine.playNote(midiToFreq(midi), 0.4);
      UI.flashKey(midi);
      showLiveNotes([{ midi, freq: midiToFreq(midi) }]);
    }, i * 380);
  });
  setTimeout(() => showLiveNotes(engine.getActiveNotes().map(f => ({ midi: -1, freq: f }))), scale.length * 380 + 400);
}

// ---------- Notes actives + lecture fréquence ----------
function showLiveNotes(list) {
  const box = $('#live-notes');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<span class="text-xs text-slate-500 italic self-center">Aucune note…</span>';
    $('#freq-readout').textContent = '— Hz';
    return;
  }
  list.forEach(({ midi, freq }) => {
    const chip = document.createElement('span');
    chip.className = 'live-chip';
    chip.textContent = `${midi >= 0 ? midiToName(midi) : '♪'} · ${freq.toFixed(1)} Hz`;
    box.appendChild(chip);
  });
  $('#freq-readout').textContent = `${list[0].freq.toFixed(1)} Hz`;
}

function pollLiveNotes() {
  if ($('#panel-play').classList.contains('hidden')) return;
  const freqs = engine.getActiveNotes();
  showLiveNotes(freqs.map(f => ({ midi: -1, freq: f })));
}

// ---------- Table des fréquences ----------
function buildFreqTable(oct) {
  const tbody = $('#freq-table-body');
  tbody.innerHTML = '';
  const rows = [
    ...KEY_MAP.white.map(w => ({ rel: w.rel, key: w.key.toUpperCase() })),
    ...KEY_MAP.black.map(b => ({ rel: b.rel, key: b.key.toUpperCase() })),
  ].sort((a, b) => a.rel - b.rel);

  rows.forEach(r => {
    const midi = (oct + 1) * 12 + r.rel;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${midiToName(midi)}</td><td>${midiToFreq(midi).toFixed(2)} Hz</td><td>${r.key}</td>`;
    tbody.appendChild(tr);
  });
}

// ---------- Visualiseur (oscilloscope + spectre) ----------
let scopeCanvas, scopeCtx, tdArr, fdArr;

function resizeScope() {
  if (!scopeCanvas) return;
  const rect = scopeCanvas.getBoundingClientRect();
  if (rect.width > 0) {
    scopeCanvas.width = rect.width * devicePixelRatio;
    scopeCanvas.height = rect.height * devicePixelRatio;
  }
}

function drawScope() {
  requestAnimationFrame(drawScope);
  if (!scopeCtx || $('#panel-play').classList.contains('hidden')) return;

  const W = scopeCanvas.width, H = scopeCanvas.height;
  scopeCtx.clearRect(0, 0, W, H);

  // fond quadrillé léger
  scopeCtx.strokeStyle = 'rgba(255,255,255,.05)';
  scopeCtx.lineWidth = 1;
  for (let gx = 0; gx < W; gx += 40 * devicePixelRatio) {
    scopeCtx.beginPath(); scopeCtx.moveTo(gx, 0); scopeCtx.lineTo(gx, H); scopeCtx.stroke();
  }

  if (!engine.analyser) return;
  if (!tdArr) {
    tdArr = new Uint8Array(engine.analyser.fftSize);
    fdArr = new Uint8Array(engine.analyser.frequencyBinCount);
  }

  // --- spectre (barres) ---
  engine.getFrequencyData(fdArr);
  const bins = 96;
  const bw = W / bins;
  for (let i = 0; i < bins; i++) {
    const v = fdArr[Math.floor(i * fdArr.length / bins / 2)] / 255;
    const bh = v * H * 0.9;
    const hue = 265 - v * 120;
    scopeCtx.fillStyle = `hsla(${hue},80%,60%,.35)`;
    scopeCtx.fillRect(i * bw, H - bh, bw - 2, bh);
  }

  // --- oscilloscope (ligne) ---
  engine.getTimeDomain(tdArr);
  scopeCtx.lineWidth = 2 * devicePixelRatio;
  scopeCtx.strokeStyle = '#2dd4bf';
  scopeCtx.shadowColor = 'rgba(45,212,191,.8)';
  scopeCtx.shadowBlur = 8;
  scopeCtx.beginPath();
  const slice = W / tdArr.length;
  for (let i = 0; i < tdArr.length; i++) {
    const y = (tdArr[i] / 255) * H;
    i === 0 ? scopeCtx.moveTo(0, y) : scopeCtx.lineTo(i * slice, y);
  }
  scopeCtx.stroke();
  scopeCtx.shadowBlur = 0;
}

// ---------- Enregistrement ----------
function initRecorder() {
  $('#btn-rec').addEventListener('click', () => recorder.start());
  $('#btn-stop').addEventListener('click', () => recorder.stop());
  $('#btn-clear-take').addEventListener('click', () => recorder.clear());
  $('#btn-playtake').addEventListener('click', () => {
    $('#btn-playtake').textContent = '▶ Lecture…';
    recorder.startPlayback((p) => {
      if (p === 0) $('#btn-playtake').textContent = '▶ Réécouter';
    });
  });
  $('#btn-save-score').addEventListener('click', () => {
    const bpm = +$('#bpm').value || 100;
    const quantized = recorder.toScore(bpm);
    if (!quantized.notes.length) return;
    const name = prompt('Nom de la partition :', `Prise ${new Date().toLocaleTimeString('fr-FR')}`);
    if (name === null) return;
    store.add({ name: name || 'Sans titre', notes: quantized.notes, bpm, source: 'prise' });
    renderScoresList();
    switchTab('scores');
  });
  UI.setRecUI(false);
  UI.updateTake(recorder);
}

function switchTab(tab) {
  const btn = $(`#tabs [data-tab="${tab}"]`);
  if (btn) btn.click();
}

// ---------- Partitions ----------
function initComposer() {
  // Remplit le sélecteur de notes (Do2 → Si5)
  const sel = $('#composer-note');
  sel.innerHTML = '';
  for (let midi = 36; midi <= 83; midi++) {
    const opt = document.createElement('option');
    opt.value = midi;
    opt.textContent = `${midiToName(midi)} · ${midiToFreq(midi).toFixed(1)} Hz`;
    sel.appendChild(opt);
  }
  sel.value = 60;

  $('#btn-add-note').addEventListener('click', () => {
    const midi = +sel.value;
    const dur = +$('#composer-dur').value;
    composerNotes.push({ midi, name: midiToName(midi), freq: +midiToFreq(midi).toFixed(2), dur });
    refreshComposer();
  });

  $('#btn-add-rest').addEventListener('click', () => {
    composerNotes.push({ rest: true, dur: +$('#composer-dur').value });
    refreshComposer();
  });

  $('#btn-new-score').addEventListener('click', () => {
    composerNotes = [];
    $('#score-name').value = '';
    refreshComposer();
  });

  $('#bpm').addEventListener('input', e => $('#bpm-val').textContent = `${e.target.value} BPM`);

  $('#btn-play-score').addEventListener('click', () => {
    if (!composerNotes.length) return alert('Ajoutez des notes à la partition d’abord !');
    const score = { name: $('#score-name').value || 'Brouillon', notes: composerNotes, bpm: +$('#bpm').value };
    const staffEl = renderStaff($('#composer-preview'), score.notes);
    scorePlayer.play(score, staffEl, {
      onNote: (n) => { $('#score-now-playing').textContent = `♪ ${n.name} — ${n.freq.toFixed(1)} Hz`; UI.flashKey(n.midi); },
      onProgress: (p) => $('#score-progress-bar').style.width = `${p * 100}%`,
      onState: (run) => { $('#btn-stop-score').disabled = !run; $('#btn-play-score').disabled = run; },
      onEnd: () => { $('#score-now-playing').textContent = 'Terminé ✔'; $('#score-progress-bar').style.width = '0%'; },
    });
  });

  $('#btn-stop-score').addEventListener('click', () => {
    scorePlayer.stop();
    $('#btn-stop-score').disabled = true;
    $('#btn-play-score').disabled = false;
    $('#score-progress-bar').style.width = '0%';
    $('#score-now-playing').textContent = 'Arrêté';
  });

  $('#btn-export-score').addEventListener('click', () => {
    const score = currentEditableOrSelected();
    if (!score) return;
    const blob = new Blob([JSON.stringify(score, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (score.name || 'partition').replace(/\s+/g, '_') + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  refreshComposer();
}

function currentEditableOrSelected() {
  if (composerNotes.length) return { name: $('#score-name').value || 'Brouillon', notes: composerNotes, bpm: +$('#bpm').value };
  return selectedScoreId ? store.get(selectedScoreId) : null;
}

function refreshComposer() {
  const wrap = $('#composer-preview');
  if (!composerNotes.length) {
    wrap.innerHTML = '<p class="text-xs text-slate-500 italic">Partition vide — ajoutez des notes ou enregistrez une prise.</p>';
    return;
  }
  renderStaff(wrap, composerNotes);
}

function renderScoresList() {
  const list = $('#scores-list');
  list.innerHTML = '';
  if (!store.scores.length) {
    list.innerHTML = '<p class="text-sm text-slate-500 italic">Aucune partition sauvegardée. Enregistrez une prise ou créez-en une ici même.</p>';
    return;
  }
  store.scores.forEach(sc => {
    const div = document.createElement('div');
    div.className = 'score-item' + (sc.id === selectedScoreId ? ' selected' : '');
    div.innerHTML = `
      <div class="flex items-center justify-between gap-3 flex-wrap mb-2">
        <div>
          <b class="text-sm">${sc.name}</b>
          <span class="badge ml-2">${sc.notes.filter(n=>!n.rest).length} notes · ${sc.bpm} BPM</span>
          <span class="text-[10px] text-slate-500 ml-2">${new Date(sc.createdAt).toLocaleString('fr-FR')}</span>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary text-xs py-1" data-act="play">▶ Jouer</button>
          <button class="btn btn-ghost text-xs py-1" data-act="edit">✎ Éditer</button>
          <button class="btn btn-danger text-xs py-1" data-act="del">🗑</button>
        </div>
      </div>
      <div class="staff-wrap card-inner"></div>`;
    const staffWrap = div.querySelector('.staff-wrap');
    renderStaff(staffWrap, sc.notes, { colWidth: 34 });

    div.querySelector('[data-act="play"]').addEventListener('click', () => {
      selectedScoreId = sc.id;
      renderScoresList();
      const staffEl = staffWrap.querySelector('.staff');
      scorePlayer.play(sc, staffEl, {
        bpm: sc.bpm,
        onNote: (n) => { $('#score-now-playing').textContent = `♪ ${sc.name} — ${n.name}`; UI.flashKey(n.midi); },
        onProgress: (p) => $('#score-progress-bar').style.width = `${p * 100}%`,
        onState: (run) => { $('#btn-stop-score').disabled = !run; $('#btn-play-score').disabled = run; },
        onEnd: () => { $('#score-progress-bar').style.width = '0%'; $('#btn-play-score').disabled = false; $('#btn-stop-score').disabled = true; },
      });
    });

    div.querySelector('[data-act="edit"]').addEventListener('click', () => {
      composerNotes = JSON.parse(JSON.stringify(sc.notes));
      $('#score-name').value = sc.name;
      $('#bpm').value = sc.bpm;
      $('#bpm-val').textContent = `${sc.bpm} BPM`;
      refreshComposer();
      $('#score-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    div.querySelector('[data-act="del"]').addEventListener('click', () => {
      if (!confirm(`Supprimer « ${sc.name} » ?`)) return;
      store.remove(sc.id);
      renderScoresList();
    });

    list.appendChild(div);
  });
}

// ---------- Init ----------
window.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSynthControls();

  const sharedOpts = {
    octave: +$('#octave').value,
    onNoteOn: (midi, freq) => {
      recorder.onNoteOn(midi, freq);
      showLiveNotes([{ midi, freq }]);
    },
    onNoteOff: (midi) => {
      recorder.onNoteOff(midi);
      setTimeout(() => {
        const f = engine.getActiveNotes();
        showLiveNotes(f.map(fr => ({ midi: -1, freq: fr })));
      }, 30);
    },
  };

  pianoMain = new PianoUI($('#keyboard'), sharedOpts);
  pianoRec = new PianoUI($('#keyboard-rec'), {});
  // Le piano "rec" doit aussi déclencher l'enregistreur via les touches physiques :
  // PhysicalKeyboard appelle triggerOn sur tous les pianos ; on branche le callback du second :
  pianoRec.opts = sharedOpts;

  new PhysicalKeyboard([pianoMain, pianoRec]);

  buildFreqTable(+$('#octave').value);

  scopeCanvas = $('#scope');
  scopeCtx = scopeCanvas.getContext('2d');
  window.addEventListener('resize', resizeScope);
  resizeScope();
  drawScope();
  setInterval(pollLiveNotes, 200);

  initRecorder();
  initComposer();
  renderScoresList();

  // Débloque l'AudioContext au premier clic n'importe où
  window.addEventListener('pointerdown', () => engine.ensureContext(), { once: true });
});
