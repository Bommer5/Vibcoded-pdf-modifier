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
| Icônes seules incompréhensibles au début, outils mal rangés | Libellé sous chaque outil, outils courants en premier, lasso et main à la fin |
| Défilement au pavé tactile peu fiable, document « perdu » | Défilement à deux doigts regroupé par image, pincement = zoom, vue toujours sur le document |
| Outils PDF incompris (« ça ne marche pas », « ça entoure tout seul ») | Noms explicites (Annoter PDF, Modifier PDF), intitulé « PDF », encadré au survol avec l'action, bande d'aide, grisés sans PDF avec le bon raccourci (« Écrire du texte ») |
| On pouvait écrire hors de la page (rien n'y est exporté) | Écriture limitée aux pages : curseur « interdit » dehors, traits coupés au bord, formes et tableaux gardés dans la page |
| Sur téléphone, seules les formes rectangulaires étaient accessibles | Choix de la forme et du remplissage dans la barre rapide |
| Texte de PDF modifié : autre police, lignes fusionnées, retrait et justification perdus, texte en double | Police d'origine reconstruite depuis les glyphes du PDF, paragraphe reconstruit caractère par caractère (retrait, justification, interligne, gras), texte d'origine retiré ou recouvert, suite de la colonne décalée si le paragraphe change de taille — testé : rendu avant/après identique à 1 % près |
| Texte scanné ou en image impossible à modifier | OCR sur l'appareil (Tesseract, français), police du scan devinée par comparaison des formes, texte d'origine recouvert de la couleur du fond |
| Astuces envahissantes | Affichées au début, fermées pour de bon par « Compris » ; panneau Page à la place |
| PDF inséré au mauvais format (paysage / portrait) | Dialogue : image redimensionnable, pages au format du PDF ou du document, choix des pages |

## 3. Ce qui reste faible (à traiter)

Corrigé depuis la version précédente de cet audit : polices réelles intégrées au PDF
(sous-ensembles TrueType, plus de Helvetica), PDF modifiable ≈ 1,3× l'original au lieu
de 2×, impression testée automatiquement, interface téléphone, PDF protégés par mot de
passe, barre de mise en forme du texte façon Word (listes, niveaux, espacement des
paragraphes).

- **Modification du texte d'origine** : un caractère absent de la police du PDF (sous-ensemble)
  est écrit avec la police la plus proche ; le crénage d'origine n'est pas repris (écarts
  d'un demi-point au plus) ; le texte tourné n'est pas pris en charge ; un objet texte du PDF
  à cheval sur deux paragraphes est recouvert (il reste dans le PDF, invisible) ; un
  paragraphe qui s'allonge ne passe pas à la page suivante.
- **Mise en forme du texte** : l'interligne, l'alignement et l'espacement des paragraphes
  s'appliquent à toute la zone de texte (Word les règle paragraphe par paragraphe). Pas de
  tabulations ni de retraits de première ligne. Les listes sont du texte (puce + espace
  insécable) : elles s'exportent partout, mais le .docx reçoit des puces tapées, pas des
  listes Word natives.
- **OCR** : la police du scan est choisie parmi les polices courantes (pas la police exacte
  si elle est rare) ; le texte d'origine est recouvert de la couleur du fond (un fond très
  texturé laisse voir le rectangle) ; l'OCR se lance page par page. Sur une page penchée ou
  un texte clair sur fond sombre, la police devinée est parfois une voisine (Segoe UI pour
  Arial, Times gras pour Arial) ; le texte, lui, est exact.
- **Mémoire de base d'Electron** : environ 150 Mo par processus (incompressible avec
  Electron). Tauri serait plus léger, mais moins homogène entre Windows, Linux et Android.
- **Historique** : les changements de calques (masquer, renommer) ne sont pas annulables.

## 4. Vérifications automatiques

- `npm run test:e2e` : application complète pilotée comme par un humain (souris, clavier).
  **347 vérifications** : formats, outils, fonctions essentielles, fichiers, qualité du
  PDF, impression, finitions, mise en forme du texte façon Word, sélection d'objets
  superposés, insertion de PDF, modification fidèle du texte d'un PDF (LibreOffice et
  Chrome : polices Type 3 en morceaux, CID TrueType, texte mis à l'échelle), OCR, élan de la main, import d'une partie d'un PDF ou d'une image (cadrage, export
  limité à la zone, rognage ensuite).
- `tests/e2e/ocr-bench.cjs` (inclus) : banc d'essai de l'OCR sur 20 pages « scannées » au
  texte connu (polices, 8 à 36 pt, gras, italique, symboles, majuscules accentuées, 100 à
  300 ppp, JPEG bruité, flou, page penchée, couleurs, texte clair sur fond sombre, deux
  colonnes, photo, document de trois pages). Taux d'erreur par caractère moyen : 0,05 %
  (pire cas : JPEG bruité, 0,9 %) ; police, taille, gras, italique et couleur retrouvés ;
  environ 1 s par page. Le tableau détaillé est écrit dans `ocr-bench.md`.
- `npm run test:mobile` : **17 vérifications** sur un téléphone simulé (Pixel 7, tactile).
- `node tests/bench.mjs` : comparaison chiffrée entre le Rust et le JavaScript.
- `xvfb-run -a node tests/e2e/perf.cjs . out` : ouverture, défilement, annulation, mémoire.
