declare module 'utif2' {
  export interface IFD {
    width: number
    height: number
    [tag: string]: unknown
  }
  export function decode(buffer: ArrayBuffer): IFD[]
  export function decodeImage(buffer: ArrayBuffer, ifd: IFD): void
  export function toRGBA8(ifd: IFD): Uint8Array
  export function encodeImage(rgba: ArrayBuffer, w: number, h: number): ArrayBuffer
}

/** opentype.js 1.3 (MIT) : seules les parties utilisées pour reconstruire les polices des PDF. */
declare module 'opentype.js' {
  export class Path {
    moveTo(x: number, y: number): void
    lineTo(x: number, y: number): void
    curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void
    close(): void
  }
  export class Glyph {
    constructor(options: { name: string; unicode?: number; advanceWidth: number; path: Path })
  }
  export class Font {
    constructor(options: { familyName: string; styleName: string; unitsPerEm: number; ascender: number; descender: number; glyphs: Glyph[] })
    toArrayBuffer(): ArrayBuffer
  }
}
