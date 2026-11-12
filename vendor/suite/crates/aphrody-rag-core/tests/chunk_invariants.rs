// SPDX-License-Identifier: Apache-2.0
//! Cross-chunker invariants: line coverage, `start_line <= end_line`,
//! max_chars respect (barring an unsplittable single line), determinism,
//! hash correctness, and CRLF/LF parity.

use std::collections::HashSet;

use aphrody_rag_core::{Chunk, ChunkOptions, chunker_for_path};

fn non_blank_lines(source: &str) -> HashSet<u32> {
    source
        .split('\n')
        .enumerate()
        .filter(|(_, l)| !l.trim().is_empty())
        .map(|(i, _)| u32::try_from(i + 1).unwrap())
        .collect()
}

fn assert_covers_every_non_blank_line(path: &str, source: &str, chunks: &[Chunk]) {
    let normalized = source.replace("\r\n", "\n");
    let mut covered: HashSet<u32> = HashSet::new();
    for c in chunks {
        assert!(
            c.start_line <= c.end_line,
            "{path}: chunk {:?} has start>end",
            c.symbol
        );
        for l in c.start_line..=c.end_line {
            covered.insert(l);
        }
    }
    let required = non_blank_lines(&normalized);
    let missing: Vec<u32> = required.difference(&covered).copied().collect();
    assert!(
        missing.is_empty(),
        "{path}: lines not covered by any chunk: {missing:?}"
    );
}

fn assert_max_chars_respected(path: &str, chunks: &[Chunk], max_chars: usize) {
    for c in chunks {
        if c.text.len() > max_chars {
            // The only allowed excess is a single unsplittable line.
            assert_eq!(
                c.start_line,
                c.end_line,
                "{path}: oversized multi-line chunk {:?} ({} bytes)",
                c.symbol,
                c.text.len()
            );
        }
    }
}

fn assert_hash_correct(chunks: &[Chunk]) {
    for c in chunks {
        assert_eq!(c.hash, *blake3::hash(c.text.as_bytes()).as_bytes());
    }
}

const RUST_SRC: &str = r#"//! crate docs
use std::fmt;

/// Adds two numbers.
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn magnitude(&self) -> f64 {
        (self.x * self.x + self.y * self.y).sqrt()
    }
}

trait Shape {
    fn area(&self) -> f64;
}

mod inner {
    pub const ANSWER: u32 = 42;

    pub fn helper() -> u32 {
        ANSWER
    }
}

impl fmt::Display for Point {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "({}, {})", self.x, self.y)
    }
}
"#;

#[test]
fn rust_chunker_covers_every_line_and_names_symbols() {
    let chunks =
        chunker_for_path("src/lib.rs").chunk("src/lib.rs", RUST_SRC, &ChunkOptions::default());
    assert!(!chunks.is_empty());
    assert_covers_every_non_blank_line("src/lib.rs", RUST_SRC, &chunks);
    assert_hash_correct(&chunks);

    let symbols: Vec<&str> = chunks.iter().filter_map(|c| c.symbol.as_deref()).collect();
    assert!(symbols.contains(&"add"), "{symbols:?}");
    assert!(symbols.contains(&"Point"), "{symbols:?}");
    assert!(symbols.contains(&"Point::new"), "{symbols:?}");
    assert!(symbols.contains(&"Point::magnitude"), "{symbols:?}");
    assert!(symbols.contains(&"inner::helper"), "{symbols:?}");
    assert!(
        symbols
            .iter()
            .any(|s| s.starts_with("Point::fmt") || *s == "Point::fmt"),
        "{symbols:?}"
    );
}

#[test]
fn rust_chunker_deterministic() {
    let a = chunker_for_path("x.rs").chunk("x.rs", RUST_SRC, &ChunkOptions::default());
    let b = chunker_for_path("x.rs").chunk("x.rs", RUST_SRC, &ChunkOptions::default());
    assert_eq!(a, b);
}

#[test]
fn rust_chunker_crlf_matches_lf() {
    let crlf = RUST_SRC.replace('\n', "\r\n");
    let lf_chunks = chunker_for_path("a.rs").chunk("a.rs", RUST_SRC, &ChunkOptions::default());
    let crlf_chunks = chunker_for_path("a.rs").chunk("a.rs", &crlf, &ChunkOptions::default());
    let lf_texts: Vec<&str> = lf_chunks.iter().map(|c| c.text.as_str()).collect();
    let crlf_texts: Vec<&str> = crlf_chunks.iter().map(|c| c.text.as_str()).collect();
    assert_eq!(lf_texts, crlf_texts);
}

#[test]
fn rust_chunker_falls_back_on_parse_error() {
    let broken = "fn broken( {{{ not valid rust at all !!!";
    let chunks = chunker_for_path("broken.rs").chunk("broken.rs", broken, &ChunkOptions::default());
    assert!(
        !chunks.is_empty(),
        "a broken file must still produce chunks, never be dropped"
    );
    assert_covers_every_non_blank_line("broken.rs", broken, &chunks);
}

#[test]
fn rust_chunker_splits_oversized_item_with_overlap() {
    let mut body = String::from("pub fn huge() {\n");
    for i in 0..400 {
        body.push_str(&format!("    let v{i} = {i};\n\n"));
    }
    body.push_str("}\n");
    let opts = ChunkOptions {
        max_chars: 500,
        overlap_pct: 0.15,
        min_chars: 32,
        ..ChunkOptions::default()
    };
    let chunks = chunker_for_path("h.rs").chunk("h.rs", &body, &opts);
    assert!(
        chunks.len() > 1,
        "an oversized function must be split into more than one chunk"
    );
    assert_covers_every_non_blank_line("h.rs", &body, &chunks);
    assert_max_chars_respected("h.rs", &chunks, opts.max_chars);
}

