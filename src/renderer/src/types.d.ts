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
