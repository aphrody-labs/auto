//! Les mises à jour restent dans l'hôte natif : aucune commande IPC ouverte au site distant.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

static EN_COURS: AtomicBool = AtomicBool::new(false);

pub fn verifier(app: tauri::AppHandle, manuel: bool) {
    if EN_COURS.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let resultat = verifier_et_installer(&app, manuel).await;
        if resultat.is_err() {
            eprintln!("Vérification ou installation de la mise à jour impossible");
            if manuel {
                app.dialog().message("La mise à jour n’a pas pu être vérifiée ou installée. Réessayez plus tard depuis le menu Auto.")
                    .title("Mise à jour Auto").kind(MessageDialogKind::Error).show(|_| {});
            }
        }
        EN_COURS.store(false, Ordering::SeqCst);
    });
}

async fn verifier_et_installer(app: &tauri::AppHandle, manuel: bool) -> tauri_plugin_updater::Result<()> {
    let updater = app.updater_builder().timeout(Duration::from_secs(30)).build()?;
    let Some(update) = updater.check().await? else {
        if manuel {
            app.dialog().message("Cette application Auto est à jour.").title("Mise à jour Auto").show(|_| {});
        }
        return Ok(());
    };
    let dialog = app.clone();
    let message = format!(
        "Auto {} est disponible. Enregistrez vos documents avant de continuer. L’application redémarrera après l’installation.",
        update.version
    );
    let accord = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .dialog()
            .message(message)
            .title("Mise à jour Auto")
            .buttons(MessageDialogButtons::OkCancelCustom("Installer et redémarrer".into(), "Plus tard".into()))
            .blocking_show()
    })
    .await
    .unwrap_or(false);
    if !accord {
        return Ok(());
    }
    // Le plugin vérifie la signature et sa version signée avant toute exécution de l'installateur.
    update.download_and_install(|_, _| {}, || {}).await?;
    app.restart();
}
