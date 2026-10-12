# Autocritique et performances

Ce document dit franchement ce qui n'allait pas dans les versions précédentes, ce
qui a été corrigé (mesures à l'appui) et ce qui reste faible. Mesures :
`tests/e2e/perf.cjs` (PDF de 100 pages) et `tests/bench.mjs` (Rust contre JavaScript).

## 1. Ce qui était mal fait, et ce qui a été corrigé

| Défaut | Pourquoi c'était mauvais | Correction | Résultat mesuré |
|---|---|---|---|
| Toutes les pages d'un PDF rendues en image haute définition dès l'ouverture | 100 pages = 20 s d'attente et des centaines de Mo d'images, même pour lire la page 1 | Pages « légères » : le fond est une simple description. **Rendu à la demande** des seules pages visibles, à la résolution du zoom, file « dernière demandée d'abord », budget mémoire et libération des pages anciennes | Ouverture : **21,8 s → 0,13 s**. Mémoire après ouverture : **762 → 568 Mo** (processus compris) |
| pdf.js (JavaScript) pour le rendu, dans le fil de l'interface | Lent sur les pages complexes, l'interface gèle pendant le rendu | **PDFium** (C++, moteur de Chrome) compilé en WebAssembly, dans un **worker** | Interface fluide pendant le rendu ; pdf.js supprimé |
| Historique : copie JSON de **tout** le document à chaque trait | Coût proportionnel à la taille du document, à chaque geste ; annuler rechargeait tout | Historique **incrémental** : seuls les objets modifiés sont sérialisés, une étape ne stocke que la différence, annuler ne recrée que ces objets | Annulation : **61 → 13 ms** sur 100 pages |
| Toutes les bibliothèques chargées au démarrage | Démarrage lent, mémoire gaspillée pour des fonctions rarement utilisées | Export PDF, Word, TIFF, PSD et ZIP chargés **à la demande** | Code initial : **3,6 Mo → 570 Ko** |
| Gomme et décodage TIFF en JavaScript | Gomme saccadée sur les longs traits ; un scan A4 mettait près d'une demi-seconde | Noyau **Rust → WebAssembly** (`native/feuillet-core`), avec repli JavaScript | Gomme **×12**, TIFF LZW **×4**, TIFF fax G4 **×13** ; pixels identiques vérifiés |
| Rejet rapide absent dans la gomme | Chaque mouvement testait tous les points de tous les traits | Test de la boîte englobante d'abord | La plupart des traits sont écartés en O(1) |
| Fonds « papier » (lignes, carreaux) en images PNG | Flous au zoom, lourds dans le projet | Dessinés en **vectoriel** (écran, SVG, PDF) | Nets à tout zoom, 0 octet dans le projet |
| Export PDF d'une page-image : image recompressée | Perte de qualité, fichier plus gros | Image d'origine intégrée **telle quelle** | Sans perte |
| Fabric 7 : objets positionnés par leur centre | Tableaux et formes décalés | Origine ramenée au coin haut-gauche pour tout le projet | Tests de position au vert |
| Ctrl+G en conflit (« Grouper » et « Aller à la page ») | Le raccourci « Aller à la page » ne marchait pas | « Aller à la page » = G ou Ctrl+Maj+N | Testé |
| Justification : la dernière ligne était étirée | Mots écartés sur toute la largeur, laid | Comme Word : justifié sauf la dernière ligne | Testé |
| Le presse-papiers perdait ses images en ouvrant un autre document | Coller ensuite donnait une image vide | Les ressources du presse-papiers sont conservées | — |
| `confirm()` à l'ouverture même pour un document déjà enregistré | Question inutile | L'état « non enregistré » est suivi précisément | Titre « • » quand il y a des modifications |

**Mesure finale** (PDF de 100 pages, après défilement de tout le document) : mémoire JavaScript
**10 Mo**, cache des pages rendues **4 Mo**, ouverture **0,15 s**, annulation **13 ms**.

## 2. Défauts des autres outils, et ce que fait Feuillet

| Critique relevée | Outil | Réponse de Feuillet |
|---|---|---|
| Sélectionner puis déplacer ou copier est pénible ; le collage crée un cadre bizarre | Xournal++ | Un seul modèle d'objets ; collage **sous le pointeur**, déjà sélectionné ; lasso qui sélectionne puis déplace |
| Le PDF doit rester à côté du carnet, sinon le fond disparaît | Xournal++ | **PDF modifiable** : Ctrl+S réécrit le PDF ; lisible partout, et Feuillet y retrouve tout modifiable |
| Le surligneur ne s'aligne pas sur le texte ; surligner plusieurs lignes est fastidieux | GoodNotes (demande n°1) | Surligneur **aimanté aux lignes** du PDF ; un trait vertical surligne tout le passage |
| Impossible de rechercher dans un PDF (converti en images) | OneNote | Recherche Ctrl+F, insensible aux accents et à la casse |
| Impossible de modifier le texte d'origine (ou en le masquant seulement) | La plupart des éditeurs gratuits | Double-clic → texte modifiable ; l'ancien texte est **réellement supprimé** du PDF |
| Lenteur et mémoire excessive sur les gros PDF | Zotero, divers | Rendu paresseux, budget mémoire, moteur natif |
| Perte de travail après un plantage | Divers | Sauvegarde automatique (45 s et à la mise en arrière-plan) + proposition de restauration |
| Pas de marge pour écrire | PDF Expert, Adobe Reader | Pages libres : ajouter une page lignée ou quadrillée n'importe où, déborder de la page |

## 2 bis. Retours d'utilisateurs pris en compte (interface)

Synthèse des critiques récurrentes (forums Xournal++, GoodNotes, OneNote, Acrobat, PDF-XChange,
Figma, Inkscape) et réponse apportée :

| Critique | Réponse dans Feuillet |
|---|---|
| « Je voulais déplacer, ça a dessiné » | Toucher = sélectionner un objet ; appui dans la sélection = déplacer ; retour automatique à Sélection après insertion ; bouton du stylet = lasso |
| Le cadre d'un trait en diagonale « vole » les clics | Test au tracé (tolérance 6 px) pour traits et formes sans fond |
| Impossible de prendre l'objet du dessous | Alt+clic (cycle), clic droit = liste des objets superposés avec aperçu, verrouillage |
| Icônes emoji, incohérentes selon le système | Jeu d'icônes Lucide homogène, info-bulles nom + raccourci réel, couleur du stylo sur son bouton |
| Fonctions cachées | Barre d'état : gestes de l'outil actif ; menu clic droit complet |
| PDF inséré au mauvais format (paysage / portrait) | Dialogue : image redimensionnable, pages au format du PDF ou du document, choix des pages |

## 3. Ce qui reste faible (à traiter)

Corrigé depuis la version précédente de cet audit : polices réelles intégrées au PDF
(sous-ensembles TrueType, plus de Helvetica), PDF modifiable ≈ 1,3× l'original au lieu
de 2×, impression testée automatiquement, interface téléphone, PDF protégés par mot de
passe, barre de mise en forme du texte façon Word (listes, niveaux, espacement des
paragraphes).

- **Modification du texte d'origine** : la police exacte n'est pas réutilisée quand elle
  n'est pas installée (on prend la plus proche). Les mises en page complexes (colonnes
  imbriquées, texte tourné) ne sont pas regroupées parfaitement en paragraphes.
