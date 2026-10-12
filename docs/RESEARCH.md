# Recherche : briques open source et limites techniques

Pour chaque point difficile, on a regardé ce qui existe déjà en open source,
retenu ce qui marche le mieux, puis vérifié le résultat par des tests
automatiques (`npm run test:e2e`).

**Règle de licence.** L'application doit pouvoir être vendue. On n'intègre donc que du
code sous licence permissive : MIT, BSD, Apache, ISC. Les logiciels sous licence MPL ou
LGPL ne sont utilisés que comme programmes externes ou modules séparés. Le code des
projets GPL ou AGPL (Xournal++, MuPDF…) sert uniquement **d'inspiration** : on
réimplémente, on ne copie pas.

## 1. Afficher les PDF

| Option | Licence | Verdict |
|---|---|---|
| pdf.js (Mozilla, moteur de Firefox) | Apache 2.0 | Utilisé au début, **remplacé** : JavaScript, plus lent, gèle l'interface |
| MuPDF / mupdf.js | AGPL ou licence payante | ❌ Interdit pour un produit fermé sans licence commerciale |
| **PDFium** (Chrome, C++) via `@embedpdf/pdfium` (WASM) | Apache 2.0 / MIT | ✅ **Retenu** : rendu natif dans un worker, texte avec boîtes de caractères, sommaire, pièces jointes, suppression réelle de texte |

Ce qu'on en a tiré :
- Les ressources de pdf.js (polices standard, CMaps asiatiques, décodeurs JPEG2000 et JBIG2)
  sont copiées dans l'application. Les PDF s'ouvrent donc **sans Internet**.
- Formulaires XFA activés.
- Les tests mobiles ont montré que pdf.js 6 utilise des fonctions JavaScript trop récentes
  pour certaines WebView Android. On utilise donc sa version *legacy*, prévue pour ce cas.

## 2. Exporter un PDF fidèle

Les éditeurs simples « aplatissent » souvent le PDF en image. Le texte n'est alors plus
sélectionnable et le fichier grossit. Notre approche :

1. **pdf-lib** (MIT) recopie la page d'origine telle quelle : texte, vectoriel, polices.
2. Les ajouts sont convertis en SVG par Fabric.js, puis en PDF **vectoriel** par
   **svg2pdf.js + jsPDF** (MIT), et superposés à la page.
3. Si une conversion vectorielle échoue, on retombe sur une surcouche image à 300 ppp.

Corrections apportées par-dessus ces bibliothèques :
- **Pages tournées** (`/Rotate` 90/180/270) : la surcouche est contre-tournée pour
  rester alignée avec ce qu'on voit à l'écran (vérifié par test).
- **Polices** : svg2pdf ne reconnaissait pas « Helvetica » et passait en Times. Chaque
  police est maintenant ramenée à la police PDF standard la plus proche.
- `putOnlyUsedFonts` évite d'ajouter les 14 polices standard à chaque page.

Reste à faire : intégrer de vraies polices TrueType (`jsPDF.addFont`) pour l'Unicode
complet (emoji, alphabets non latins).

## 3. Modifier le texte *d'origine* d'un PDF (le plus dur)

Même Acrobat a du mal. Approches trouvées :

| Approche | Exemple | Qualité |
|---|---|---|
| Masquer + retaper : rectangle blanc sur l'ancien texte, nouveau texte par-dessus | Stirling-PDF, la plupart des éditeurs web | Simple et fiable, mais la police peut différer. |
| Réécrire les opérateurs de texte dans le flux de contenu | pdfFlow Engine (jeune projet) | Garde la police d'origine, mais échoue si la police intégrée ne contient pas les nouveaux caractères. |
| API d'objets de page de PDFium (`FPDFText_SetText`, `FPDFPageObj_*`) | EmbedPDF (MIT, PDFium en WASM) | La plus complète. Elle remplace un bloc de texte et le régénère. |

**Réalisé** (approche PDFium) : un double-clic sur un paragraphe donne une zone de texte avec la
taille, la couleur, la graisse et la police la plus proche installée. Les objets texte d'origine
sont **retirés de la page** par PDFium (`FPDFPage_RemoveObject` + `FPDFPage_GenerateContent`),
à l'écran comme dans le PDF exporté. Un test automatique vérifie avec `pdftotext` que l'ancien
texte n'existe plus dans le fichier exporté.
Limite : la police d'origine embarquée n'est pas réutilisée (souvent partielle, elle ne
contient pas les nouveaux caractères).

## 4. Formats bureautiques (Word, Excel, PowerPoint, OpenDocument…)

