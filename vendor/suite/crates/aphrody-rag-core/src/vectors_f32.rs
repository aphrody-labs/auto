// SPDX-License-Identifier: Apache-2.0
//! Float32 RAG arithmetic; no implicit float64 promotion.

use crate::vectors_f64::{dimensions, sum_f32};

/// Normalize forensic embeddings, replacing only an exactly zero norm with one.
/// Keep the float32 fast-axis reduction used by NumPy; NaNs propagate.
pub fn normalize(rows: &[Vec<f32>]) -> Result<Vec<Vec<f32>>, &'static str> {
    dimensions(rows)?;
    Ok(rows
        .iter()
        .map(|row| {
            let norm = sum_f32(row.len(), &|index| row[index] * row[index]).sqrt();
            let denominator = if norm == 0.0 { 1.0 } else { norm };
            row.iter().map(|value| value / denominator).collect()
        })
        .collect())
}

/// Batches below this many values are normalised on the calling thread (thread start-up would cost more than it saves).
const PARALLEL_MIN_VALUES: usize = 1 << 18;
/// Upper bound on the worker threads of one call.
const PARALLEL_MAX_THREADS: usize = 16;

/// Normalises whole rows of `source` into `target` (same length, a multiple of `width`).
fn normalize_rows(source: &[f32], target: &mut [f32], width: usize) {
    for (row, out) in source
        .chunks_exact(width)
        .zip(target.chunks_exact_mut(width))
    {
        let norm = sum_f32(width, &|index| row[index] * row[index]).sqrt();
        let denominator = if norm == 0.0 { 1.0 } else { norm };
        for (value, slot) in row.iter().zip(out.iter_mut()) {
            *slot = value / denominator;
        }
    }
}

/// [`normalize`] over one contiguous row-major buffer: same arithmetic and rounding (NumPy fast-axis reduction, zero norm
/// replaced by one, NaNs propagate) without a heap allocation per row, and, for large batches, rows spread over worker
/// threads (rows are independent, so the result is bit-identical to the sequential form). `width == 0` yields an empty
/// buffer.
pub fn normalize_flat(values: &[f32], width: usize) -> Result<Vec<f32>, &'static str> {
    if width == 0 {
        return Ok(Vec::new());
    }
    if !values.len().is_multiple_of(width) {
        return Err("embedding batch must be rectangular");
    }
    let rows = values.len() / width;
    let mut result = vec![0.0_f32; values.len()];
    let threads = if values.len() < PARALLEL_MIN_VALUES {
        1
    } else {
        std::thread::available_parallelism()
            .map_or(1, std::num::NonZero::get)
            .min(PARALLEL_MAX_THREADS)
            .min(rows)
    };
    if threads <= 1 {
        normalize_rows(values, &mut result, width);
    } else {
        let chunk = rows.div_ceil(threads) * width;
        std::thread::scope(|scope| {
            for (source, target) in values.chunks(chunk).zip(result.chunks_mut(chunk)) {
                scope.spawn(move || normalize_rows(source, target, width));
            }
        });
    }
    Ok(result)
}

/// Contiguous float32 product left * right^T for forensic retrieval scores.
pub fn similarities_flat(
    left: &[f32],
    right: &[f32],
    left_rows: usize,
    right_rows: usize,
    width: usize,
) -> Result<Vec<f32>, &'static str> {
    let left_matrix = ndarray::ArrayView2::from_shape((left_rows, width), left)
        .map_err(|_| "left batch shape mismatch")?;
    let right_matrix = ndarray::ArrayView2::from_shape((right_rows, width), right)
        .map_err(|_| "right batch shape mismatch")?;
    let output_size = left_rows
        .checked_mul(right_rows)
        .filter(|size| *size <= isize::MAX as usize / 4)
        .ok_or("similarity result shape overflow")?;
    if left_rows == 0 || right_rows == 0 || width == 0 {
        return Ok(vec![0.0; output_size]);
    }
    Ok(left_matrix
        .dot(&right_matrix.t())
        .into_raw_vec_and_offset()
        .0)
}

