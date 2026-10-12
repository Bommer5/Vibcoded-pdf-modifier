# Feuillet

Éditeur de PDF, documents et images pour **Windows** et **Linux**, pensé pour les
tablettes graphiques (Wacom, XP-Pen, Huion, Windows Ink…).

> Nom provisoire. Voir [docs/ROADMAP.md](docs/ROADMAP.md) pour l'avancement.

## Démarrer

```bash
npm install
npm run dev          # lance l'application en mode développement
npm run typecheck    # vérification TypeScript
npm run dist:linux   # AppImage + .deb dans release/
npm run dist:win     # installeur + portable Windows dans release/
```

## Raccourcis (par défaut)

| Action | Touche |
|---|---|
| Zoom avant / arrière (sur le pointeur) | `+` / `-`, Ctrl+molette |
| Ajuster à la page | Ctrl+0 |
| Déplacer la vue | Espace maintenu, outil Main (H), clic molette |
| Annuler / Rétablir | Ctrl+Z / Ctrl+Maj+Z ou Ctrl+Y |
| Sélection / Stylo / Main | V / P / H |
| Nouvelle page A4 | Ctrl+N |
| Supprimer | Suppr |

## Architecture

```
src/main/       processus principal Electron (fenêtres, fichiers)
src/preload/    pont sécurisé vers l'interface (contextIsolation + sandbox)
src/renderer/   interface : canevas Fabric.js, outils, vue
  src/core/     document, vue (zoom/déplacement), historique, raccourcis
```