| Option | Licence | Verdict |
|---|---|---|
| **LibreOffice** en mode « headless », lancé comme programme externe | MPL 2.0 | ✅ Retenu sur PC. C'est la meilleure fidélité open source. Il est lancé, pas intégré : la licence est compatible avec une vente. |
| mammoth (docx → texte/HTML) | BSD-2 | ✅ Repli sans LibreOffice (texte seul). |
| docx (génération .docx) | MIT | ✅ Export Word « mise en page identique ». |
| Gotenberg (LibreOffice en service web) | MIT | 🔜 Option pour le mobile, qui n'a pas LibreOffice. |
| LibreOffice compilé en WebAssembly (ZetaOffice) | MPL 2.0 | 🔎 À surveiller pour un mobile 100 % hors ligne. |

Formats ouverts via LibreOffice : doc, docx, docm, dot(x), odt, ott, rtf, wpd, wps, lwp,
abw, pages, hwp, epub, xls, xlsx, xlsm, xlsb, ods, numbers, ppt, pptx, pps(x), odp,
key, odg, vsd(x), cdr, pub, emf, wmf, cgm, xps, html.

Astuce trouvée : un PDF s'ouvre par défaut dans **Draw**, qui ne sait pas produire de
.docx. On force `--infilter=writer_pdf_import`, et l'export **Word / ODT / RTF / DOC avec
texte modifiable** fonctionne. Chaque conversion utilise aussi un profil LibreOffice
temporaire : elle n'est pas bloquée si l'utilisateur a déjà LibreOffice ouvert.

## 5. Images

- Formats décodés directement par le moteur : PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, APNG.
- **TIFF**, y compris multipage : utif2 (MIT). Une page par image.
- **PSD** (Photoshop), image finale : ag-psd (MIT).
- SVG : importé en **objets vectoriels** modifiables (Fabric.js).
- HEIC (photos iPhone) : la bibliothèque libheif est en LGPL-3. À intégrer comme
  module WASM séparé si besoin.

## 6. Xournal / Xournal++

Xournal++ est sous GPL-2 : on n'en copie aucun code. Son format `.xopp` (XML compressé
gzip) est documenté et on l'a réimplémenté : traits, épaisseur, surligneur, textes,
images, fonds papier (lignes, carreaux, pointillés, portées…) et **PDF de fond**
retrouvé à côté du carnet.

Leçons tirées de ses défauts d'ergonomie (ton retour : sélection pénible à déplacer,
copier-coller qui crée un cadre bizarre) :
- **Un seul modèle d'objets**, comme Figma, PowerPoint ou Excalidraw. Tout ce qui est
  dessiné est un objet sélectionnable. Il n'y a pas de « sélection de zone » séparée qu'il
  faudrait ensuite transformer.
- Un cadre de sélection prend **tout ce qu'il touche**, pas seulement ce qui est
  entièrement dedans.
- On clique **n'importe où dans le cadre pointillé** pour déplacer.
- **Coller = sous le pointeur, déjà sélectionné**, prêt à être déplacé. Plusieurs
  collages au même endroit sont décalés, pour ne jamais s'empiler en invisible.
- Chaque opération (coller, grouper, importer) compte pour **une seule** étape
  d'annulation. Les annulations s'enchaînent proprement, même avec Ctrl+Z maintenu.

## 7. Stylet et tablettes graphiques

- Les **Pointer Events** (standard du web) donnent la pression, l'inclinaison et le
  bouton gomme. Ils fonctionnent avec Wacom, XP-Pen, Huion, Gaomon, Windows Ink,
  libinput (Linux), Apple Pencil et les stylets Android.
- À venir : **perfect-freehand** (MIT, utilisé par tldraw et Excalidraw) pour des traits
  à épaisseur variable selon la pression, avec un rendu lissé.
- Rejet de la paume : ignorer le tactile quand un stylet est détecté (même approche que
  Xournal++ et OneNote).

## 8. Mobile

- **Capacitor** (MIT, Ionic) emballe la même interface en application native. Android
  est configuré. iOS est possible avec le même code, mais demande un Mac et un compte
  Apple développeur : reporté.
- Enregistrement des fichiers : `@capacitor/filesystem` et `@capacitor/share` (feuille
  de partage native).
- Zoom à deux doigts et déplacement de la vue intégrés.

## Récapitulatif des licences des dépendances livrées

| Bibliothèque | Licence |
|---|---|
| Electron, Fabric.js, pdf-lib, jsPDF, svg2pdf.js, docx, utif2, ag-psd, Capacitor | MIT |
| pdf.js | Apache 2.0 |
| mammoth | BSD-2 |
| JSZip | MIT (double licence MIT/GPL : on choisit MIT) |
| LibreOffice | MPL 2.0, **non livré**, appelé s'il est installé |
