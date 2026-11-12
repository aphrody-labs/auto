// SPDX-License-Identifier: Apache-2.0
//! Fusion, dedup, source-weighting/quota, MMR, and vector-kernel tests.

use aphrody_rag_core::fusion::{
    QuotaRule, ScoreScaling, SourceWeight, WeightedCandidate, apply_source_weights, cosine,
    cosine_with_norm, dedup_by_key, dot, dot_i8, fuse_scores, l2_normalize, merge_top_k,
    minmax_normalize, mmr, norm, quantize_i8, rrf, rrf_weighted, top_k_dot, top_k_exact, top_k_i8,
};

#[test]
fn rrf_favors_items_ranked_high_in_multiple_lists() {
    let a = ["x", "y", "z"];
    let b = ["y", "z", "x"];
    let fused = rrf(&[&a, &b], 60.0);
    // "y" is rank 1 in b and rank 2 in a: sum(1/(60+2), 1/(60+1)) — the best
    // combined score among the three.
    assert_eq!(fused[0].0, "y");
    let ids: Vec<&str> = fused.iter().map(|(id, _)| *id).collect();
    assert_eq!(ids.len(), 3);
    assert!(ids.contains(&"x") && ids.contains(&"z"));
}

#[test]
fn rrf_ties_break_by_first_appearance() {
    // Two disjoint singleton lists produce identical scores for both ids;
    // "a" appeared first (list 0), so it must sort first.
    let a = ["a"];
    let b = ["b"];
    let fused = rrf(&[&a, &b], 60.0);
    assert_eq!(fused[0].0, "a");
    assert_eq!(fused[1].0, "b");
    assert!((fused[0].1 - fused[1].1).abs() < f64::EPSILON);
}

#[test]
fn rrf_weighted_scales_each_list() {
    let a = ["p"];
    let b = ["q"];
    let fused = rrf_weighted(&[(&a[..], 10.0), (&b[..], 1.0)], 60.0);
    assert_eq!(fused[0].0, "p");
    assert!(fused[0].1 > fused[1].1);
}

#[test]
fn dedup_by_key_keeps_first_occurrence() {
    let items = vec![("a", 1), ("b", 2), ("a", 3)];
    let deduped = dedup_by_key(items, |(k, _)| *k);
    assert_eq!(deduped, vec![("a", 1), ("b", 2)]);
}

fn candidate(id: &str, source: &str, kind: &str, score: f64) -> WeightedCandidate<String> {
    WeightedCandidate {
        id: id.to_string(),
        source_id: Some(source.to_string()),
        kind: Some(kind.to_string()),
        score,
    }
}

#[test]
fn apply_source_weights_boosts_then_fills_quota() {
    // 5 "wiki" hits outrank 3 "manga" hits before boosting.
    let mut cands = vec![
        candidate("w1", "wiki", "page", 0.9),
        candidate("w2", "wiki", "page", 0.8),
        candidate("w3", "wiki", "page", 0.7),
        candidate("w4", "wiki", "page", 0.6),
        candidate("w5", "wiki", "page", 0.5),
        candidate("m1", "manga", "panel", 0.4),
        candidate("m2", "manga", "panel", 0.35),
    ];
    cands.reverse(); // input order shouldn't matter
    let weights = vec![SourceWeight {
        source_id: "manga".to_string(),
        weight: 2.2,
    }];
    let quota = QuotaRule {
        source_id: "manga".to_string(),
        quota: 2,
        min_score: 0.3,
    };
    let top = apply_source_weights(cands, &weights, Some(&quota), &[], 3);
    let manga_count = top
        .iter()
        .filter(|c| c.source_id.as_deref() == Some("manga"))
        .count();
    assert_eq!(manga_count, 2, "{top:?}");
    assert_eq!(top.len(), 3);
}

