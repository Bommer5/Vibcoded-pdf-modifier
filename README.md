# Feuillet

Éditeur de PDF, documents et images pour **Windows**, **Linux** et **Android**, pensé
pour les tablettes graphiques (Wacom, XP-Pen, Huion, Windows Ink, stylets Android…).

## Outils

- **Stylo** sensible à la pression, traits pleins, en tirets ou en pointillés ; ligne droite avec Maj
- **Surligneur**, **gomme** (partielle ou trait entier ; le bout gomme du stylet est reconnu)
- **Formes** : ligne, flèche, rectangle, ellipse, triangle
- **Texte** façon Word. Avec l'outil Texte : un **clic** crée un texte, un **glisser** crée une zone
  rectangulaire, et **entourer une zone à main levée** fait épouser au texte la forme dessinée
- **Tableaux** (double-clic sur une cellule, Tab pour passer à la suivante) et **graphiques**
  (barres, courbes, secteurs, radar…, données collables depuis Excel)

## Formats

| | Ouvrir / insérer | Exporter |
|---|---|---|
| PDF | ✅ (texte d'origine conservé à l'export) | ✅ vectoriel |
| Projet Feuillet `.feuillet` | ✅ | ✅ (tout reste modifiable) |
| Images | PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, TIFF, PSD, SVG | PNG, JPEG, WebP, TIFF, SVG |
| Word, Excel, PowerPoint, OpenDocument, RTF, Pages, Keynote, Visio, EPUB… | ✅ via LibreOffice¹ | .docx, .odt, .odg, .rtf, .doc |
| Xournal / Xournal++ | .xoj, .xopp | — |
| Texte | .txt, .md, .csv, .json… | — |

¹ LibreOffice (gratuit) doit être installé. Sans lui, un .docx s'ouvre en texte seul.
Voir [docs/RESEARCH.md](docs/RESEARCH.md) pour les choix techniques.

> Nom provisoire. Voir [docs/ROADMAP.md](docs/ROADMAP.md) pour l'avancement.

## Démarrer

```bash
npm install
npm run dev          # lance l'application en mode développement
npm run typecheck    # vérification TypeScript
npm run dist:linux   # AppImage + .deb dans release/
npm run dist:win     # installeur + portable Windows dans release/
npm run build:web    # version navigateur / mobile dans out/web
npm run android:sync # met à jour le projet Android (puis npm run android:open)
xvfb-run -a npm run test:e2e   # tests de bout en bout (Linux sans écran)
```

La CI GitHub Actions (`docs/ci/build.yml`, à copier dans `.github/workflows/`) construit à chaque push l'AppImage, le .deb, l'installeur Windows et l'APK Android.

## Raccourcis (par défaut)

| Action | Touche |
|---|---|
| Zoom avant / arrière (sur le pointeur) | `+` / `-`, Ctrl+molette |
| Ajuster à la page | Ctrl+0 |
| Déplacer la vue | Espace maintenu, outil Main (H), clic molette |
| Annuler / Rétablir | Ctrl+Z / Ctrl+Maj+Z ou Ctrl+Y |
| Sélection / Stylo / Surligneur / Gomme | V / P / S / E |
| Formes / Texte / Main | R / T / H |
| Ligne droite (stylo, surligneur) | Maj, ou stylet immobile en fin de trait |
| Gras / Italique / Souligné (en écrivant) | Ctrl+B / Ctrl+I / Ctrl+U |
| Ouvrir / Insérer / Enregistrer / Exporter | Ctrl+O / Ctrl+I / Ctrl+S / Ctrl+E |
| Copier / Couper / Coller (sous le pointeur) | Ctrl+C / Ctrl+X / Ctrl+V |
| Dupliquer / Tout sélectionner | Ctrl+D / Ctrl+A |
| Grouper / Dégrouper | Ctrl+G / Ctrl+Maj+G |
| Premier plan / Arrière-plan | Ctrl+Maj+] / Ctrl+Maj+[ |
| Déplacer la sélection | Flèches (Maj = ×10) |
| Nouvelle page A4 | Ctrl+N |
| Supprimer | Suppr |

## Architecture

```
src/main/          processus principal Electron (fichiers, LibreOffice)
src/preload/       pont sécurisé vers l'interface (contextIsolation + sandbox)
src/renderer/      interface (identique sur PC, Android, navigateur)
  src/core/        document, vue, historique, raccourcis, édition, ressources
  src/io/          import / export de tous les formats
  src/platform/    accès système : Electron, Capacitor (mobile), navigateur
  src/ui/          boîtes de dialogue
android/           projet Android (Capacitor)
tests/e2e/         tests de bout en bout
```
