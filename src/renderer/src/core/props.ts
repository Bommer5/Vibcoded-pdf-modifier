import { FabricObject } from 'fabric'
import { installParagraphSpacing } from '../text/paragraph'

/**
 * Propriétés métier portées par les objets du canevas et conservées dans
 * l'historique, le presse-papiers et les fichiers projet.
 *
 * - role       : 'page' pour les feuilles, absent pour le contenu
 * - pageId     : identifiant de page (feuilles et fonds)
 * - assetId    : ressource binaire (image) dans l'AssetStore
 * - layerName  : calque d'origine (imports Xournal++), utilisé par le futur panneau Calques
 * - ink        : points du trait (stylo / surligneur), pour la gomme partielle et les retouches
 * - shape      : type de forme dessinée (ligne, flèche, rectangle…)
 * - chart      : description d'un graphique, pour pouvoir le rééditer
 */
export type Role = 'page'

export interface FeuilletProps {
  role?: Role
  pageId?: string
  assetId?: string
  layerName?: string
}

// Fabric 7 positionne les objets par leur centre par défaut ; tout le projet raisonne
// en coin haut-gauche (comme les PDF, Word et Xournal++).
FabricObject.ownDefaults.originX = 'left'
FabricObject.ownDefaults.originY = 'top'

FabricObject.customProperties = [
  'role',
  'pageId',
  'assetId',
  'layerName',
  'ink',
  'shape',
  'chart',
  'markup',
  'pdfEdit',
  'pdfFonts',
  'pdfFlow',
  'layer',
  'masks',
  'contour',
  'contourStroke',
  'contourFill',
  'contourHeight',
  'paragraphSpacing',
  'firstIndent',
  'locked',
  'pdfPage',
  'selectable',
  'evented',
  'hoverCursor'
]

// Espacement entre paragraphes et éléments de liste (comme « Espacement après » de Word).
installParagraphSpacing()

export type Obj = FabricObject & FeuilletProps

export const isPageLayer = (o: FabricObject): boolean => !!(o as Obj).role
