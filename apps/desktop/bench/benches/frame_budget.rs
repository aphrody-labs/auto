//! Production-shaped Criterion benchmarks verifying 120 FPS (< 8.33 ms) budget without `test-support`.

use std::time::Duration;

use auto_desktop::{AutoDesktopStore, DesktopPalette};
use auto_theme::Appearance;
use criterion::{Criterion, black_box, criterion_group, criterion_main};

fn bench_frame_budget(c: &mut Criterion) {
    let mut group = c.benchmark_group("auto_desktop_120fps");
    group.warm_up_time(Duration::from_millis(500));
    group.measurement_time(Duration::from_secs(2));
    group.sample_size(40);

    let mut store = AutoDesktopStore::with_document_count(10_000);

    group.bench_function("filter_10k_invoices_and_facturx_preview", |b| {
        b.iter(|| {
            store.set_filter(black_box("Nordic"));
            store.select_filtered(black_box(0));
            let slice_len = store.filtered_indices.len();
            store.set_filter(black_box(""));
            black_box((slice_len, store.facturx_preview.len()))
        });
    });

    group.bench_function("resolve_palette_light_dark_switch", |b| {
        b.iter(|| {
            let l = DesktopPalette::from_appearance(black_box(Appearance::Light), false);
            let d = DesktopPalette::from_appearance(black_box(Appearance::Dark), false);
            black_box((l.primary, d.primary))
        });
    });

    group.finish();
}

criterion_group!(benches, bench_frame_budget);
criterion_main!(benches);
