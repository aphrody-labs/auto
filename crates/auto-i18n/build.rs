//! Embeds `locales/<lang>/common.tsv` and `locales/<lang>/auto.tsv` per `craft-i18n`.

use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(out.components().next_back(), Some(Component::RootDir | Component::Prefix(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn find_locales_dir() -> Option<PathBuf> {
    if let Ok(dir) = env::var("CRAFT_I18N_DIR")
        && !dir.trim().is_empty()
    {
        return Some(normalize_path(Path::new(&dir)));
    }
    let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")?;
    let candidate = normalize_path(&PathBuf::from(manifest_dir).join("../../locales"));
    if candidate.is_dir() { Some(candidate) } else { None }
}

fn main() {
    println!("cargo:rerun-if-env-changed=CRAFT_I18N_DIR");
    println!("cargo:rerun-if-env-changed=CRAFT_I18N_REQUIRED");

    let required = env::var("CRAFT_I18N_REQUIRED").is_ok_and(|v| v == "1");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let generated = out_dir.join("embedded_locales.rs");

    let Some(locales_dir) = find_locales_dir() else {
        if required {
            panic!("CRAFT_I18N_REQUIRED=1 is set, but neither CRAFT_I18N_DIR nor ../../locales exists");
        }
        fs::write(&generated, "pub static CRAFT_I18N: &[(&str, &str, &str)] = &[];\n")
            .expect("write empty embedded_locales.rs");
        return;
    };

    if required && !locales_dir.is_dir() {
        panic!("CRAFT_I18N_REQUIRED=1 is set, but {} is not a directory", locales_dir.display());
    }

    println!("cargo:rerun-if-changed={}", locales_dir.display());

    let mut entries: Vec<(String, Option<PathBuf>, Option<PathBuf>)> = Vec::new();
    if let Ok(read_dir) = fs::read_dir(&locales_dir) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let norm_dir = normalize_path(&path);
            println!("cargo:rerun-if-changed={}", norm_dir.display());
            let common = norm_dir.join("common.tsv");
            let app = norm_dir.join("auto.tsv");
            let common_opt = common.is_file().then(|| {
                println!("cargo:rerun-if-changed={}", common.display());
                common
            });
            let app_opt = app.is_file().then(|| {
                println!("cargo:rerun-if-changed={}", app.display());
                app
            });
            if common_opt.is_some() || app_opt.is_some() {
                entries.push((name, common_opt, app_opt));
            }
        }
    }

    entries.sort_by(|a, b| a.0.cmp(&b.0));

    if required && !entries.iter().any(|(_, _, app)| app.is_some()) {
        panic!(
            "CRAFT_I18N_REQUIRED=1 is set, but no <locale>/auto.tsv catalog was found under {}",
            locales_dir.display()
        );
    }

    let mut code = String::from("pub static CRAFT_I18N: &[(&str, &str, &str)] = &[\n");
    for (lang, common, app) in entries {
        let common_expr = match common {
            Some(p) => format!("include_str!({:?})", p.to_string_lossy().as_ref()),
            None => "\"\"".to_owned(),
        };
        let app_expr = match app {
            Some(p) => format!("include_str!({:?})", p.to_string_lossy().as_ref()),
            None => "\"\"".to_owned(),
        };
        code.push_str(&format!("    ({lang:?}, {common_expr}, {app_expr}),\n"));
    }
    code.push_str("];\n");

    fs::write(&generated, code).expect("write embedded_locales.rs");
}
