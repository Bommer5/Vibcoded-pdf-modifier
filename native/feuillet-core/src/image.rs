//! Décodage TIFF natif (scans de documents : LZW, Deflate, JPEG, Fax G3/G4, 1 à 16 bits, CMJN).
//! Résultat : `[taille][nb_pages u32] puis pour chaque page [largeur u32][hauteur u32][RGBA 8 bits]`.

use crate::{into_buffer, push_u32};
use std::io::Cursor;
use tiff::decoder::{Decoder, DecodingResult, Limits};
use tiff::tags::{PhotometricInterpretation, Tag};
use tiff::ColorType;

#[no_mangle]
pub extern "C" fn tiff_decode(ptr: *const u8, len: usize) -> *mut u8 {
    let data = unsafe { core::slice::from_raw_parts(ptr, len) };
    match decode_all(data) {
        Ok(out) => into_buffer(out),
        Err(_) => core::ptr::null_mut(),
    }
}

fn decode_all(data: &[u8]) -> Result<Vec<u8>, tiff::TiffError> {
    let mut dec = Decoder::new(Cursor::new(data))?.with_limits(Limits::unlimited());
    let mut pages: Vec<(u32, u32, Vec<u8>)> = Vec::new();
    loop {
        if let Ok(page) = decode_page(&mut dec) {
            pages.push(page);
        }
        if !dec.more_images() || pages.len() >= 500 {
            break;
        }
        dec.next_image()?;
    }
    let mut out = Vec::new();
    push_u32(&mut out, pages.len() as u32);
    for (w, h, rgba) in pages {
        push_u32(&mut out, w);
        push_u32(&mut out, h);
        out.extend_from_slice(&rgba);
    }
    Ok(out)
}

fn decode_page(dec: &mut Decoder<Cursor<&[u8]>>) -> Result<(u32, u32, Vec<u8>), tiff::TiffError> {
    let (w, h) = dec.dimensions()?;
    let color = dec.colortype()?;
    let white_is_zero = dec
        .get_tag_u32(Tag::PhotometricInterpretation)
        .map(|v| v == PhotometricInterpretation::WhiteIsZero as u32)
        .unwrap_or(false);
    let px = (w as usize) * (h as usize);
    let mut rgba = vec![255u8; px * 4];
    let img = dec.read_image()?;
    let to8 = |v: u16| (v >> 8) as u8;
    match (color, img) {
        (ColorType::Gray(1), DecodingResult::U8(buf)) => {
            // 1 bit par pixel, lignes alignées sur l'octet.
            let row = (w as usize + 7) / 8;
            for y in 0..h as usize {
                for x in 0..w as usize {
                    let bit = (buf[y * row + x / 8] >> (7 - (x % 8))) & 1;
                    let v = if (bit == 1) != white_is_zero { 255 } else { 0 };
                    let o = (y * w as usize + x) * 4;
                    rgba[o] = v;
                    rgba[o + 1] = v;
                    rgba[o + 2] = v;
                }
            }
        }
        (ColorType::Gray(8), DecodingResult::U8(buf)) => gray(&mut rgba, buf.iter().map(|&v| if white_is_zero { 255 - v } else { v })),
        (ColorType::Gray(16), DecodingResult::U16(buf)) => gray(&mut rgba, buf.iter().map(|&v| to8(v))),
        (ColorType::GrayA(8), DecodingResult::U8(buf)) => {
            for (i, c) in buf.chunks_exact(2).enumerate() {
                rgba[i * 4..i * 4 + 4].copy_from_slice(&[c[0], c[0], c[0], c[1]]);
            }
        }
        (ColorType::RGB(8), DecodingResult::U8(buf)) => {
            for (i, c) in buf.chunks_exact(3).enumerate() {
                rgba[i * 4..i * 4 + 3].copy_from_slice(c);
            }
        }
        (ColorType::RGBA(8), DecodingResult::U8(buf)) => rgba.copy_from_slice(&buf[..px * 4]),
        (ColorType::RGB(16), DecodingResult::U16(buf)) => {
            for (i, c) in buf.chunks_exact(3).enumerate() {
                rgba[i * 4..i * 4 + 3].copy_from_slice(&[to8(c[0]), to8(c[1]), to8(c[2])]);
            }
        }
        (ColorType::RGBA(16), DecodingResult::U16(buf)) => {
            for (i, c) in buf.chunks_exact(4).enumerate() {
                rgba[i * 4..i * 4 + 4].copy_from_slice(&[to8(c[0]), to8(c[1]), to8(c[2]), to8(c[3])]);
            }
        }
        (ColorType::CMYK(8), DecodingResult::U8(buf)) => {
            for (i, c) in buf.chunks_exact(4).enumerate() {
                let k = 255 - c[3] as u16;
                let ch = |v: u8| ((255 - v as u16) * k / 255) as u8;
                rgba[i * 4..i * 4 + 3].copy_from_slice(&[ch(c[0]), ch(c[1]), ch(c[2])]);
            }
        }
        _ => return Err(tiff::TiffError::UnsupportedError(tiff::TiffUnsupportedError::UnknownInterpretation)),
    }
    Ok((w, h, rgba))
}

fn gray(rgba: &mut [u8], values: impl Iterator<Item = u8>) {
    for (i, v) in values.enumerate() {
        rgba[i * 4] = v;
        rgba[i * 4 + 1] = v;
        rgba[i * 4 + 2] = v;
    }
}
