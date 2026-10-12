import { FabricObject } from 'fabric'

/**
 * Propriétés métier portées par les objets du canevas et conservées dans
 * l'historique, le presse-papiers et les fichiers projet.
 *
 * - role       : 'page' (feuille), 'page-bg' (rendu du PDF / fond de page), sinon contenu
 * - pageId     : identifiant de page (feuilles et fonds)
 * - assetId    : ressource binaire (image) dans l'AssetStore
 * - pdfAssetId / pdfPageIndex : PDF d'origine de la page, pour un export fidèle
 * - layerName  : calque d'origine (imports Xournal++), utilisé par le futur panneau Calques
 */
export type Role = 'page' | 'page-bg'

export interface FeuilletProps {
  role?: Role
  pageId?: string
  assetId?: string
  pdfAssetId?: string
  pdfPageIndex?: number
  layerName?: string
}

FabricObject.customProperties = [
  'role',
  'pageId',
  'assetId',
  'pdfAssetId',
  'pdfPageIndex',
  'layerName',
  'selectable',
  'evented',
  'hoverCursor'
]

export type Obj = FabricObject & FeuilletProps

export const isPageLayer = (o: FabricObject): boolean => !!(o as Obj).role
