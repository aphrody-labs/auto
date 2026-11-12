//! Qualification réseau/signature du plugin réel, sans installation et sans fenêtre ni IPC.
#[cfg(desktop)]
fn main() {
    use std::time::Duration;
    use tauri_plugin_updater::UpdaterExt;
    let mut contexte = tauri::generate_context!();
    contexte.package_info_mut().version =
        std::env::args().nth(1).unwrap_or_else(|| "0.1.0".into()).parse().expect("version");
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let resultat = async {
                    let updater = handle.updater_builder().timeout(Duration::from_secs(20)).build()?;
                    println!("Recherche de mise à jour native");
                    if let Some(update) = updater.check().await? {
                        println!("Version disponible : {}", update.version);
                        let octets = update.download(|_, _| {}, || {}).await?;
                        println!("SIGNATURE_NATIVE_OK : {} octets, version signée {}", octets.len(), update.version);
                    } else {
                        println!("Aucune mise à jour");
                    }
                    Ok::<(), tauri_plugin_updater::Error>(())
                }
                .await;
                if let Err(e) = resultat {
                    eprintln!("QUALIFICATION_ECHEC : {e:?}");
                    handle.exit(1);
                } else {
                    handle.exit(0);
                }
            });
            Ok(())
        })
        .run(contexte)
        .expect("qualification");
}
#[cfg(not(desktop))]
fn main() {}
