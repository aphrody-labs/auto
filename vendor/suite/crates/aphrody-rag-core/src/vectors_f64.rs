// SPDX-License-Identifier: Apache-2.0
//! Batched float64 kernels for RAPTOR. The Python seam keeps tree policy,
//! array shape and ordering; the arithmetic has one owner here.

/// A batch must be rectangular; empty batches are accepted.
pub(crate) fn dimensions<T>(rows: &[Vec<T>]) -> Result<Option<usize>, &'static str> {
    let width = rows.first().map(Vec::len);
    if rows.iter().any(|row| Some(row.len()) != width) {
        return Err("embedding batch must be rectangular");
    }
    Ok(width)
}

// Match NumPy fast-axis reduction ordering (eight lanes, 128-element blocks).
// Algorithm reference: numpy/_core/src/umath/loops_utils.h.src, pairwise_sum.
macro_rules! numpy_sum {
    ($name:ident, $float:ty) => {
        pub(crate) fn $name<F: Fn(usize) -> $float>(length: usize, at: &F) -> $float {
            fn reduce<F: Fn(usize) -> $float>(start: usize, length: usize, at: &F) -> $float {
                if length < 8 {
                    return (start..start + length).fold(-0.0, |sum, index| sum + at(index));
                }
                if length > 128 {
                    let split = (length / 2) & !7;
                    return reduce(start, split, at) + reduce(start + split, length - split, at);
                }
                let mut lanes: [$float; 8] = std::array::from_fn(|index| at(start + index));
                let aligned = length & !7;
                for block in (8..aligned).step_by(8) {
                    for (lane, sum) in lanes.iter_mut().enumerate() {
                        *sum += at(start + block + lane);
                    }
                }
                let low = (lanes[0] + lanes[1]) + (lanes[2] + lanes[3]);
                let high = (lanes[4] + lanes[5]) + (lanes[6] + lanes[7]);
                (aligned..length).fold(low + high, |sum, index| sum + at(start + index))
            }
            // NumPy's add reduction combines its zero identity with the block.
            0.0 + reduce(0, length, at)
        }
    };
}
numpy_sum!(sum_f64, f64);
numpy_sum!(sum_f32, f32);

/// L2 normalize each row with the RAPTOR 1e-12 denominator clamp.
/// NaNs propagate, matching the former NumPy maximum rather than f64::max.
pub fn normalize(rows: &[Vec<f64>]) -> Result<Vec<Vec<f64>>, &'static str> {
    dimensions(rows)?;
    Ok(rows
        .iter()
        .map(|row| {
            let norm = row.iter().map(|value| value * value).sum::<f64>().sqrt();
            let denominator = if norm < 1e-12 { 1e-12 } else { norm };
            row.iter().map(|value| value / denominator).collect()
        })
        .collect())
}

/// Row-by-row matrix product left * right^T, without changing row order.
pub fn similarities(left: &[Vec<f64>], right: &[Vec<f64>]) -> Result<Vec<Vec<f64>>, &'static str> {
    let left_width = dimensions(left)?;
    let right_width = dimensions(right)?;
    if left_width.is_some() && right_width.is_some() && left_width != right_width {
        return Err("embedding dimensions do not match");
    }
    if left.is_empty() || right.is_empty() {
        return Ok(vec![vec![]; left.len()]);
    }
    let width = left_width.unwrap_or(0);
    let left_flat: Vec<f64> = left.iter().flatten().copied().collect();
    let right_flat: Vec<f64> = right.iter().flatten().copied().collect();
    let product = similarities_flat(&left_flat, &right_flat, left.len(), right.len(), width)?;
    if right.is_empty() {
        return Ok(vec![vec![]; left.len()]);
    }
    Ok(product
        .chunks_exact(right.len())
        .map(<[f64]>::to_vec)
        .collect())
}