/// Mean embedding in input order. An empty batch has no prototype.
pub fn mean(rows: &[Vec<f32>]) -> Result<Vec<f32>, &'static str> {
    let width = dimensions(rows)?.ok_or("mean requires at least one embedding")?;
    if width == 1 {
        return Ok(vec![
            sum_f32(rows.len(), &|index| rows[index][0]) / rows.len() as f32,
        ]);
    }
    let mut result = vec![0.0; width];
    for row in rows {
        for (total, value) in result.iter_mut().zip(row) {
            *total += value;
        }
    }
    for total in &mut result {
        *total /= rows.len() as f32;
    }
    Ok(result)
}

/// Squared Euclidean distances, in row-major row/centroid order.
/// Subtract before squaring (no dot-product expansion or normalization),
/// use NumPy fast-axis reduction order, and propagate NaNs.
pub fn squared_distances(
    rows: &[Vec<f32>],
    centroids: &[Vec<f32>],
) -> Result<Vec<Vec<f32>>, &'static str> {
    let row_width = dimensions(rows)?;
    let centroid_width = dimensions(centroids)?;
    if row_width.is_some() && centroid_width.is_some() && row_width != centroid_width {
        return Err("embedding dimensions do not match");
    }
    rows.len()
        .checked_mul(centroids.len())
        .filter(|size| *size <= isize::MAX as usize / 4)
        .ok_or("distance result shape overflow")?;
    Ok(rows
        .iter()
        .map(|row| {
            centroids
                .iter()
                .map(|centroid| {
                    sum_f32(row.len(), &|index| {
                        let difference = row[index] - centroid[index];
                        difference * difference
                    })
                })
                .collect()
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forensic_normalization_retains_zero_rows_and_float32_scores() {
        let rows = normalize(&[vec![3.0, 4.0], vec![0.0, 0.0], vec![-3.0, 4.0]]).unwrap();
        assert_eq!(rows[0], vec![0.6, 0.8]);
        assert_eq!(rows[1], vec![0.0, 0.0]);
        let flat: Vec<f32> = rows.into_iter().flatten().collect();
        let scores = similarities_flat(&flat, &[0.6, 0.8], 3, 1, 2).unwrap();
        assert!((scores[0] - 1.0).abs() < 1e-6);
        assert_eq!(scores[1], 0.0);
        assert!((scores[2] - 0.28).abs() < 1e-6);
        assert!(normalize(&[vec![f32::NAN]]).unwrap()[0][0].is_nan());
    }

    #[test]
    fn flat_normalization_is_bit_identical_to_the_row_form() {
        for width in [1_usize, 3, 8, 9, 64, 129, 257, 384] {
            let rows: Vec<Vec<f32>> = (0..5)
                .map(|row| {
                    (0..width)
                        .map(|column| {
                            let seed = (row * 7919 + column * 104_729 + 13) as f32;
                            (seed.sin() * 100.0) + if row == 3 { 0.0 } else { 0.5 }
                        })
                        .collect()
                })
                .collect();
            let flat: Vec<f32> = rows.iter().flatten().copied().collect();
            let expected: Vec<f32> = normalize(&rows).unwrap().into_iter().flatten().collect();
            let actual = normalize_flat(&flat, width).unwrap();
            assert_eq!(
                actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                "width {width}"
            );
        }
        // Above the parallel threshold: rows are spread over threads and the bits must not change.
        let (rows, width) = (2_049_usize, 129_usize);
        assert!(rows * width >= PARALLEL_MIN_VALUES);
        let big: Vec<Vec<f32>> = (0..rows)
            .map(|row| {
                (0..width)
                    .map(|column| ((row * 31 + column * 17) as f32).cos() * 50.0)
                    .collect()
            })
            .collect();
        let flat: Vec<f32> = big.iter().flatten().copied().collect();
        let expected: Vec<f32> = normalize(&big).unwrap().into_iter().flatten().collect();
        let actual = normalize_flat(&flat, width).unwrap();
        assert!(
            actual
                .iter()
                .map(|v| v.to_bits())
                .eq(expected.iter().map(|v| v.to_bits())),
            "parallel result differs"
        );
        assert_eq!(
            normalize_flat(&[0.0, 0.0, 3.0, 4.0], 2).unwrap(),
            vec![0.0, 0.0, 0.6, 0.8]
        );
        assert!(normalize_flat(&[f32::NAN, 1.0], 2).unwrap()[0].is_nan());
        assert_eq!(normalize_flat(&[], 0).unwrap(), Vec::<f32>::new());
        assert!(normalize_flat(&[1.0, 2.0, 3.0], 2).is_err());
    }

    #[test]
    fn forensic_shapes_preserve_empty_axes_and_reject_invalid_buffers() {
        assert_eq!(normalize(&[]).unwrap(), Vec::<Vec<f32>>::new());
        assert_eq!(normalize(&[vec![]]).unwrap(), vec![Vec::<f32>::new()]);
        assert!(normalize(&[vec![1.0], vec![]]).is_err());
        assert_eq!(
            similarities_flat(&[], &[], 0, 3, 0).unwrap(),
            Vec::<f32>::new()
        );
        assert_eq!(similarities_flat(&[], &[], 2, 3, 0).unwrap(), vec![0.0; 6]);
        assert!(similarities_flat(&[1.0], &[1.0], 2, 1, 1).is_err());
        assert!(similarities_flat(&[], &[], usize::MAX, 2, 0).is_err());
    }

    #[test]
    fn float32_rounding_preserves_centroid_and_nearest_center_tie() {
        assert_eq!(
            mean(&[vec![16_777_216.0], vec![16_777_218.0]]).unwrap(),
            vec![16_777_216.0]
        );
        let rows = [vec![0.0, 0.0]];
        let centers = [vec![1.0, 1e-4], vec![1.0, 0.0]];
        assert_eq!(
            squared_distances(&rows, &centers).unwrap(),
            vec![vec![1.0, 1.0]]
        );
        let double = crate::vectors_f64::squared_distances(
            &[vec![0.0, 0.0]],
            &[vec![1.0, f64::from(1e-4_f32)], vec![1.0, 0.0]],
        )
        .unwrap();
        assert!(
            double[0][0] > double[0][1],
            "promotion changes the nearest-center tie"
        );
    }

    #[test]
    fn fast_axis_reduction_keeps_numpy_block_order_and_nonfinite_values() {
        for (width, expected) in [
            (8, 100_000_000.0),
            (129, 100_000_120.0),
            (257, 100_000_240.0),
        ] {
            let mut row = vec![1.0; width];
            row[0] = 1e4;
            assert_eq!(
                squared_distances(&[row], &[vec![0.0; width]]).unwrap()[0][0],
                expected
            );
        }
        assert!(squared_distances(&[vec![f32::NAN]], &[vec![0.0]]).unwrap()[0][0].is_nan());
        assert!(mean(&[vec![f32::NAN], vec![0.0]]).unwrap()[0].is_nan());
    }

    #[test]
    fn validates_shapes_without_losing_empty_axes() {
        assert!(mean(&[]).is_err());
        assert!(squared_distances(&[vec![1.0]], &[vec![]]).is_err());
        assert!(squared_distances(&[], &[vec![1.0], vec![]]).is_err());
        assert_eq!(squared_distances(&[], &[]).unwrap(), Vec::<Vec<f32>>::new());
        assert_eq!(
            squared_distances(&[vec![]], &[vec![], vec![]]).unwrap(),
            vec![vec![0.0, 0.0]]
        );
    }
}
