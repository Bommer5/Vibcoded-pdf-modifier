import { loadSVGFromString, util, type FabricObject } from 'fabric'
import { renderGraph, type GraphSpec } from './graph'

export type GraphObject = FabricObject & { graph?: GraphSpec }

/** Objet vectoriel d'un graphe (groupe SVG) qui garde sa description pour être réédité. */
export async function graphObject(spec: GraphSpec): Promise<GraphObject> {
  const { svg } = renderGraph(spec)
  const { objects, options } = await loadSVGFromString(svg.replace(/ class="hit"/g, '').replace(/<path[^>]*stroke="transparent"[^>]*\/>/g, ''))
  const group = util.groupSVGElements(objects.filter((o): o is FabricObject => !!o), options) as GraphObject
  group.graph = structuredClone(spec)
  return group
}

export const isGraph = (o: FabricObject | undefined): o is GraphObject => !!(o as GraphObject | undefined)?.graph