#[test]
fn apply_source_weights_quota_evicts_filler_never_protected() {
    let cands = vec![
        candidate("protected", "wiki", "canon", 0.9),
        candidate("filler", "wiki", "other", 0.8),
        candidate("m1", "manga", "panel", 0.7),
    ];
    let weights = vec![SourceWeight {
        source_id: "manga".to_string(),
        weight: 1.0,
    }];
    let quota = QuotaRule {
        source_id: "manga".to_string(),
        quota: 1,
        min_score: 0.0,
    };
    let top = apply_source_weights(cands, &weights, Some(&quota), &["canon".to_string()], 2);
    let ids: Vec<&str> = top.iter().map(|c| c.id.as_str()).collect();
    assert!(ids.contains(&"protected"), "{ids:?}");
    assert!(ids.contains(&"m1"), "{ids:?}");
    assert!(!ids.contains(&"filler"), "{ids:?}");
}

#[test]
fn mmr_diversifies_away_from_near_duplicates() {
    let candidates = vec![
        ("a".to_string(), vec![1.0_f32, 0.0], 1.0),
        ("a_dup".to_string(), vec![0.99_f32, 0.01], 0.95),
        ("b".to_string(), vec![0.0_f32, 1.0], 0.9),
    ];
    let picked = mmr(&candidates, 0.5, 2);
    assert_eq!(picked[0], "a");
    assert_eq!(
        picked[1], "b",
        "MMR should prefer the diverse 'b' over the near-duplicate 'a_dup'"
    );
}

#[test]
fn vector_kernels_agree_on_identical_vectors() {
    let v = [1.0_f32, 2.0, 3.0];
    assert!((cosine(&v, &v) - 1.0).abs() < 1e-6);
    assert!((dot(&v, &v) - 14.0).abs() < 1e-6);
    let mut n = v;
    l2_normalize(&mut n);
    assert!((dot(&n, &n) - 1.0).abs() < 1e-5);
}

#[test]
fn quantize_i8_round_trips_within_tolerance() {
    let v = [1.0_f32, -1.0, 0.5, -0.5, 0.0];
    let (q, scale) = quantize_i8(&v);
    for (orig, q_i) in v.iter().zip(&q) {
        let back = f32::from(*q_i) * scale;
        assert!((back - orig).abs() < 0.02, "{orig} vs {back}");
    }
    // dot_i8 on the vector's own quantization approximates the true self-dot
    // (sum of squares == 2.5) once rescaled by `scale * scale`.
    let approx_self_dot = dot_i8(&q, &q) as f32 * scale * scale;
    assert!(
        (approx_self_dot - dot(&v, &v)).abs() < 0.05,
        "approx={approx_self_dot}"
    );
}

#[test]
fn quantize_i8_all_zero_input_is_exact() {
    let v = [0.0_f32; 4];
    let (q, scale) = quantize_i8(&v);
    assert_eq!(scale, 0.0);
    assert!(q.iter().all(|&x| x == 0));
}

#[test]
fn top_k_exact_returns_best_k_by_cosine() {
    let query = [1.0_f32, 0.0];
    let matrix: Vec<f32> = vec![
        0.0, 1.0, // row 0: orthogonal
        1.0, 0.0, // row 1: identical
        0.9, 0.1, // row 2: close
        -1.0, 0.0, // row 3: opposite
    ];
    let top = top_k_exact(&query, &matrix, 2, 2);
    assert_eq!(top.len(), 2);
    assert_eq!(top[0].0, 1);
    assert_eq!(top[1].0, 2);
}

/// Deterministic pseudo-random values in `[-1, 1)` (no `rand` dependency).
fn lcg_vec(seed: &mut u64, len: usize) -> Vec<f32> {
    (0..len)
        .map(|_| {
            *seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((*seed >> 33) as f32 / (1_u64 << 31) as f32) * 2.0 - 1.0
        })
        .collect()
}

/// `rows` unit-normalised vectors of width `dim`, row-major.
fn unit_rows(rows: usize, dim: usize, seed: &mut u64) -> Vec<f32> {
    let mut matrix = Vec::with_capacity(rows * dim);
    for _ in 0..rows {
        let mut row = lcg_vec(seed, dim);
        l2_normalize(&mut row);
        matrix.extend(row);
    }
    matrix
}