- **Mise en forme du texte** : l'interligne, l'alignement et l'espacement des paragraphes
  s'appliquent à toute la zone de texte (Word les règle paragraphe par paragraphe). Pas de
  tabulations ni de retraits de première ligne. Les listes sont du texte (puce + espace
  insécable) : elles s'exportent partout, mais le .docx reçoit des puces tapées, pas des
  listes Word natives.
- **Mémoire de base d'Electron** : environ 150 Mo par processus (incompressible avec
  Electron). Tauri serait plus léger, mais moins homogène entre Windows, Linux et Android.
- **Historique** : les changements de calques (masquer, renommer) ne sont pas annulables.

## 4. Vérifications automatiques

- `npm run test:e2e` : application complète pilotée comme par un humain (souris, clavier).
  **155 vérifications** : formats, outils, fonctions essentielles, fichiers, qualité du
  PDF, impression, finitions, mise en forme du texte façon Word, sélection d'objets
  superposés, insertion de PDF.
- `npm run test:mobile` : **15 vérifications** sur un téléphone simulé (Pixel 7, tactile).
- `node tests/bench.mjs` : comparaison chiffrée entre le Rust et le JavaScript.
- `xvfb-run -a node tests/e2e/perf.cjs . out` : ouverture, défilement, annulation, mémoire.
