//! `aphrody-box` : console (sans argument ou `servir`) et préparateur (`preparer <dossier> [options]`).
#![recursion_limit = "512"]

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("preparer") => preparer(&args[1..]),
        None | Some("servir") => servir().await,
        Some("--version") => println!("aphrody-box {}", env!("CARGO_PKG_VERSION")),
        Some("sante") => std::process::exit(if sante().await { 0 } else { 1 }),
        Some(autre) => {
            eprintln!("commande inconnue : {autre}\nusage : aphrody-box [servir] | preparer <dossier> [--gpu|--sans-gpu] [--email a@b.fr] [--domaine exemple.fr] [--hote 192.168.1.20]");
            std::process::exit(2);
        }
    }
}

/// Sonde du conteneur (HEALTHCHECK) : `GET /sante` sur le port local, sans dépendre de curl dans l'image.
async fn sante() -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let port = std::env::var("LEPTOS_SITE_ADDR").ok().and_then(|a| a.rsplit(':').next()?.parse::<u16>().ok()).unwrap_or(8080);
    let essai = async {
        let mut flux = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        flux.write_all(b"GET /sante HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await.ok()?;
        let mut reponse = Vec::new();
        flux.read_to_end(&mut reponse).await.ok()?;
        Some(reponse.starts_with(b"HTTP/1.1 200"))
    };
    tokio::time::timeout(std::time::Duration::from_secs(3), essai).await.ok().flatten().unwrap_or(false)
}

fn preparer(args: &[String]) {
    use aphrody_box::serveur::preparer::{Options, preparer};
    let option = |nom: &str| args.iter().position(|a| a == nom).and_then(|i| args.get(i + 1)).cloned();
    let dossier = args
        .iter()
        .enumerate()
        .find(|(i, a)| !a.starts_with("--") && !(*i > 0 && matches!(args[i - 1].as_str(), "--email" | "--domaine" | "--hote")))
        .map(|(_, a)| a.clone())
        .unwrap_or_else(|| ".".into());
    let o = Options {
        gpu: if args.iter().any(|a| a == "--gpu") {
            Some(true)
        } else if args.iter().any(|a| a == "--sans-gpu") {
            Some(false)
        } else {
            None
        },
        email: option("--email"),
        domaine: option("--domaine"),
        hote: option("--hote"),
        proprietaire: None,
    };
    match preparer(std::path::Path::new(&dossier), &o) {
        Ok(v) => println!(
            "Boîte préparée dans {dossier}.\n  Console : identifiant {}, mot de passe {}\n  Les autres accès sont dans la console, section « Accès ».",
            v["BOX_ADMIN_UTILISATEUR"], v["BOX_ADMIN_MOT_DE_PASSE"]
        ),
        Err(e) => {
            eprintln!("préparation impossible dans {dossier} : {e}");
            std::process::exit(1);
        }
    }
}

async fn servir() {
    use aphrody_box::app::{App, shell};
    use aphrody_box::serveur::{self, Config, Etat, docker::Docker, ollama::Ollama};
    use axum::Router;
    use leptos::prelude::*;
    use leptos_axum::{LeptosRoutes, generate_route_list};

    let config = Config::depuis_env().unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1);
    });
    let projet = config.env.get("BOX_PROJET").cloned().unwrap_or_else(|| "aphrody-box".into());
    let socket = config.env.get("BOX_DOCKER_SOCKET").cloned().unwrap_or_else(|| "/var/run/docker.sock".into());
    let ollama = config.env.get("BOX_OLLAMA_URL").cloned().unwrap_or_else(|| "http://ollama:11434".into());
    serveur::installer(Etat {
        docker: Docker::new(socket, projet),
        ollama: Ollama::new(ollama),
        sondes: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_millis(2500))
            .build()
            .expect("client HTTP"),
        telechargements: Default::default(),
        tentatives: Default::default(),
        config,
    });

    let conf = get_configuration(None).expect("configuration Leptos (Cargo.toml ou variables LEPTOS_*)");
    let options = conf.leptos_options;
    let adresse = options.site_addr;
    let routes = generate_route_list(App);
    let app = Router::new()
        .route("/sante", axum::routing::get(|| async { "ok" }))
        .leptos_routes(&options, routes, {
            let options = options.clone();
            move || shell(options.clone())
        })
        .fallback(leptos_axum::file_and_error_handler(shell))
        .with_state(options);

    let ecoute = tokio::net::TcpListener::bind(&adresse).await.unwrap_or_else(|e| {
        eprintln!("écoute impossible sur {adresse} : {e}");
        std::process::exit(1);
    });
    println!("console de la boîte : http://{adresse}");
    axum::serve(ecoute, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.expect("serveur");
}