/// Contiguous batch product without copying the input into owned matrices.
/// Identical input batches use lower-triangular tiles and mirror the result.
pub fn similarities_flat(
    left: &[f64],
    right: &[f64],
    left_rows: usize,
    right_rows: usize,
    width: usize,
) -> Result<Vec<f64>, &'static str> {
    let left_matrix = ndarray::ArrayView2::from_shape((left_rows, width), left)
        .map_err(|_| "left batch shape mismatch")?;
    let right_matrix = ndarray::ArrayView2::from_shape((right_rows, width), right)
        .map_err(|_| "right batch shape mismatch")?;
    let output_size = left_rows
        .checked_mul(right_rows)
        .filter(|size| *size <= isize::MAX as usize / 8)
        .ok_or("similarity result shape overflow")?;
    if left_rows == 0 || right_rows == 0 || width == 0 {
        return Ok(vec![0.0; output_size]);
    }
    if left_rows != right_rows || left != right {
        return Ok(left_matrix
            .dot(&right_matrix.t())
            .into_raw_vec_and_offset()
            .0);
    }
    let mut result = vec![0.0; output_size];
    const TILE: usize = 256;
    for row_start in (0..left_rows).step_by(TILE) {
        let row_end = (row_start + TILE).min(left_rows);
        for col_start in (0..=row_start).step_by(TILE) {
            let col_end = (col_start + TILE).min(left_rows);
            let rows =
                left_matrix.slice_axis(ndarray::Axis(0), ndarray::Slice::from(row_start..row_end));
            let columns =
                right_matrix.slice_axis(ndarray::Axis(0), ndarray::Slice::from(col_start..col_end));
            let product = rows.dot(&columns.t());
            for ((i, j), value) in product.indexed_iter() {
                let row = row_start + i;
                let col = col_start + j;
                if col > row {
                    continue;
                }
                result[row * left_rows + col] = *value;
                result[col * left_rows + row] = *value;
            }
        }
    }
    Ok(result)
}

/// Mean embedding in input order. An empty batch has no prototype.
pub fn mean(rows: &[Vec<f64>]) -> Result<Vec<f64>, &'static str> {
    let width = dimensions(rows)?.ok_or("mean requires at least one embedding")?;
    if width == 1 {
        return Ok(vec![
            sum_f64(rows.len(), &|index| rows[index][0]) / rows.len() as f64,
        ]);
    }
    let mut result = vec![0.0; width];
    for row in rows {
        for (total, value) in result.iter_mut().zip(row) {
            *total += value;
        }
    }
    for total in &mut result {
        *total /= rows.len() as f64;
    }
    Ok(result)
}

/// Squared Euclidean distances, in row-major row/centroid order.
/// Subtract before squaring (no dot-product expansion or normalization),
/// use NumPy fast-axis reduction order, and propagate NaNs.
pub fn squared_distances(
    rows: &[Vec<f64>],
    centroids: &[Vec<f64>],
) -> Result<Vec<Vec<f64>>, &'static str> {
    let row_width = dimensions(rows)?;
    let centroid_width = dimensions(centroids)?;
    if row_width.is_some() && centroid_width.is_some() && row_width != centroid_width {
        return Err("embedding dimensions do not match");
    }
    rows.len()
        .checked_mul(centroids.len())
        .filter(|size| *size <= isize::MAX as usize / 8)
        .ok_or("distance result shape overflow")?;
    Ok(rows
        .iter()
        .map(|row| {
            centroids
                .iter()
                .map(|centroid| {
                    sum_f64(row.len(), &|index| {
                        let difference = row[index] - centroid[index];
                        difference * difference
                    })
                })
                .collect()
        })
        .collect())
}