const MARKDOWN_SRC: &str = r"# Install

Some intro text about installing the thing. It has two sentences.

## Linux

Run the linux installer. It just works.

```bash
curl -sSL https://example.com/install.sh | sh
```

## Windows

Run the windows installer instead.

# Usage

Call `run()` after installing.
";

#[test]
fn markdown_chunker_covers_lines_and_carries_heading_trail() {
    let chunks =
        chunker_for_path("README.md").chunk("README.md", MARKDOWN_SRC, &ChunkOptions::default());
    assert!(!chunks.is_empty());
    assert_covers_every_non_blank_line("README.md", MARKDOWN_SRC, &chunks);
    let trails: Vec<&str> = chunks.iter().filter_map(|c| c.symbol.as_deref()).collect();
    assert!(trails.contains(&"Install > Linux"), "{trails:?}");
    assert!(trails.contains(&"Install > Windows"), "{trails:?}");
    assert!(trails.contains(&"Usage"), "{trails:?}");
}

#[test]
fn markdown_chunker_never_splits_a_fence() {
    let chunks =
        chunker_for_path("README.md").chunk("README.md", MARKDOWN_SRC, &ChunkOptions::default());
    let fence_chunk = chunks
        .iter()
        .find(|c| c.text.contains("curl -sSL"))
        .expect("fence content present");
    assert!(fence_chunk.text.contains("```bash"));
    assert!(fence_chunk.text.trim_end().ends_with("```"));
}

const PYTHON_SRC: &str = "import os\n\n\ndef greet(name):\n    print(f\"hi {name}\")\n    return \
                          None\n\n\nclass Greeter:\n    def __init__(self, name):\n        \
                          self.name = name\n\n    def greet(self):\n        greet(self.name)\n";

#[test]
fn structural_chunker_python_covers_lines_and_names_defs() {
    let chunks = chunker_for_path("g.py").chunk("g.py", PYTHON_SRC, &ChunkOptions::default());
    assert!(!chunks.is_empty());
    assert_covers_every_non_blank_line("g.py", PYTHON_SRC, &chunks);
    let symbols: Vec<&str> = chunks.iter().filter_map(|c| c.symbol.as_deref()).collect();
    assert!(symbols.contains(&"greet"), "{symbols:?}");
    assert!(symbols.contains(&"Greeter"), "{symbols:?}");
}

const GO_SRC: &str = "package main\n\nimport \"fmt\"\n\nfunc add(a, b int) int {\n\treturn a + \
                      b\n}\n\ntype Point struct {\n\tX int\n\tY int\n}\n\nfunc main() \
                      {\n\tfmt.Println(add(1, 2))\n}\n";

#[test]
fn structural_chunker_go_covers_lines_and_names_funcs() {
    let chunks = chunker_for_path("m.go").chunk("m.go", GO_SRC, &ChunkOptions::default());
    assert!(!chunks.is_empty());
    assert_covers_every_non_blank_line("m.go", GO_SRC, &chunks);
    let symbols: Vec<&str> = chunks.iter().filter_map(|c| c.symbol.as_deref()).collect();
    assert!(symbols.contains(&"add"), "{symbols:?}");
    assert!(symbols.contains(&"main"), "{symbols:?}");
}

const PROSE_SRC: &str = "This is the first sentence. This is the second sentence! Is this the \
                         third sentence? Yes, it is the fourth. And a fifth one closes it out.";

#[test]
fn prose_chunker_covers_lines_and_respects_overlap() {
    let opts = ChunkOptions {
        max_chars: 40,
        overlap_pct: 0.15,
        min_chars: 8,
        ..ChunkOptions::default()
    };
    let chunks = chunker_for_path("notes.txt").chunk("notes.txt", PROSE_SRC, &opts);
    assert!(chunks.len() > 1);
    assert_covers_every_non_blank_line("notes.txt", PROSE_SRC, &chunks);
    // Consecutive chunks must share at least one sentence (the overlap).
    for w in chunks.windows(2) {
        let a_last_words: Vec<&str> = w[0].text.split_whitespace().collect();
        let b_first_words: Vec<&str> = w[1].text.split_whitespace().collect();
        let shares = a_last_words
            .iter()
            .rev()
            .take(4)
            .any(|w2| b_first_words.iter().take(6).any(|w3| w2 == w3));
        assert!(
            shares,
            "expected overlap between {:?} and {:?}",
            w[0].text, w[1].text
        );
    }
}

#[test]
fn toml_chunker_splits_by_table() {
    let toml = "[package]\nname = \"x\"\nversion = \"1\"\n\n[dependencies]\nserde = \"1\"\n";
    let chunks = chunker_for_path("Cargo.toml").chunk("Cargo.toml", toml, &ChunkOptions::default());
    assert_covers_every_non_blank_line("Cargo.toml", toml, &chunks);
    let symbols: Vec<&str> = chunks.iter().filter_map(|c| c.symbol.as_deref()).collect();
    assert!(symbols.contains(&"package"));
    assert!(symbols.contains(&"dependencies"));
}
