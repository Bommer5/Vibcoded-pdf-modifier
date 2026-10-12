//! Noyau natif de Feuillet, compilé en WebAssembly (PC, Android, navigateur).
//!
//! Interface C minimale (pas de wasm-bindgen) : le JavaScript alloue des tampons
//! dans la mémoire du module, appelle une fonction, puis lit le résultat.
//! Les résultats de taille variable sont renvoyés dans un tampon dont le premier
//! mot (u32) donne la taille totale en octets ; le JS le libère avec `dealloc`.

mod geometry;
mod image;

use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};

#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return core::ptr::null_mut();
    }
    unsafe { raw_alloc(Layout::from_size_align_unchecked(size, 8)) }
}

/// # Safety
/// `ptr` doit provenir de `alloc(size)`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, size: usize) {
    if !ptr.is_null() && size > 0 {
        raw_dealloc(ptr, Layout::from_size_align_unchecked(size, 8));
    }
}

/// Copie un vecteur d'octets dans un tampon « [taille u32][données] » géré par le JS.
pub(crate) fn into_buffer(bytes: Vec<u8>) -> *mut u8 {
    let total = bytes.len() + 4;
    let ptr = alloc(total);
    unsafe {
        core::ptr::copy_nonoverlapping((total as u32).to_le_bytes().as_ptr(), ptr, 4);
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.add(4), bytes.len());
    }
    ptr
}

pub(crate) fn push_f32(out: &mut Vec<u8>, v: f32) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub(crate) fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}