#[test]
fn dot_matches_a_wide_sum_across_lane_boundaries() {
    let mut seed = 7;
    for len in [0_usize, 1, 7, 8, 9, 16, 19, 64, 65] {
        let a = lcg_vec(&mut seed, len);
        let b = lcg_vec(&mut seed, len);
        let wide: f64 = a
            .iter()
            .zip(&b)
            .map(|(x, y)| f64::from(*x) * f64::from(*y))
            .sum();
        assert!((f64::from(dot(&a, &b)) - wide).abs() < 1e-3, "len {len}");
    }
    assert_eq!(dot(&[1.0, 2.0], &[1.0]), 0.0, "length mismatch is zero");
}

#[test]
fn norm_is_the_euclidean_length() {
    assert!((norm(&[3.0, 4.0]) - 5.0).abs() < 1e-6);
    assert_eq!(norm(&[]), 0.0);
}

#[test]
fn cosine_with_norm_is_bit_identical_to_cosine() {
    let mut seed = 11;
    for _ in 0..20 {
        let a = lcg_vec(&mut seed, 37);
        let b = lcg_vec(&mut seed, 37);
        assert_eq!(
            cosine(&a, &b).to_bits(),
            cosine_with_norm(&a, norm(&a), &b).to_bits()
        );
    }
    assert_eq!(cosine_with_norm(&[1.0, 0.0], 1.0, &[1.0]), 0.0);
    assert_eq!(cosine_with_norm(&[0.0, 0.0], 0.0, &[1.0, 0.0]), 0.0);
}

#[test]
fn top_k_dot_matches_top_k_exact_on_unit_rows() {
    let mut seed = 21;
    let dim = 24;
    let matrix = unit_rows(300, dim, &mut seed);
    let query = matrix[17 * dim..18 * dim].to_vec();
    let exact = top_k_exact(&query, &matrix, dim, 5);
    let fast = top_k_dot(&query, &matrix, dim, 5);
    assert_eq!(exact[0].0, 17);
    assert_eq!(
        exact.iter().map(|(row, _)| *row).collect::<Vec<_>>(),
        fast.iter().map(|(row, _)| *row).collect::<Vec<_>>()
    );
    for ((_, a), (_, b)) in exact.iter().zip(&fast) {
        assert!((a - b).abs() < 1e-5);
    }
    assert!(
        top_k_dot(&[1.0], &matrix, dim, 5).is_empty(),
        "wrong query width yields nothing"
    );
}

#[test]
fn top_k_i8_finds_the_exact_nearest_row_and_most_of_the_top_k() {
    let mut seed = 33;
    let dim = 32;
    let rows = 200;
    let matrix = unit_rows(rows, dim, &mut seed);
    let mut codes = Vec::with_capacity(rows * dim);
    let mut scales = Vec::with_capacity(rows);
    for row in matrix.chunks_exact(dim) {
        let (q, scale) = quantize_i8(row);
        codes.extend(q);
        scales.push(scale);
    }
    let query = matrix[17 * dim..18 * dim].to_vec();
    let exact: Vec<usize> = top_k_dot(&query, &matrix, dim, 5)
        .iter()
        .map(|(r, _)| *r)
        .collect();
    let approx = top_k_i8(&query, &codes, &scales, dim, 5);
    assert_eq!(approx[0].0, 17, "the stored row itself must rank first");
    assert!((approx[0].1 - 1.0).abs() < 0.02, "score {}", approx[0].1);
    let overlap = approx.iter().filter(|(r, _)| exact.contains(r)).count();
    assert!(
        overlap >= 3,
        "int8 top-5 overlaps exact top-5 in {overlap} rows"
    );
}

#[test]
fn merge_top_k_equals_a_single_scan() {
    let mut seed = 44;
    let dim = 24;
    let matrix = unit_rows(300, dim, &mut seed);
    let query = lcg_vec(&mut seed, dim);
    let mut unit_query = query;
    l2_normalize(&mut unit_query);
    let single = top_k_dot(&unit_query, &matrix, dim, 7);
    let shard_rows = 100;
    let parts: Vec<Vec<(usize, f32)>> = (0..3)
        .map(|shard| {
            let slice = &matrix[shard * shard_rows * dim..(shard + 1) * shard_rows * dim];
            top_k_dot(&unit_query, slice, dim, 7)
                .into_iter()
                .map(|(row, score)| (row + shard * shard_rows, score))
                .collect()
        })
        .collect();
    assert_eq!(merge_top_k(parts, 7), single);
}

