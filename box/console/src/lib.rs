//! Console d'administration de l'Aphrody Box : interface Leptos rendue par le serveur puis hydratée en
//! WebAssembly ; fonctions serveur pour l'état des services (moteur Docker, sondes HTTP), les journaux, le
//! redémarrage, les modèles d'Ollama et les accès. Le binaire porte aussi le préparateur (`aphrody-box preparer`).

#![recursion_limit = "512"]

pub mod app;
pub mod types;

#[cfg(feature = "ssr")]
pub mod serveur;

#[cfg(feature = "hydrate")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    console_error_panic_hook::set_once();
    leptos::mount::hydrate_body(app::App);
}