/// Recompute normalized cluster means in one batch. Empty clusters retain
/// their previous center, and zero means remain zero (no epsilon clamp here).
pub fn update_centers(
    rows: &[Vec<f64>],
    labels: &[usize],
    centers: &[Vec<f64>],
) -> Result<Vec<Vec<f64>>, &'static str> {
    let width = dimensions(centers)?.ok_or("at least one center is required")?;
    if dimensions(rows)?.is_some_and(|row_width| row_width != width) || labels.len() != rows.len() {
        return Err("rows, labels and centers have incompatible dimensions");
    }
    if labels.iter().any(|label| *label >= centers.len()) {
        return Err("cluster label is outside the centers batch");
    }
    let mut sums = vec![vec![0.0; width]; centers.len()];
    let mut counts = vec![0_usize; centers.len()];
    for (row, label) in rows.iter().zip(labels) {
        counts[*label] += 1;
        for (sum, value) in sums[*label].iter_mut().zip(row) {
            *sum += value;
        }
    }
    for (index, center) in sums.iter_mut().enumerate() {
        if counts[index] == 0 {
            center.clone_from(&centers[index]);
            continue;
        }
        for value in center.iter_mut() {
            *value /= counts[index] as f64;
        }
        let norm = center.iter().map(|value| value * value).sum::<f64>().sqrt();
        if norm > 0.0 {
            for value in center.iter_mut() {
                *value /= norm;
            }
        }
    }
    Ok(sums)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn euclidean_means_and_distances_keep_scale_order_and_ties() {
        let center = mean(&[vec![2.0, 4.0], vec![4.0, 8.0]]).unwrap();
        assert_eq!(center, vec![3.0, 6.0]);
        assert_eq!(
            squared_distances(&[vec![3.0, 6.0], vec![2.0, 4.0]], &[center, vec![1.0, 2.0]])
                .unwrap(),
            vec![vec![0.0, 20.0], vec![5.0, 5.0]]
        );
        // Direct subtraction retains small distances between large values.
        assert_eq!(
            squared_distances(&[vec![1e16 + 2.0]], &[vec![1e16]]).unwrap(),
            vec![vec![4.0]]
        );
        assert!(squared_distances(&[vec![f64::NAN]], &[vec![0.0]]).unwrap()[0][0].is_nan());
        assert!(mean(&[vec![f64::NAN], vec![1.0]]).unwrap()[0].is_nan());
    }

    #[test]
    fn euclidean_distances_preserve_empty_shapes_and_validate_every_batch() {
        assert_eq!(
            squared_distances(&[], &[vec![1.0]]).unwrap(),
            Vec::<Vec<f64>>::new()
        );
        assert_eq!(
            squared_distances(&[vec![1.0], vec![2.0]], &[]).unwrap(),
            vec![Vec::<f64>::new(), Vec::new()]
        );
        assert_eq!(
            squared_distances(&[vec![], vec![]], &[vec![]]).unwrap(),
            vec![vec![0.0], vec![0.0]]
        );
        assert!(squared_distances(&[vec![1.0]], &[vec![1.0, 2.0]]).is_err());
        assert!(squared_distances(&[], &[vec![1.0], vec![]]).is_err());
        assert!(squared_distances(&[vec![1.0], vec![]], &[]).is_err());
    }
    #[test]
    fn preserves_float64_and_small_zero_rows() {
        assert_eq!(
            normalize(&[vec![3.0, 4.0], vec![0.0, 0.0], vec![1e-14, 0.0]]).unwrap(),
            vec![vec![0.6, 0.8], vec![0.0, 0.0], vec![0.01, 0.0]]
        );
        let precise = 1.0 + 1e-10;
        assert_eq!(
            similarities(&[vec![precise]], &[vec![1.0]]).unwrap(),
            vec![vec![precise]]
        );
        assert!(normalize(&[vec![f64::NAN]]).unwrap()[0][0].is_nan());
    }
    #[test]
    fn batch_product_and_mean_validate_shapes() {
        assert_eq!(
            similarities(&[vec![1.0, 2.0]], &[vec![3.0, 4.0], vec![0.0, 1.0]]).unwrap(),
            vec![vec![11.0, 2.0]]
        );
        assert_eq!(
            mean(&[vec![1.0, 2.0], vec![3.0, 4.0]]).unwrap(),
            vec![2.0, 3.0]
        );
        assert_eq!(normalize(&[]).unwrap(), Vec::<Vec<f64>>::new());
        assert!(normalize(&[vec![1.0], vec![1.0, 2.0]]).is_err());
        assert!(similarities(&[vec![1.0]], &[vec![1.0, 2.0]]).is_err());
        assert!(mean(&[]).is_err());
    }
    #[test]
    fn symmetric_tiles_preserve_both_triangles_across_tile_boundaries() {
        let rows = 257;
        let width = 3;
        let input: Vec<f64> = (0..rows * width).map(|index| (index % 10) as f64).collect();
        let actual = similarities_flat(&input, &input, rows, rows, width).unwrap();
        for left in 0..rows {
            for right in 0..rows {
                let expected: f64 = (0..width)
                    .map(|dim| input[left * width + dim] * input[right * width + dim])
                    .sum();
                assert_eq!(actual[left * rows + right], expected);
            }
        }
        assert!(similarities_flat(&input, &input, rows + 1, rows, width).is_err());
    }
    #[test]
    fn empty_and_zero_centers_preserve_bucket_semantics() {
        let centers = vec![vec![1.0, 0.0], vec![0.0, 1.0], vec![0.5, 0.5]];
        assert_eq!(
            update_centers(&[vec![1.0, 0.0], vec![-1.0, 0.0]], &[0, 0], &centers).unwrap(),
            vec![vec![0.0, 0.0], vec![0.0, 1.0], vec![0.5, 0.5]]
        );
        assert!(update_centers(&[vec![1.0, 0.0]], &[3], &centers).is_err());
        assert!(update_centers(&[vec![1.0, 0.0]], &[], &centers).is_err());
    }
}
