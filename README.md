# 🎹 Fréquence Studio

Application web (HTML + Tailwind CSS + JavaScript vanilla) pour **jouer de la musique avec les touches du clavier**, **enregistrer les sons** et **créer des partitions**. Les sons sont générés en temps réel par la **Web Audio API** (`OscillatorNode`) à partir des fréquences réelles des notes (tempérament égal, La4 = 440 Hz).

## Lancer l'application

Aucun build nécessaire :

```bash
# Option 1 : ouvrir directement index.html dans un navigateur
# Option 2 : petit serveur local
python3 -m http.server 8000
# puis http://localhost:8000
```

## Fonctionnalités

### 🎹 Onglet « Jouer »
- Piano à l'écran (clics / tactile) + jeu au clavier physique.
- Synthé réglable : forme d'onde (sinus, triangle, carré, dent de scie), volume, attaque, relâchement, octave (2→6, ou touches `-` / `+`).
- Visualiseur temps réel : oscilloscope + spectre de fréquence (`AnalyserNode`).
- Affichage des notes actives avec leur fréquence en Hz + table de correspondance touche → note → fréquence.

### 🔴 Onglet « Enregistrer »
- Enregistrement horodaté des notes (début/fin, fréquence, nom).
- Rouleau de piano dessiné sur `<canvas>` + journal détaillé.
- Réécoute fidèle de la prise, puis conversion **quantifiée** en partition sauvegardée.

### 🎼 Onglet « Partitions »
- Compositeur manuel (note, durée : croche → ronde, silences).
- Rendu sur portée (clé de sol, dièses, lignes supplémentaires, note creuse/pleine selon la durée).
- Lecture synchronisée avec surlignage des notes et barre de progression, tempo réglable (BPM).
- Sauvegarde automatique en `localStorage`, édition, suppression, export JSON.

## Mapping clavier

| Touche | Note        | Touche | Note |
|--------|-------------|--------|------|
| A      | Do          | S      | Do♯  |
| Z / W  | Ré          | D      | Ré♯  |
| E      | Mi          | G      | Fa♯  |
| R / F  | Fa          | H      | Sol♯ |
| T      | Sol         | J      | La♯  |
| Y      | La          | O      | —    |
| U      | Si          | P      | Do+1 |

`-` / `+` : changer d'octave.

## Structure

```
index.html        — interface (3 onglets), Tailwind via CDN
css/style.css     — styles complémentaires (piano, portée, animations)
js/audio.js       — moteur Web Audio (fréquences, enveloppes, analyseur)
js/keyboard.js    — piano écran + clavier physique (AZERTY/QWERTY)
js/recorder.js    — enregistreur horodaté, rouleau de piano, quantification
js/score.js       — partitions : rendu portée, stockage, lecteur
js/app.js         — câblage UI, onglets, visualiseur
```

## Formule des fréquences

```
f(n) = 440 × 2^((n − 69) / 12)   où n = numéro MIDI (La4 = 69 = 440 Hz)
```

## 🎹 Piano complet & manette Xbox 360 / XInput

- **Piano de concert 88 touches** (La0 → Do8, MIDI 21–108) affiché dans l'onglet *Jouer* — chaque touche est jouable à la souris.
- Le clavier physique reste une **fenêtre mobile de 2 octaves** (curseur d'octave 1→6, touches `A Z E R T Y U I O P` + dièses `S D G H J L M`).
- **Onglet 🎮 Manette Xbox** : support natif de l'API Gamepad (mapping « standard » = XInput / Xbox 360 sous Windows). Détection à chaud, journal de connexion, schéma du contrôleur et tableau de configuration des touches.

### Mapping manette (Xbox 360 / XInput)
| Touche | Action |
|---|---|
| Stick gauche ↕ / Croix ↑↓ | Fenêtre d'octave ± (1→6) |
| Stick droit ↔ | Mélodie diatonique continue sur la fenêtre |
| Croix ↑ / → / ↓ / ← | Accords majeur · 7ᵉ dominante · mineur · mineur 7ᵉ |
| LB ou RT (maintenu) | Mode ♯ (tout en dièses) |
| B / X (maintenus) | Glissando demi-tonal montant / descendant |
| RB / LT | Quinte / quarte au-dessus de la note courante |
| A / Y | Octave − / + |
| Start | Balayage des 88 touches |
| Back | Coupe toutes les voix |

> 💡 Sous Windows, les manettes Xbox 360 et compatibles XInput sont exposées automatiquement par le navigateur (aucun pilote supplémentaire). Sur Mac/Linux, un adaptateur ou une manette en mapping « standard » fonctionne également.
