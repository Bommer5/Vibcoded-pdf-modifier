import { loadSVGFromString, util, type FabricObject } from 'fabric'
import { renderChart, type ChartSpec } from './chart'

export type ChartObject = FabricObject & { chart?: ChartSpec }

/** Crée l'objet vectoriel d'un graphique (groupe SVG) en mémorisant sa description. */
export async function chartObject(spec: ChartSpec): Promise<ChartObject> {
  const { objects, options } = await loadSVGFromString(renderChart(spec))
  const group = util.groupSVGElements(
    objects.filter((o): o is FabricObject => !!o),
    options
  ) as ChartObject
  group.chart = structuredClone(spec)
  return group
}

export const isChart = (o: FabricObject | undefined): o is ChartObject => !!(o as ChartObject | undefined)?.chart
