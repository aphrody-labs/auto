//! Knowledge base chunking and MMR cosine similarity retrieval backed by `aphrody-rag-core`.

use aphrody_rag_core::{ChunkOptions, Chunker, Language, MarkdownChunker, ProseChunker, detect_language, fusion};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Default target chunk size in characters.
pub const DEFAULT_CHUNK_SIZE: usize = 1400;
/// Guard limit preventing multi-megabyte single-payload OOM in Wasm/native calls.
pub const MAX_TEXT_BYTES: usize = 5_000_000;
/// Maximum number of top-k neighbors returned per query.
pub const MAX_K: usize = 100;

/// Chunking or vector search input error.
#[derive(Debug, Error)]
pub enum KnowledgeError {
    #[error("text exceeds {0} bytes")]
    TextTooLarge(usize),
    #[error("invalid chunk size {0}")]
    InvalidChunkSize(usize),
    #[error("invalid vector query: {0}")]
    InvalidVectors(String),
}

/// Extracted knowledge chunk ready for embedding and citation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub index: usize,
    pub text: String,
    pub heading: Option<String>,
    pub start_line: u32,
    pub end_line: u32,
}

/// Nearest neighbor match in cosine similarity space.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Neighbor {
    pub index: usize,
    pub score: f64,
}

/// Splits Markdown (`.md`/`.markdown`) or prose text into overlapping citation chunks.
pub fn chunk_text(source: &str, text: &str, chunk_size: Option<usize>) -> Result<Vec<Chunk>, KnowledgeError> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(KnowledgeError::TextTooLarge(MAX_TEXT_BYTES));
    }
    let size = chunk_size.unwrap_or(DEFAULT_CHUNK_SIZE);
    if !(50..=32_000).contains(&size) {
        return Err(KnowledgeError::InvalidChunkSize(size));
    }
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let opts = ChunkOptions { max_chars: size, overlap_pct: 0.15, ..ChunkOptions::default() };
    let lang = detect_language(source);
    let raw_chunks = match lang {
        Language::Markdown => MarkdownChunker.chunk(source, text, &opts),
        _ => ProseChunker.chunk(source, text, &opts),
    };
    Ok(raw_chunks
        .into_iter()
        .enumerate()
        .map(|(index, c)| Chunk {
            index,
            text: c.text,
            heading: c.symbol,
            start_line: c.start_line,
            end_line: c.end_line,
        })
        .collect())
}

/// Returns top-`k` rows from a flat `f32` matrix by cosine similarity with optional MMR diversity (`0.0..=1.0`).
pub fn nearest_vectors(
    query: &[f32],
    matrix: &[f32],
    dimension: usize,
    k: usize,
    diversity: Option<f64>,
) -> Result<Vec<Neighbor>, KnowledgeError> {
    if dimension == 0 || query.len() != dimension {
        return Err(KnowledgeError::InvalidVectors("query length must match non-zero dimension".into()));
    }
    if !matrix.len().is_multiple_of(dimension) {
        return Err(KnowledgeError::InvalidVectors("matrix length must be a multiple of dimension".into()));
    }
    let rows = matrix.len() / dimension;
    if rows == 0 || k == 0 {
        return Ok(Vec::new());
    }
    let k = k.min(MAX_K).min(rows);
    let query_norm: f64 = query.iter().map(|&x| f64::from(x) * f64::from(x)).sum::<f64>().sqrt();
    if query_norm <= 0.0 || !query_norm.is_finite() {
        return Ok(Vec::new());
    }

    let mut scored: Vec<(usize, f64)> = (0..rows)
        .filter_map(|row_idx| {
            let row = &matrix[row_idx * dimension..(row_idx + 1) * dimension];
            let score = cosine_similarity(query, query_norm, row);
            score.is_finite().then_some((row_idx, score))
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let Some(lambda) = diversity.map(|l| l.clamp(0.0, 1.0)) else {
        return Ok(scored.into_iter().take(k).map(|(index, score)| Neighbor { index, score }).collect());
    };

    let pool_len = (k * 4).min(scored.len());
    let pool = &scored[..pool_len];
    let candidates: Vec<(usize, Vec<f32>, f64)> = pool
        .iter()
        .map(|&(idx, score)| (idx, matrix[idx * dimension..(idx + 1) * dimension].to_vec(), score))
        .collect();
    let picked = fusion::mmr(&candidates, lambda, k);
    Ok(picked
        .into_iter()
        .filter_map(|idx| {
            pool.iter().find(|&&(p_idx, _)| p_idx == idx).map(|&(index, score)| Neighbor { index, score })
        })
        .collect())
}

fn cosine_similarity(query: &[f32], query_norm: f64, row: &[f32]) -> f64 {
    let mut dot = 0.0f64;
    let mut norm_sq = 0.0f64;
    for (&q, &r) in query.iter().zip(row.iter()) {
        let qf = f64::from(q);
        let rf = f64::from(r);
        dot += qf * rf;
        norm_sq += rf * rf;
    }
    let row_norm = norm_sq.sqrt();
    if row_norm <= 0.0 { 0.0 } else { dot / (query_norm * row_norm) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_prose_and_markdown_cleanly() {
        let md = "# Guide\n\n## Warranty\n\n".to_owned() + &"Coverage lasts two years on parts. ".repeat(30);
        let chunks = chunk_text("guide.md", &md, Some(250)).unwrap();
        assert!(chunks.len() > 2);
        assert_eq!(chunks[0].index, 0);
        assert!(chunks[0].heading.as_deref().unwrap_or("").contains("Warranty"));
    }

    #[test]
    fn finds_nearest_cosine_neighbors_with_and_without_mmr() {
        let query = [0.0f32, 2.0];
        let matrix = [1.0f32, 0.0, 0.0, 1.0, 1.0, 1.0];
        let hits = nearest_vectors(&query, &matrix, 2, 2, None).unwrap();
        assert_eq!(hits[0].index, 1);
        assert!((hits[0].score - 1.0).abs() < 1e-6);
        assert_eq!(hits[1].index, 2);

        let diverse = nearest_vectors(&query, &matrix, 2, 2, Some(0.5)).unwrap();
        assert_eq!(diverse.len(), 2);
    }
}