#[test]
fn top_k_breaks_ties_by_lower_row_and_ranks_nan_last() {
    let query = [1.0_f32, 0.0];
    let matrix = [1.0_f32, 0.0, 1.0, 0.0, f32::NAN, 0.0];
    let all = top_k_dot(&query, &matrix, 2, 3);
    assert_eq!(
        all.iter().map(|(row, _)| *row).collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert_eq!(all[2].1, f32::NEG_INFINITY);
    let two = top_k_dot(&query, &matrix, 2, 2);
    assert_eq!(
        two.iter().map(|(row, _)| *row).collect::<Vec<_>>(),
        vec![0, 1]
    );
}

#[test]
fn fuse_scores_min_max_matches_the_llamaindex_relative_score_definition() {
    let a = [("a", 10.0), ("b", 5.0), ("c", 0.0)];
    let b = [("b", 0.9), ("d", 0.1)];
    let fused = fuse_scores(&[(&a[..], 1.0), (&b[..], 1.0)], ScoreScaling::MinMax);
    let ids: Vec<&str> = fused.iter().map(|(id, _)| *id).collect();
    // a = 1.0 * 0.5, b = 0.5 * 0.5 + 1.0 * 0.5, c = d = 0; ties by first appearance.
    assert_eq!(ids, vec!["b", "a", "c", "d"]);
    assert!((fused[0].1 - 0.75).abs() < 1e-12);
    assert!((fused[1].1 - 0.5).abs() < 1e-12);
    assert_eq!(fused[2].1, 0.0);
}

#[test]
fn fuse_scores_constant_lists_and_weights() {
    let flat = [("x", 3.0), ("y", 3.0)];
    let fused = fuse_scores(&[(&flat[..], 1.0)], ScoreScaling::MinMax);
    assert_eq!(fused, vec![("x", 1.0), ("y", 1.0)]);
    let zero = [("z", 0.0)];
    assert_eq!(
        fuse_scores(&[(&zero[..], 1.0)], ScoreScaling::MinMax),
        vec![("z", 0.0)]
    );

    let left = [("a", 1.0)];
    let right = [("b", 1.0)];
    let weighted = fuse_scores(&[(&left[..], 3.0), (&right[..], 1.0)], ScoreScaling::MinMax);
    assert_eq!(weighted[0].0, "a");
    assert!((weighted[0].1 - 0.75).abs() < 1e-12 && (weighted[1].1 - 0.25).abs() < 1e-12);

    let none: [(&str, f64); 0] = [];
    assert!(fuse_scores(&[(&none[..], 1.0)], ScoreScaling::MinMax).is_empty());
}

#[test]
fn fuse_scores_dist_based_uses_three_sigma_bounds_without_clamping() {
    let list = [("a", 1.0), ("b", 2.0), ("c", 3.0)];
    let fused = fuse_scores(&[(&list[..], 1.0)], ScoreScaling::DistBased);
    let score = |id: &str| {
        fused
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, s)| *s)
            .unwrap()
    };
    assert!((score("b") - 0.5).abs() < 1e-9);
    assert!(
        (score("a") + score("c") - 1.0).abs() < 1e-9,
        "symmetric around the mean"
    );
    assert!(score("c") > score("b") && score("b") > score("a"));
    // mean 2, population sigma sqrt(2/3): the bounds sit well outside the data, so scores stay
    // strictly inside (0, 1) instead of touching the ends as min-max would.
    assert!(score("a") > 0.0 && score("c") < 1.0);
}

#[test]
fn minmax_normalize_scales_to_the_unit_interval() {
    let mut values = [2.0, 4.0, 6.0];
    minmax_normalize(&mut values);
    assert_eq!(values, [0.0, 0.5, 1.0]);
    let mut flat = [3.0, 3.0];
    minmax_normalize(&mut flat);
    assert_eq!(flat, [1.0, 1.0]);
    minmax_normalize(&mut []);
}
