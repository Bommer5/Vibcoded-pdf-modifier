//! Géométrie de l'encre : gomme, simplification, lasso, reconnaissance de formes.
//! Les points sont des f32 entrelacés (x, y[, pression]) avec un pas `stride`.

use crate::{into_buffer, push_f32, push_u32};

#[inline]
fn pts<'a>(ptr: *const f32, n: usize, stride: usize) -> &'a [f32] {
    if n == 0 {
        return &[];
    }
    unsafe { core::slice::from_raw_parts(ptr, n * stride) }
}

#[inline]
fn seg_dist2(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 { (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
    let (ex, ey) = (ax + t * dx - px, ay + t * dy - py);
    ex * ex + ey * ey
}

/// Gomme partielle. Densifie le trait (pas `step`), retire les points à moins de `r`
/// du centre et renvoie les morceaux restants :
/// `[taille][nb_morceaux u32] puis pour chaque morceau [nb_points u32][points f32 × stride]`.
/// Renvoie un pointeur nul si le trait n'est pas touché (cas le plus fréquent : très rapide).
#[no_mangle]
pub extern "C" fn erase(ptr: *const f32, n: usize, stride: usize, cx: f32, cy: f32, r: f32, step: f32) -> *mut u8 {
    let p = pts(ptr, n, stride);
    let r2 = r * r;
    // Rejet rapide : aucun segment n'approche le centre.
    let touched = if n == 1 {
        let (dx, dy) = (p[0] - cx, p[1] - cy);
        dx * dx + dy * dy <= r2
    } else {
        (0..n - 1).any(|i| {
            let (a, b) = (i * stride, (i + 1) * stride);
            seg_dist2(cx, cy, p[a], p[a + 1], p[b], p[b + 1]) <= r2
        })
    };
    if !touched {
        return core::ptr::null_mut();
    }
    let mut runs: Vec<Vec<f32>> = Vec::new();
    let mut cur: Vec<f32> = Vec::new();
    let mut visit = |v: &[f32]| {
        let (dx, dy) = (v[0] - cx, v[1] - cy);
        if dx * dx + dy * dy <= r2 {
            if !cur.is_empty() {
                runs.push(core::mem::take(&mut cur));
            }
        } else {
            cur.extend_from_slice(v);
        }
    };
    let mut tmp = vec![0f32; stride];
    for i in 0..n {
        let a = &p[i * stride..(i + 1) * stride];
        visit(a);
        if i + 1 < n {
            let b = &p[(i + 1) * stride..(i + 2) * stride];
            let d = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
            let k = (d / step.max(0.01)) as usize;
            for j in 1..k.max(1) {
                let t = j as f32 / k as f32;
                for c in 0..stride {
                    tmp[c] = a[c] + (b[c] - a[c]) * t;
                }
                visit(&tmp);
            }
        }
    }
    if !cur.is_empty() {
        runs.push(cur);
    }
    let mut out = Vec::new();
    let kept: Vec<_> = runs.into_iter().filter(|r| r.len() / stride > 1).collect();
    push_u32(&mut out, kept.len() as u32);
    for run in kept {
        push_u32(&mut out, (run.len() / stride) as u32);
        for v in run {
            push_f32(&mut out, v);
        }
    }
    into_buffer(out)
}

/// Simplification Ramer-Douglas-Peucker, en place. Renvoie le nouveau nombre de points.
#[no_mangle]
pub extern "C" fn simplify(ptr: *mut f32, n: usize, stride: usize, tolerance: f32) -> usize {
    if n < 3 {
        return n;
    }
    let p = unsafe { core::slice::from_raw_parts_mut(ptr, n * stride) };
    let keep = rdp(p, n, stride, tolerance);
    let mut w = 0;
    for (i, k) in keep.iter().enumerate() {
        if *k {
            p.copy_within(i * stride..(i + 1) * stride, w * stride);
            w += 1;
        }
    }
    w
}

fn rdp(p: &[f32], n: usize, stride: usize, tolerance: f32) -> Vec<bool> {
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let tol2 = tolerance * tolerance;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((a, b)) = stack.pop() {
        let (ax, ay, bx, by) = (p[a * stride], p[a * stride + 1], p[b * stride], p[b * stride + 1]);
        let mut best = (0f32, 0usize);
        for i in a + 1..b {
            let d = seg_dist2(p[i * stride], p[i * stride + 1], ax, ay, bx, by);
            if d > best.0 {
                best = (d, i);
            }
        }
        if best.0 > tol2 {
            keep[best.1] = true;
            stack.push((a, best.1));
            stack.push((best.1, b));
        }
    }
    keep
}

/// Lasso : nombre de points (parmi `n`) situés dans le polygone (règle pair-impair).
#[no_mangle]
pub extern "C" fn count_inside(poly: *const f32, np: usize, ptr: *const f32, n: usize, stride: usize) -> u32 {
    let poly = pts(poly, np, 2);
    let p = pts(ptr, n, stride);
    let mut count = 0;
    for i in 0..n {
        let (x, y) = (p[i * stride], p[i * stride + 1]);
        let mut inside = false;
        let mut j = np - 1;
        for k in 0..np {
            let (xi, yi, xj, yj) = (poly[k * 2], poly[k * 2 + 1], poly[j * 2], poly[j * 2 + 1]);
            if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
                inside = !inside;
            }
            j = k;
        }
        if inside {
            count += 1;
        }
    }
    count
}

/// Reconnaissance de forme dessinée à main levée.
/// Écrit les paramètres dans `out` (8 f32) et renvoie :
/// 0 = rien, 1 = ligne (x1 y1 x2 y2), 2 = ellipse (cx cy rx ry),
/// 3 = rectangle (gauche haut largeur hauteur), 4 = triangle (x1 y1 x2 y2 x3 y3),
/// 5 = quadrilatère (4 sommets).
#[no_mangle]
pub extern "C" fn recognize(ptr: *const f32, n: usize, stride: usize, out: *mut f32) -> u32 {
    if n < 5 {
        return 0;
    }
    let p = pts(ptr, n, stride);
    let out = unsafe { core::slice::from_raw_parts_mut(out, 8) };
    let (mut minx, mut miny, mut maxx, mut maxy) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    let mut length = 0f32;
    for i in 0..n {
        let (x, y) = (p[i * stride], p[i * stride + 1]);
        minx = minx.min(x);
        maxx = maxx.max(x);
        miny = miny.min(y);
        maxy = maxy.max(y);
        if i > 0 {
            length += ((x - p[(i - 1) * stride]).powi(2) + (y - p[(i - 1) * stride + 1]).powi(2)).sqrt();
        }
    }
    let (w, h) = (maxx - minx, maxy - miny);
    let diag = (w * w + h * h).sqrt();
    if diag < 8.0 {
        return 0;
    }
    let (sx, sy, ex, ey) = (p[0], p[1], p[(n - 1) * stride], p[(n - 1) * stride + 1]);
    let gap = ((ex - sx).powi(2) + (ey - sy).powi(2)).sqrt();

    // Trait ouvert : ligne droite si tous les points restent près du segment.
    if gap > diag * 0.25 {
        let max_dev = (0..n)
            .map(|i| seg_dist2(p[i * stride], p[i * stride + 1], sx, sy, ex, ey).sqrt())
            .fold(0f32, f32::max);
        if max_dev < diag * 0.06 && length < gap * 1.2 {
            out[..4].copy_from_slice(&[sx, sy, ex, ey]);
            return 1;
        }
        return 0;
    }

    // Trait fermé : polygone simplifié, puis comparaison avec une ellipse.
    let keep = rdp(p, n, stride, diag * 0.07);
    let mut corners: Vec<(f32, f32)> = (0..n).filter(|&i| keep[i]).map(|i| (p[i * stride], p[i * stride + 1])).collect();
    if corners.len() > 2 {
        let (a, b) = (corners[0], *corners.last().unwrap());
        if ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt() < diag * 0.2 {
            corners.pop();
        }
    }
    let (cx, cy, rx, ry) = (minx + w / 2.0, miny + h / 2.0, (w / 2.0).max(1.0), (h / 2.0).max(1.0));
    let ellipse_err = (0..n)
        .map(|i| {
            let (dx, dy) = ((p[i * stride] - cx) / rx, (p[i * stride + 1] - cy) / ry);
            ((dx * dx + dy * dy).sqrt() - 1.0).abs()
        })
        .sum::<f32>()
        / n as f32;

    match corners.len() {
        3 => {
            for (k, c) in corners.iter().enumerate() {
                out[k * 2] = c.0;
                out[k * 2 + 1] = c.1;
            }
            4
        }
        4 if ellipse_err > 0.08 => {
            // Rectangle si les côtés sont à peu près horizontaux / verticaux.
            let axis_aligned = (0..4).all(|k| {
                let (a, b) = (corners[k], corners[(k + 1) % 4]);
                let ang = (b.1 - a.1).atan2(b.0 - a.0).abs() % core::f32::consts::FRAC_PI_2;
                ang < 0.3 || ang > core::f32::consts::FRAC_PI_2 - 0.3
            });
            if axis_aligned {
                out[..4].copy_from_slice(&[minx, miny, w, h]);
                3
            } else {
                for (k, c) in corners.iter().enumerate() {
                    out[k * 2] = c.0;
                    out[k * 2 + 1] = c.1;
                }
                5
            }
        }
        _ if ellipse_err < 0.16 => {
            out[..4].copy_from_slice(&[cx, cy, rx, ry]);
            2
        }
        _ => 0,
    }
}
