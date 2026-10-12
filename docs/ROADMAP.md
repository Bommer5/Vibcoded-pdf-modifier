# Feuillet — Feuille de route

Éditeur de PDF, documents et images pour Windows et Linux, pensé pour le stylet
(tablettes graphiques). Inspirations : Xournal++, Drawboard PDF, Krita, Figma, Acrobat.

## Faisabilité

Tout est faisable. Choix techniques :

| Besoin | Solution |
|---|---|
| Windows + Linux (+ macOS gratuit) | **Electron** + TypeScript, installeurs via electron-builder (NSIS, AppImage, .deb) |
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

## Phase 0 — Socle ✅ (ce commit)
- [x] Projet Electron + Vite + TypeScript, build Windows/Linux configuré
- [x] Fenêtre, barre d'outils, barre d'état, thème sombre
- [x] Page A4 vierge, ajout de pages
- [x] Zoom centré sur le pointeur (touches configurables, Ctrl+molette)
- [x] Déplacement : Espace maintenu, outil Main, clic molette
- [x] Annuler / Rétablir : Ctrl+Z, Ctrl+Maj+Z, Ctrl+Y
- [x] Détection stylet / souris / tactile + pression affichée
- [x] Dialogues ouvrir / enregistrer sécurisés (IPC, sandbox)

## Phase 1 — Édition de base
- [ ] 1.1 Sélection : cadre pointillé, poignées, rotation, multi-sélection (Maj), sélection au lasso
- [ ] 1.2 Déplacement au clavier (flèches, Maj = 10 px), copier/coller/dupliquer (Ctrl+C/V/D)
- [ ] 1.3 Supprimer, grouper / dégrouper (Ctrl+G / Ctrl+Maj+G)
- [ ] 1.4 Ordre : premier plan / arrière-plan
- [ ] 1.5 Alignement et distribution, repères magnétiques (snapping)
- [ ] 1.6 Historique robuste (commandes différentielles plutôt qu'instantanés)

## Phase 2 — Stylet et dessin
- [ ] 2.1 Pinceau à pression (épaisseur variable, lissage type Perfect Freehand)
- [ ] 2.2 Surligneur (transparent, multiplicatif)
- [ ] 2.3 Gomme : par objet et partielle ; bouton gomme du stylet reconnu automatiquement
- [ ] 2.4 **Lignes droites : maintenir Maj** pendant le tracé (angles bloqués à 15°)
- [ ] 2.5 Bouton latéral du stylet configurable (ex. Main, Gomme, Sélection)
- [ ] 2.6 Rejet de la paume (ignorer le tactile quand le stylet est proche)
- [ ] 2.7 Courbe de pression réglable, test de la tablette dans les préférences

## Phase 3 — Formes et texte
- [ ] 3.1 Ligne, flèche, rectangle, carré (Maj), ellipse, cercle (Maj), triangle, polygone, étoile
- [ ] 3.2 Tableau : lignes × colonnes, redimensionnement, texte dans les cellules
- [ ] 3.3 Zone de texte : police, taille, gras/italique/souligné, alignement, interligne
- [ ] 3.4 Couleurs : contour, remplissage, opacité, pipette, palette récente, sélecteur HSV
- [ ] 3.5 Épaisseur et style de trait (plein, pointillé), extrémités de flèches
- [ ] 3.6 Panneau Propriétés contextuel (s'adapte à l'objet sélectionné)

## Phase 4 — Calques
- [ ] 4.1 Panneau Calques : créer, renommer, supprimer, réordonner (glisser-déposer)
- [ ] 4.2 Afficher/masquer, verrouiller, opacité par calque
- [ ] 4.3 Calque « Document » (PDF d'origine) verrouillé par défaut
- [ ] 4.4 Déplacer la sélection vers un autre calque

## Phase 5 — Import
- [ ] 5.1 Ouvrir un PDF (rendu pdf.js, chaque page = page éditable)
- [ ] 5.2 Importer des images (fichier, glisser-déposer, coller depuis le presse-papiers)
- [ ] 5.3 Insérer un PDF dans une page existante, ou ses pages à la suite
- [ ] 5.4 Ouvrir un .docx (texte et images)
- [ ] 5.5 Ouvrir un SVG en objets vectoriels
- [ ] 5.6 Glisser un fichier sur la fenêtre / « Ouvrir avec » depuis l'explorateur

## Phase 6 — Pages et documents
- [ ] 6.1 Nouveau document : A4, A3, A5, Lettre, portrait/paysage, taille libre
- [ ] 6.2 Panneau Miniatures : réordonner, dupliquer, supprimer, pivoter des pages
- [ ] 6.3 Fonds de page : vierge, lignes, petits carreaux, pointillés
- [ ] 6.4 **Outil Cadre** : tracer un cadre sur la zone de travail → l'exporter en PDF/image
- [ ] 6.5 Format projet natif (.feuillet) : tout reste modifiable (calques, objets)
- [ ] 6.6 Sauvegarde automatique et récupération après plantage

## Phase 7 — Export
- [ ] 7.1 PDF : PDF d'origine conservé + annotations vectorielles par-dessus
- [ ] 7.2 PNG / JPG / WebP (page courante, sélection, toutes les pages, DPI réglable)
- [ ] 7.3 SVG
- [ ] 7.4 Word (.docx)
- [ ] 7.5 Impression
- [ ] 7.6 Options : plage de pages, compression, aplatir ou non

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
- [ ] 9.4 Tests automatisés (unitaires + bout-en-bout Playwright) et CI GitHub Actions
- [ ] 9.5 Licence : vérifier les dépendances (toutes MIT/Apache ici), CGU, licence logicielle
- [ ] 9.6 Rapports de plantage (opt-in), page de site, documentation utilisateur
