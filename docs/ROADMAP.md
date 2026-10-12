# Feuillet — Feuille de route

Éditeur de PDF, documents et images pour Windows et Linux, pensé pour le stylet
(tablettes graphiques). Inspirations : Xournal++, Drawboard PDF, Krita, Figma, Acrobat.

## Faisabilité

Tout est faisable. Choix techniques :

| Besoin | Solution |
|---|---|
| Windows + Linux (+ macOS gratuit) + **Android** (Capacitor) | **Electron** + TypeScript, installeurs via electron-builder (NSIS, AppImage, .deb) |
| Toutes les tablettes graphiques | **Pointer Events** de Chromium : pression, inclinaison, gomme du stylet. Fonctionne avec Wacom, XP-Pen, Huion, Gaomon, Windows Ink, libinput/X11/Wayland, sans pilote spécifique |
| Canevas, sélection, déplacement, calques | **Fabric.js** (objets, poignées, sélection en pointillés, groupes) |
| Lire / afficher les PDF | **pdf.js** (moteur de Firefox) |
| Écrire / exporter les PDF | **pdf-lib** (vectoriel, conserve le PDF d'origine) |
| Import / export Word (.docx) | **mammoth** (lecture), **docx** (écriture) |
| Images | PNG, JPG, WebP, SVG natifs |

Limites honnêtes :
- Modifier *le texte d'origine* d'un PDF (réécrire un paragraphe existant) est difficile partout,
  même dans Acrobat. On fera : annotation par-dessus, masquage + retapage, et édition des
  blocs de texte simples en phase avancée.
- L'export Word d'un PDF annoté sera fidèle visuellement (pages en image + texte), pas
  une reconstruction parfaite de la mise en page.
- Formats propriétaires (.pages, .indd) : non prévus.

## Phase 0 — Socle ✅
- [x] Projet Electron + Vite + TypeScript, build Windows/Linux configuré
- [x] Fenêtre, barre d'outils, barre d'état, thème sombre
- [x] Page A4 vierge, ajout de pages
- [x] Zoom centré sur le pointeur (touches configurables, Ctrl+molette)
- [x] Déplacement : Espace maintenu, outil Main, clic molette
- [x] Annuler / Rétablir : Ctrl+Z, Ctrl+Maj+Z, Ctrl+Y
- [x] Détection stylet / souris / tactile + pression affichée
- [x] Dialogues ouvrir / enregistrer sécurisés (IPC, sandbox)

## Phase 1 — Édition de base
- [x] 1.1 Sélection : cadre pointillé (prend tout ce qu'il touche), poignées, rotation, multi-sélection (Maj)
- [ ] 1.1b Sélection au lasso
- [x] 1.2 Flèches (Maj = ×10), copier/couper/coller **sous le pointeur**, dupliquer (Ctrl+C/X/V/D), tout sélectionner
- [x] 1.3 Supprimer, grouper / dégrouper (Ctrl+G / Ctrl+Maj+G), barre d'actions de sélection
- [x] 1.4 Ordre : premier plan / arrière-plan
- [x] 1.4b Coller des images / du texte venant d'autres applications
- [ ] 1.5 Alignement et distribution, repères magnétiques (snapping)
- [ ] 1.6 Historique robuste (commandes différentielles plutôt qu'instantanés)

## Phase 2 — Stylet et dessin
- [x] 2.1 Stylo à pression (perfect-freehand), traits lissés, évènements coalescés
- [x] 2.2 Surligneur (transparent, multiplicatif)
- [x] 2.3 Gomme partielle ou trait entier ; bout gomme du stylet reconnu automatiquement
- [x] 2.4 **Lignes droites : Maj** (aimantation 45°) ou **stylet immobile en fin de trait**
- [x] 2.4b Traits pleins, tirets, pointillés
- [ ] 2.5 Bouton latéral du stylet configurable (ex. Main, Gomme, Sélection)
- [x] 2.6 Rejet de la paume (le doigt déplace la vue dès qu'un stylet est détecté)
- [ ] 2.7 Courbe de pression réglable, test de la tablette dans les préférences

## Phase 3 — Formes, texte, tableaux, graphiques
- [x] 3.1 Ligne, flèche, rectangle, carré (Maj), ellipse, cercle (Maj), triangle
- [ ] 3.1b Polygone, étoile, bulles de dialogue
- [x] 3.2 Tableau : lignes × colonnes, cellules éditables (Tab), en-tête, bandes, redimensionnement sans déformer le texte
- [x] 3.3 Texte façon Word : police, taille, gras/italique/souligné/barré (Ctrl+B/I/U), alignement gauche/centre/droite/justifié, interligne, couleur, surlignage
- [x] 3.3b **Zone de texte dessinée à la main** : le texte épouse la forme entourée
- [x] 3.4 Couleurs : contour, remplissage, opacité, nuancier + couleur libre
- [ ] 3.4b Pipette, couleurs récentes
- [x] 3.5 Épaisseur et style de trait (plein, tirets, pointillés)
- [x] 3.6 Panneau Propriétés contextuel (tiroir sur mobile)
- [x] 3.7 Graphiques vectoriels : histogramme, barres, empilé, courbes, aires, secteurs, anneau, nuage de points, radar ; données collables depuis Excel ; rééditables
- [x] 3.8 Barre de menus (Fichier, Édition, Insertion, Outils, Affichage, Aide) avec raccourcis affichés

## Phase 4 — Calques
- [ ] 4.1 Panneau Calques : créer, renommer, supprimer, réordonner (glisser-déposer)
- [ ] 4.2 Afficher/masquer, verrouiller, opacité par calque
- [ ] 4.3 Calque « Document » (PDF d'origine) verrouillé par défaut
- [ ] 4.4 Déplacer la sélection vers un autre calque

## Phase 5 — Import ✅ (voir docs/RESEARCH.md)
- [x] 5.1 PDF (hors ligne, pages tournées, formulaires XFA), .ai
- [x] 5.2 Images : PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, TIFF multipage, PSD ; glisser-déposer, coller
- [x] 5.3 Insérer un PDF / document : pages ajoutées après la page actuelle
- [x] 5.4 Bureautique via LibreOffice : Word, Excel, PowerPoint, OpenDocument, RTF, Pages, Keynote, Numbers, Visio, EPUB… (repli texte pour .docx)
- [x] 5.5 SVG en objets vectoriels
- [x] 5.6 Glisser-déposer, « Ouvrir avec » / double-clic (instance unique)
- [x] 5.7 Carnets Xournal / Xournal++ (.xoj, .xopp) avec fond PDF et papiers
- [x] 5.8 Texte brut (.txt, .md, .csv…) : mis en page sur des feuilles A4
- [ ] 5.9 HEIC, mise en page mobile du .docx sans LibreOffice

## Phase 6 — Pages et documents
- [ ] 6.1 Nouveau document : A4, A3, A5, Lettre, portrait/paysage, taille libre
- [ ] 6.2 Panneau Miniatures : réordonner, dupliquer, supprimer, pivoter des pages
- [ ] 6.3 Fonds de page : vierge, lignes, petits carreaux, pointillés
- [ ] 6.4 **Outil Cadre** : tracer un cadre sur la zone de travail → l'exporter en PDF/image
- [x] 6.5 Format projet natif (.feuillet) : tout reste modifiable (calques, objets)
- [ ] 6.6 Sauvegarde automatique et récupération après plantage

## Phase 7 — Export
- [x] 7.1 PDF : PDF d'origine conservé + ajouts vectoriels (pages tournées gérées)
- [x] 7.2 PNG / JPEG / WebP / TIFF (page actuelle, toutes, plage « 1-3, 5 », 96 à 600 ppp)
- [x] 7.3 SVG
- [x] 7.4 Word .docx (mise en page identique, ou texte modifiable via LibreOffice), ODT, ODG, RTF, DOC
- [ ] 7.4b Polices TrueType intégrées au PDF (Unicode complet)
- [ ] 7.5 Impression
- [ ] 7.6 Options : plage de pages, compression, aplatir ou non

## Phase 7bis — Mobile
- [x] Couche plateforme (PC / Android / navigateur), build web, projet Android Capacitor
- [x] Zoom à deux doigts, partage natif des exports
- [ ] Interface adaptée au téléphone (barres repliables, gros boutons)
- [ ] Conversion bureautique sur mobile (service optionnel)
- [ ] iOS (même code ; nécessite un Mac + compte Apple)

## Phase 3bis — Modifier le texte d'origine des PDF
- [ ] Clic sur un texte du PDF → zone modifiable, original masqué à l'export
- [ ] Mode natif PDFium (WASM) quand la police le permet

## Phase 8 — Confort et finition « produit »
- [ ] 8.1 Préférences : raccourcis entièrement personnalisables (dont touches de zoom), thème clair/sombre, langue
- [ ] 8.2 Règles, grille, magnétisme
- [ ] 8.3 Onglets (plusieurs documents ouverts)
- [ ] 8.4 Recherche de texte dans le PDF, surlignage du texte sélectionné
- [ ] 8.5 Signature manuscrite réutilisable, tampons
- [ ] 8.6 Remplissage de formulaires PDF
- [ ] 8.7 Mode présentation / plein écran
- [ ] 8.8 Traductions FR / EN

## Phase 9 — Commercialisation
- [ ] 9.1 Icône, nom, identité visuelle
- [ ] 9.2 Installeurs signés (certificat Windows), AppImage + .deb
- [ ] 9.3 Mises à jour automatiques (electron-updater)
- [x] 9.4 Tests de bout en bout (Playwright + Electron, 40 vérifications) et CI GitHub Actions (PC + APK Android)
- [ ] 9.5 Licence : vérifier les dépendances (toutes MIT/Apache ici), CGU, licence logicielle
- [ ] 9.6 Rapports de plantage (opt-in), page de site, documentation utilisateur
