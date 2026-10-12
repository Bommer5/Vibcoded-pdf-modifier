# Feuillet

Éditeur de PDF, documents et images pour **Windows**, **Linux** et **Android**, pensé
pour les tablettes graphiques (Wacom, XP-Pen, Huion, Windows Ink, stylets Android…).

## Points forts

- **Léger et rapide** : un PDF de 100 pages s'ouvre en 0,13 s. Seules les pages visibles sont
  rendues, par **PDFium** (le moteur PDF de Chrome, en C++ compilé en WebAssembly) dans un fil
  séparé. Les calculs lourds (gomme, formes, TIFF) passent par un **noyau natif en Rust**.
  Voir [docs/AUDIT.md](docs/AUDIT.md).
- **Modifier le texte d'un PDF** : double-clic sur un paragraphe. L'ancien texte est réellement
  supprimé, pas caché.
- **Ctrl+S enregistre dans le PDF ouvert**. Il reste lisible partout, et Feuillet le rouvre
  entièrement modifiable.
- **Recherche** (Ctrl+F), **sélection / copie du texte**, **surligneur aimanté aux lignes**,
  souligner, barrer.
- **Pages** (miniatures, réordonner, dupliquer, aller à la page), **sommaire**, **calques**.
- **Sauvegarde automatique** et récupération après plantage, fichiers récents, impression.

## Outils

- **Stylo** sensible à la pression, traits pleins, en tirets ou en pointillés ; ligne droite avec Maj
- **Surligneur**, **gomme** (partielle ou trait entier ; le bout gomme du stylet est reconnu)
- **Formes** : ligne, flèche, rectangle, ellipse, triangle, vide ou remplie — choix direct dans la
  barre rapide (aussi sur téléphone)
- **On écrit sur les pages, pas à côté** : hors d'une page, les outils d'écriture affichent un
  curseur « interdit » ; un trait qui sort de la page est coupé au bord, une forme s'y arrête
- **Texte** façon Word. Avec l'outil Texte : un **clic** crée un texte, un **glisser** crée une zone
  rectangulaire, et **entourer une zone à main levée** fait épouser au texte la forme dessinée.
  Une **barre de mise en forme** apparaît au-dessus de la page, rangée comme l'onglet Accueil de
  Word : *Police* (police, taille tapable, A+ / A−, effacer la mise en forme) · *Caractères*
  (gras, italique, souligné, barré, indice, exposant, couleur ▾, surlignage ▾) · *Paragraphe*
  (puces ▾ et numérotation ▾ avec bibliothèque de styles et niveaux, alignements, menu
  « Interligne et espacement » ▾ : interligne et **espace entre paragraphes / éléments de liste**).
  Comme dans Word, curseur dans un mot = tout le mot ; Entrée continue la liste, Entrée sur un
  élément vide la termine, Tab / Maj+Tab change de niveau, les numéros se recalculent seuls
- **Barre d'outils claire** : chaque outil a son nom sous l'icône, rangés par usage (Sélection,
  Stylo, Surligneur, Gomme, Texte, Formes, Image, Tableau, Graphique, puis « PDF » : Annoter PDF et
  Modifier PDF, enfin Lasso et Main). Les outils PDF s'expliquent sur place : au survol, le mot ou le
  paragraphe concerné s'encadre avec ce qui va se passer ; sans PDF, ils sont grisés et disent pourquoi
- **Pavé tactile** : glisser à deux doigts déplace la vue dans tous les sens, pincer zoome sur le
  pointeur ; la vue ne peut plus « perdre » le document
- **Panneau Page** (rien de sélectionné) : format (A4, A5, A3, Lettre), portrait / paysage, fond
  (uni, ligné, carreaux…), ajouter une page. Les astuces s'affichent au début et se ferment d'un clic
- **Prendre et déplacer sans dessiner par erreur** : avec le stylo, un simple toucher sur une
  image, un texte ou une forme la sélectionne, et un appui dans la sélection la déplace (on ne
  trace que sur le vide). Après une insertion, l'outil Sélection revient tout seul. Bouton
  latéral du stylet maintenu = lasso temporaire
- **Objets superposés** : un trait se prend sur son tracé, pas sur son cadre ; **Alt+clic** prend
  l'objet du dessous ; **clic droit** liste tous les objets sous le pointeur (survol = aperçu) avec
  les commandes usuelles et **Verrouiller** (l'objet ne se prend plus au clic)
- **Insérer un PDF** dans un document : comme **image** sur la page (déplaçable, redimensionnable,
  et toujours vectorielle à l'export), ou en **nouvelles pages** au format du PDF ou du document
  (portrait dans un document paysage sans déformation), avec choix des pages et de la position
- **Lasso** (L), **reconnaissance de formes** (gardez le stylet immobile en fin de tracé),
  **barre rapide** : tailles fin / moyen / épais, `[` et `]`, couleurs favorites
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
npm run build:native # recompile le noyau Rust (rustup target add wasm32-unknown-unknown)
node tests/bench.mjs # mesure Rust contre JavaScript
npm run android:sync # met à jour le projet Android (puis npm run android:open)
xvfb-run -a npm run test:e2e   # tests de bout en bout (Linux sans écran)
```

La CI GitHub Actions (`.github/workflows/build.yml`) construit à chaque push l'AppImage, le .deb, l'installeur Windows et l'APK Android.

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
| Gauche / Centré / Droite / Justifié | Ctrl+L / Ctrl+E / Ctrl+R / Ctrl+J |
| Taille de police + / − | Ctrl+Maj+> / Ctrl+Maj+< (ou Ctrl+] / Ctrl+[) |
| Exposant / Indice | Ctrl+Maj++ / Ctrl+= |
| Liste à puces / niveau de liste | Ctrl+Maj+L / Tab, Maj+Tab |
| Effacer la mise en forme | Ctrl+Espace |
| Lasso / Sélection de texte / Modifier le texte du PDF | L / X / M (ou double-clic) |
| Objet du dessous / liste des objets sous le pointeur | Alt+clic / clic droit |
| Saisir n'importe quel objet avec le stylo | Ctrl + appui |
| Rechercher / Aller à la page | Ctrl+F / G ou Ctrl+Maj+N |
| Page suivante / précédente / début / fin | Pg. suiv. / Pg. préc. / Début / Fin |
| Taille du trait | [ et ] |
| Enregistrer / Enregistrer sous / Imprimer | Ctrl+S / Ctrl+Maj+S / Ctrl+P |
| Panneau pages, sommaire, calques / Plein écran | F9 / F11 |
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
native/feuillet-core/  noyau natif en Rust (WebAssembly) : gomme, formes, lasso, TIFF
src/renderer/      interface (identique sur PC, Android, navigateur)
  src/pdf/         moteur PDF (PDFium/WASM dans un worker), texte, modification
  src/core/        document, vue, historique, raccourcis, édition, ressources
  src/io/          import / export de tous les formats
  src/platform/    accès système : Electron, Capacitor (mobile), navigateur
  src/ui/          boîtes de dialogue
android/           projet Android (Capacitor)
tests/e2e/         tests de bout en bout
```
