//! Interface de la console : connexion, puis tableau de bord (état des services, modèles, accès, coulisses).
//! Les données sont chargées côté navigateur par les fonctions serveur et rafraîchies à intervalle fixe ; les listes
//! sont clés par état pour que le focus clavier ne saute pas à chaque rafraîchissement.
use crate::types::*;
use leptos::prelude::*;
use leptos::task::spawn_local;
#[cfg(feature = "ssr")]
use leptos_meta::MetaTags;
use leptos_meta::{Meta, Stylesheet, Title, provide_meta_context};
use std::time::Duration;

#[cfg(feature = "ssr")]
pub fn shell(options: LeptosOptions) -> impl IntoView {
    view! {
        <!DOCTYPE html>
        <html lang="fr">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <meta name="color-scheme" content="light dark" />
                <HydrationScripts options />
                <MetaTags />
            </head>
            <body>
                <App />
            </body>
        </html>
    }
}

// Fonctions serveur

#[cfg(feature = "ssr")]
async fn exiger_session() -> Result<(), ServerFnError> {
    use axum::http::{HeaderMap, header};
    use crate::serveur::{etat, session};
    let h: HeaderMap = leptos_axum::extract().await?;
    let texte = |n: header::HeaderName| h.get(n).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let connecte = texte(header::COOKIE)
        .as_deref()
        .and_then(session::lire_cookie)
        .is_some_and(|c| session::valide(&etat().config.secret, c));
    if !connecte {
        return Err(ServerFnError::new("connexion requise"));
    }
    // Requête venue d'une autre page : refusée, même avec le cookie (qui est déjà SameSite=Strict).
    if let (Some(origine), Some(hote)) = (texte(header::ORIGIN), texte(header::HOST))
        && origine.split_once("://").map(|(_, h)| h) != Some(hote.as_str())
    {
        return Err(ServerFnError::new("origine refusée"));
    }
    Ok(())
}

#[server]
pub async fn est_connecte() -> Result<bool, ServerFnError> {
    Ok(exiger_session().await.is_ok())
}

#[server]
pub async fn connecter(utilisateur: String, mot_de_passe: String) -> Result<(), ServerFnError> {
    use crate::serveur::{etat, session};
    use axum::extract::ConnectInfo;
    use axum::http::{HeaderValue, header};
    let e = etat();
    let ConnectInfo(adresse): ConnectInfo<std::net::SocketAddr> = leptos_axum::extract().await?;
    let ip = adresse.ip();
    if e.tentatives.bloquee(ip) {
        return Err(ServerFnError::new("Trop de tentatives : réessayez dans un quart d'heure."));
    }
    let bon = session::egal(&utilisateur, &e.config.utilisateur) & session::egal(&mot_de_passe, &e.config.mot_de_passe);
    if !bon {
        e.tentatives.echec(ip);
        return Err(ServerFnError::new("Identifiant ou mot de passe incorrect."));
    }
    e.tentatives.reussite(ip);
    let cookie = format!(
        "{}={}; Path=/; Max-Age={}; HttpOnly; SameSite=Strict{}",
        session::COOKIE,
        session::emettre(&e.config.secret),
        session::DUREE,
        if e.config.domaine.is_some() { "; Secure" } else { "" }
    );
    let reponse = expect_context::<leptos_axum::ResponseOptions>();
    reponse.insert_header(header::SET_COOKIE, HeaderValue::from_str(&cookie).map_err(ServerFnError::new)?);
    Ok(())
}

#[server]
pub async fn deconnecter() -> Result<(), ServerFnError> {
    use axum::http::{HeaderValue, header};
    let reponse = expect_context::<leptos_axum::ResponseOptions>();
    reponse.insert_header(
        header::SET_COOKIE,
        HeaderValue::from_static("box_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"),
    );
    Ok(())
}

#[server]
pub async fn lire_etat() -> Result<EtatBoite, ServerFnError> {
    use crate::serveur::{disque, etat, services};
    use axum::http::{HeaderMap, header};
    exiger_session().await?;
    let h: HeaderMap = leptos_axum::extract().await?;
    let hote = services::nom_hote(h.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("localhost"));
    let e = etat();
    let (conteneurs, info) = tokio::join!(e.docker.conteneurs(), e.docker.info());
    let conteneurs = conteneurs.map_err(ServerFnError::new)?;
    let vus = futures_util::future::join_all(services::SERVICES.iter().map(|s| {
        let c = conteneurs.iter().find(|c| c.service == s.conteneur).cloned();
        let hote = hote.clone();
        async move {
            let en_cours = c.as_ref().is_some_and(|c| c.etat == "running");
            let repond = match (en_cours, s.sonde) {
                (true, Some(url)) => Some(e.sondes.get(url).send().await.is_ok_and(|r| r.status().as_u16() < 500)),
                _ => None,
            };
            let etat = match &c {
                None => EtatService::Absent,
                Some(c) if c.etat != "running" => EtatService::Arret,
                Some(c) if c.sante == Some("unhealthy") => EtatService::Panne,
                Some(c) if c.sante == Some("starting") || repond == Some(false) => EtatService::Demarrage,
                Some(_) => EtatService::Marche,
            };
            ServiceVu {
                id: s.id.into(),
                nom: s.nom.into(),
                role: s.role.into(),
                couleur: s.couleur.into(),
                technique: s.technique,
                lien: services::lien(s, e.config.domaine.as_deref(), &hote),
                etat,
                statut: c.map(|c| c.statut),
            }
        }
    }))
    .await;
    let (cpus, memoire) = info.map(|(c, m)| (Some(c), Some(m))).unwrap_or((None, None));
    let (disque_total, disque_libre) = disque("/").map(|(t, l)| (Some(t), Some(l))).unwrap_or((None, None));
    Ok(EtatBoite {
        services: vus.into_iter().filter(|s| !(s.technique && s.etat == EtatService::Absent)).collect(),
        systeme: Systeme { cpus, memoire, disque_total, disque_libre },
    })
}

#[server]
pub async fn acces_boite() -> Result<Vec<Acces>, ServerFnError> {
    exiger_session().await?;
    let c = &crate::serveur::etat().config;
    let ligne = |service: &str, identifiant: String, mot_de_passe: String| Acces {
        service: service.into(),
        identifiant,
        mot_de_passe,
    };
    Ok(vec![
        ligne("Console", c.utilisateur.clone(), c.mot_de_passe.clone()),
        ligne("n8n", c.val("BOX_EMAIL"), c.val("N8N_MOT_DE_PASSE")),
        ligne("Hermes", "admin".into(), c.val("HERMES_MOT_DE_PASSE")),
        ligne("Hermes, API compatible OpenAI (port 8642)", "clé".into(), c.val("HERMES_CLE_API")),
        ligne("Obsidian", c.utilisateur.clone(), c.val("OBSIDIAN_MOT_DE_PASSE")),
        ligne("Auto", "compte à créer à la première visite".into(), String::new()),
    ])
}

#[cfg(feature = "ssr")]
async fn conteneur_de(id: &str) -> Result<crate::serveur::docker::Conteneur, ServerFnError> {
    use crate::serveur::{etat, services};
    let s = services::service(id).ok_or_else(|| ServerFnError::new(format!("service inconnu : {id}")))?;
    etat()
        .docker
        .conteneurs()
        .await
        .map_err(ServerFnError::new)?
        .into_iter()
        .find(|c| c.service == s.conteneur)
        .ok_or_else(|| ServerFnError::new(format!("{} n'est pas installé dans cette boîte", s.nom)))
}

#[server]
pub async fn lire_journal(id: String) -> Result<String, ServerFnError> {
    exiger_session().await?;
    let c = conteneur_de(&id).await?;
    crate::serveur::etat().docker.journal(&c.id, 400).await.map_err(ServerFnError::new)
}

#[server]
pub async fn redemarrer(id: String) -> Result<(), ServerFnError> {
    exiger_session().await?;
    let c = conteneur_de(&id).await?;
    crate::serveur::etat().docker.redemarrer(&c.id).await.map_err(ServerFnError::new)
}

#[server]
pub async fn lire_modeles() -> Result<Modeles, ServerFnError> {
    use crate::serveur::{etat, ollama};
    exiger_session().await?;
    let e = etat();
    let (installes, erreur) = match e.ollama.modeles().await {
        Ok(m) => (m, None),
        Err(x) => (Vec::new(), Some(x)),
    };
    let en_cours = {
        let mut t = e.telechargements.lock().unwrap();
        let v: Vec<Progression> = t.values().cloned().collect();
        // Un téléchargement terminé est montré une fois, puis oublié.
        t.retain(|_, p| !p.termine);
        v
    };
    Ok(Modeles { installes, suggestions: ollama::suggestions(), en_cours, erreur })
}

#[server]
pub async fn installer_modele(nom: String) -> Result<(), ServerFnError> {
    use crate::serveur::{etat, ollama};
    exiger_session().await?;
    let nom = nom.trim().to_string();
    if !ollama::nom_valide(&nom) {
        return Err(ServerFnError::new("Nom de modèle invalide (exemple : qwen3:4b)."));
    }
    let e = etat();
    if e.telechargements.lock().unwrap().get(&nom).is_some_and(|p| !p.termine) {
        return Err(ServerFnError::new(format!("{nom} est déjà en cours de téléchargement.")));
    }
    e.ollama.telecharger(nom, e.telechargements.clone());
    Ok(())
}

#[server]
pub async fn supprimer_modele(nom: String) -> Result<(), ServerFnError> {
    use crate::serveur::{etat, ollama};
    exiger_session().await?;
    if !ollama::nom_valide(&nom) {
        return Err(ServerFnError::new("Nom de modèle invalide."));
    }
    etat().ollama.supprimer(&nom).await.map_err(ServerFnError::new)
}

// Interface

fn message(e: &ServerFnError) -> String {
    match e {
        ServerFnError::ServerError(m) => m.clone(),
        autre => autre.to_string(),
    }
}

fn resume(services: &[ServiceVu]) -> String {
    let soucis: Vec<&ServiceVu> =
        services.iter().filter(|s| matches!(s.etat, EtatService::Panne | EtatService::Arret)).collect();
    let demarrent: Vec<&ServiceVu> = services.iter().filter(|s| s.etat == EtatService::Demarrage).collect();
    match (soucis.as_slice(), demarrent.as_slice()) {
        ([s], _) => format!("{} est {}.", s.nom, if s.etat == EtatService::Panne { "en panne" } else { "arrêté" }),
        ([_, ..], _) => format!("{} services ont besoin de vous.", soucis.len()),
        ([], [s]) => format!("{} démarre…", s.nom),
        ([], [_, ..]) => format!("{} services démarrent…", demarrent.len()),
        ([], []) if services.iter().any(|s| s.etat == EtatService::Marche) => "Tout fonctionne.".into(),
        _ => "Aucun service lancé.".into(),
    }
}

/// Appelle `f` tout de suite puis toutes les `periode`, côté navigateur seulement ; arrêt au démontage.
fn periodique(periode: Duration, f: impl Fn() + Clone + 'static) {
    Effect::new(move |_| {
        f();
        if let Ok(h) = set_interval_with_handle(f.clone(), periode) {
            on_cleanup(move || h.clear());
        }
    });
}

#[component]
pub fn App() -> impl IntoView {
    provide_meta_context();
    let session = Resource::new(|| (), |_| est_connecte());
    view! {
        <Stylesheet id="leptos" href="/pkg/aphrody-box.css" />
        <Title text="Aphrody Box" />
        <Meta name="robots" content="noindex" />
        <Suspense fallback=|| view! { <p class="attente">"Chargement…"</p> }>
            {move || Suspend::new(async move {
                if matches!(session.await, Ok(true)) {
                    view! { <Console session /> }.into_any()
                } else {
                    view! { <Connexion session /> }.into_any()
                }
            })}
        </Suspense>
    }
}

#[component]
fn Connexion(session: Resource<Result<bool, ServerFnError>>) -> impl IntoView {
    let action = ServerAction::<Connecter>::new();
    Effect::new(move |_| {
        if let Some(Ok(())) = action.value().get() {
            session.refetch();
        }
    });
    let erreur = move || action.value().get().and_then(|r| r.err()).map(|e| message(&e));
    view! {
        <main class="connexion">
            <div class="carte-connexion">
                <p class="marque">"Aphrody Box"</p>
                <h1>"Administration"</h1>
                <ActionForm action>
                    <label>
                        "Identifiant"
                        <input name="utilisateur" autocomplete="username" value="admin" required />
                    </label>
                    <label>
                        "Mot de passe"
                        <input name="mot_de_passe" type="password" autocomplete="current-password" required />
                    </label>
                    <p class="erreur" role="alert">
                        {erreur}
                    </p>
                    <button class="bouton principal" type="submit" disabled=move || action.pending().get()>
                        "Se connecter"
                    </button>
                </ActionForm>
                <p class="aide">
                    "Le mot de passe a été affiché à l'installation. Il se trouve aussi dans le fichier "
                    <code>".env"</code>
                    " de la boîte, à la ligne "
                    <code>"BOX_ADMIN_MOT_DE_PASSE"</code>
                    "."
                </p>
            </div>
        </main>
    }
}

#[component]
fn Console(session: Resource<Result<bool, ServerFnError>>) -> impl IntoView {
    let donnees = RwSignal::new(None::<EtatBoite>);
    let erreur = RwSignal::new(None::<String>);
    let journal_de = RwSignal::new(None::<(String, String)>);
    let charger = move || {
        spawn_local(async move {
            match lire_etat().await {
                Ok(e) => {
                    donnees.set(Some(e));
                    erreur.set(None);
                }
                Err(x) if message(&x) == "connexion requise" => session.refetch(),
                Err(x) => erreur.set(Some(message(&x))),
            }
        })
    };
    periodique(Duration::from_secs(4), charger);

    let relance = ServerAction::<Redemarrer>::new();
    Effect::new(move |_| {
        if relance.version().get() > 0 {
            charger();
        }
    });
    let sortie = ServerAction::<Deconnecter>::new();
    Effect::new(move |_| {
        if let Some(Ok(())) = sortie.value().get() {
            session.refetch();
        }
    });

    let services = move || donnees.with(|d| d.as_ref().map(|e| e.services.clone()).unwrap_or_default());
    let apps = move || services().into_iter().filter(|s| !s.technique).collect::<Vec<_>>();
    let coulisses = move || services().into_iter().filter(|s| s.technique).collect::<Vec<_>>();
    let titre = move || donnees.with(|d| d.as_ref().map(|e| resume(&e.services)).unwrap_or_else(|| "Lecture de l'état…".into()));
    let systeme = move || donnees.with(|d| d.as_ref().map(|e| e.systeme.clone()));

    view! {
        <div class="console">
            <header class="barre">
                <span class="marque">"Aphrody Box"</span>
                <nav aria-label="Sections">
                    <a href="#applications">"Applications"</a>
                    <a href="#modeles">"Modèles d'IA"</a>
                    <a href="#acces">"Accès"</a>
                    <a href="#coulisses">"Coulisses"</a>
                </nav>
                <button class="bouton discret" type="button" on:click=move |_| { sortie.dispatch(Deconnecter {}); }>
                    "Se déconnecter"
                </button>
            </header>

            <section class="tete" aria-live="polite">
                <h1>{titre}</h1>
                <p class="doux">
                    {move || {
                        let s = services();
                        let n = s.iter().filter(|s| !s.technique).count();
                        if s.is_empty() { String::new() } else { format!("{n} applications et {} services en coulisses.", s.len() - n) }
                    }}
                </p>
                {move || erreur.get().map(|e| view! { <p class="erreur" role="alert">{e}</p> })}
                <Jauges systeme=Signal::derive(systeme) />
            </section>

            <section id="applications" aria-labelledby="t-apps">
                <h2 id="t-apps">"Applications"</h2>
                <ul class="apps">
                    <For each=apps key=|s| (s.id.clone(), s.etat, s.lien.clone()) let:s>
                        <CarteApp s journal_de relance />
                    </For>
                </ul>
            </section>

            <SectionModeles />
            <SectionAcces />

            <section id="coulisses" aria-labelledby="t-coulisses">
                <h2 id="t-coulisses">"Coulisses"</h2>
                <p class="doux">"Les services qui font tourner les applications. Ils n'ont pas d'écran à ouvrir."</p>
                <ul class="coulisses">
                    <For each=coulisses key=|s| (s.id.clone(), s.etat, s.statut.clone()) let:s>
                        <li data-etat=s.etat.classe()>
                            <Pastille etat=s.etat />
                            <strong>{s.nom.clone()}</strong>
                            <span class="doux">{s.statut.clone().unwrap_or_default()}</span>
                            <button
                                class="bouton discret"
                                type="button"
                                on:click={
                                    let (id, nom) = (s.id.clone(), s.nom.clone());
                                    move |_| journal_de.set(Some((id.clone(), nom.clone())))
                                }
                            >
                                "Journal"
                            </button>
                        </li>
                    </For>
                </ul>
            </section>

            <Journal journal_de />
        </div>
    }
}

#[component]
fn Pastille(etat: EtatService) -> impl IntoView {
    view! {
        <span class="pastille" data-etat=etat.classe()>
            <span class="point" aria-hidden="true"></span>
            {etat.libelle()}
        </span>
    }
}

#[component]
fn Jauges(systeme: Signal<Option<Systeme>>) -> impl IntoView {
    let valeur = move |f: fn(&Systeme) -> Option<String>| move || systeme.get().as_ref().and_then(f).unwrap_or_else(|| "–".into());
    let rempli = move || {
        systeme.get().and_then(|s| Some(1.0 - s.disque_libre? as f64 / s.disque_total.filter(|t| *t > 0)? as f64)).unwrap_or(0.0)
    };
    view! {
        <dl class="jauges">
            <div>
                <dt>"Processeurs"</dt>
                <dd>{valeur(|s| s.cpus.map(|c| c.to_string()))}</dd>
            </div>
            <div>
                <dt>"Mémoire"</dt>
                <dd>{valeur(|s| s.memoire.map(octets))}</dd>
            </div>
            <div class="disque">
                <dt>"Disque"</dt>
                <dd>
                    {valeur(|s| Some(format!("{} libres sur {}", octets(s.disque_libre?), octets(s.disque_total?))))}
                    <span class="barre-disque" aria-hidden="true">
                        <span
                            data-alerte=move || (rempli() > 0.9).to_string()
                            style=move || format!("inline-size:{:.0}%", rempli() * 100.0)
                        ></span>
                    </span>
                </dd>
            </div>
        </dl>
    }
}

#[component]
fn CarteApp(s: ServiceVu, journal_de: RwSignal<Option<(String, String)>>, relance: ServerAction<Redemarrer>) -> impl IntoView {
    let (id, nom) = (s.id.clone(), s.nom.clone());
    let en_cours = {
        let id = id.clone();
        move || relance.pending().get() && relance.input().with(|i| i.as_ref().is_some_and(|r| r.id == id))
    };
    let installe = s.etat != EtatService::Absent;
    view! {
        <li class="app" data-etat=s.etat.classe() style=format!("--couleur:{}", s.couleur)>
            <div class="entete">
                <h3>{s.nom.clone()}</h3>
                <Pastille etat=s.etat />
            </div>
            <p>{s.role.clone()}</p>
            <div class="actions">
                {s.lien.clone().filter(|_| installe).map(|l| view! {
                    <a class="bouton principal" href=l target="_blank" rel="noopener">"Ouvrir"<span class="sr">{format!(" {}", s.nom)}</span></a>
                })}
                {installe.then(|| {
                    let (id_j, nom_j, id_r) = (id.clone(), nom.clone(), id.clone());
                    let (desactive, libelle) = (en_cours.clone(), en_cours.clone());
                    view! {
                        <button class="bouton discret" type="button" on:click=move |_| journal_de.set(Some((id_j.clone(), nom_j.clone())))>
                            "Journal"
                        </button>
                        <button
                            class="bouton discret"
                            type="button"
                            disabled=desactive
                            on:click=move |_| { relance.dispatch(Redemarrer { id: id_r.clone() }); }
                        >
                            {move || if libelle() { "Redémarrage…" } else { "Redémarrer" }}
                        </button>
                    }
                })}
            </div>
        </li>
    }
}

#[component]
fn Journal(journal_de: RwSignal<Option<(String, String)>>) -> impl IntoView {
    let texte = RwSignal::new(String::new());
    let fermer_ref = NodeRef::<leptos::html::Button>::new();
    let pre_ref = NodeRef::<leptos::html::Pre>::new();
    Effect::new(move |_| {
        if let Some((id, _)) = journal_de.get() {
            texte.set("Chargement…".into());
            spawn_local(async move {
                texte.set(match lire_journal(id).await {
                    Ok(t) if t.is_empty() => "(journal vide)".into(),
                    Ok(t) => t,
                    Err(e) => message(&e),
                })
            });
        }
    });
    // Focus sur « Fermer » à l'ouverture, dernières lignes visibles à chaque chargement.
    Effect::new(move |_| {
        if let Some(b) = fermer_ref.get() {
            let _ = b.focus();
        }
    });
    Effect::new(move |_| {
        texte.track();
        if let Some(pre) = pre_ref.get() {
            // Après la mise en page du nouveau texte.
            request_animation_frame(move || pre.set_scroll_top(pre.scroll_height()));
        }
    });
    let fermer = move || journal_de.set(None);
    // Échap ferme, où que soit le focus.
    Effect::new(move |_| {
        let h = window_event_listener(leptos::ev::keydown, move |e| {
            if e.key() == "Escape" && journal_de.with_untracked(Option::is_some) {
                fermer();
            }
        });
        on_cleanup(move || h.remove());
    });
    view! {
        <Show when=move || journal_de.with(Option::is_some)>
            <div class="voile" on:click=move |_| fermer()>
                <div
                    class="journal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="t-journal"
                    on:click=|e| e.stop_propagation()
                >
                    <header>
                        <h2 id="t-journal">
                            {move || journal_de.get().map(|(_, n)| format!("Journal de {n}")).unwrap_or_default()}
                        </h2>
                        <button class="bouton discret" type="button" node_ref=fermer_ref on:click=move |_| fermer()>
                            "Fermer"
                        </button>
                    </header>
                    <pre tabindex="0" node_ref=pre_ref>{move || texte.get()}</pre>
                </div>
            </div>
        </Show>
    }
}

#[component]
fn SectionModeles() -> impl IntoView {
    let liste = RwSignal::new(None::<Modeles>);
    let charger = move || {
        spawn_local(async move {
            if let Ok(m) = lire_modeles().await {
                liste.set(Some(m));
            }
        })
    };
    periodique(Duration::from_secs(3), charger);
    let installer = ServerAction::<InstallerModele>::new();
    let supprimer = ServerAction::<SupprimerModele>::new();
    Effect::new(move |_| {
        if installer.version().get() + supprimer.version().get() > 0 {
            charger();
        }
    });
    let erreur_action = move || {
        installer
            .value()
            .get()
            .and_then(|r| r.err())
            .or_else(|| supprimer.value().get().and_then(|r| r.err()))
            .map(|e| message(&e))
    };
    let installes = move || liste.with(|l| l.as_ref().map(|m| m.installes.clone()).unwrap_or_default());
    let en_cours = move || liste.with(|l| l.as_ref().map(|m| m.en_cours.clone()).unwrap_or_default());
    let suggestions = move || {
        liste.with(|l| {
            l.as_ref()
                .map(|m| {
                    m.suggestions
                        .iter()
                        .filter(|s| !m.installes.iter().any(|i| i.nom == s.nom || i.nom == format!("{}:latest", s.nom)))
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
    };
    view! {
        <section id="modeles" aria-labelledby="t-modeles">
            <h2 id="t-modeles">"Modèles d'IA"</h2>
            <p class="doux">
                "Servis par Ollama sur cette machine, pour Hermes, n8n et les nœuds IA d'Auto (adresse interne "
                <code>"http://ollama:11434/v1"</code>
                ")."
            </p>
            {move || liste.with(|l| l.as_ref().and_then(|m| m.erreur.clone())).map(|e| view! { <p class="erreur" role="alert">{e}</p> })}
            <table class="table">
                <thead>
                    <tr>
                        <th scope="col">"Modèle"</th>
                        <th scope="col" class="nombre">"Taille"</th>
                        <th scope="col">"Détails"</th>
                        <th scope="col"><span class="sr">"Actions"</span></th>
                    </tr>
                </thead>
                <tbody>
                    <Show when=move || !installes().is_empty() fallback=|| view! {
                        <tr><td colspan="4" class="doux">"Aucun modèle pour l'instant : installez-en un ci-dessous."</td></tr>
                    }>
                        <For each=installes key=|m| (m.nom.clone(), m.charge) let:m>
                            <tr>
                                <th scope="row">
                                    {m.nom.clone()}
                                    {m.charge.then(|| view! { <span class="charge">"en mémoire"</span> })}
                                </th>
                                <td class="nombre">{octets(m.taille)}</td>
                                <td class="doux">{m.details.clone()}</td>
                                <td>
                                    <button
                                        class="bouton discret"
                                        type="button"
                                        on:click={
                                            let nom = m.nom.clone();
                                            move |_| { supprimer.dispatch(SupprimerModele { nom: nom.clone() }); }
                                        }
                                    >
                                        "Supprimer"<span class="sr">{format!(" {}", m.nom)}</span>
                                    </button>
                                </td>
                            </tr>
                        </For>
                    </Show>
                </tbody>
            </table>

            <div class="installer">
                <ActionForm action=installer>
                    <label for="nom-modele">"Installer un modèle"</label>
                    <div class="ligne">
                        <input id="nom-modele" name="nom" placeholder="qwen3:4b" autocomplete="off" required />
                        <button class="bouton principal" type="submit">"Installer"</button>
                    </div>
                </ActionForm>
                <div class="suggestions">
                    <For each=suggestions key=|s| s.nom.clone() let:s>
                        <button
                            class="suggestion"
                            type="button"
                            on:click={
                                let nom = s.nom.clone();
                                move |_| { installer.dispatch(InstallerModele { nom: nom.clone() }); }
                            }
                        >
                            <strong>{s.nom.clone()}</strong>
                            <span>{s.usage.clone()}</span>
                        </button>
                    </For>
                </div>
                {move || erreur_action().map(|e| view! { <p class="erreur" role="alert">{e}</p> })}
                <ul class="progressions" aria-live="polite">
                    <For each=en_cours key=|p| (p.nom.clone(), p.statut.clone(), p.fait, p.termine) let:p>
                        <li>
                            <span>
                                {match (&p.erreur, p.total) {
                                    (Some(e), _) => format!("{} : échec, {e}", p.nom),
                                    (None, t) if t > 0 && !p.termine => format!("{} : {} sur {}", p.nom, octets(p.fait), octets(t)),
                                    _ => format!("{} : {}", p.nom, p.statut),
                                }}
                            </span>
                            <progress max="1" value=format!("{:.3}", if p.termine { 1.0 } else if p.total > 0 { p.fait as f64 / p.total as f64 } else { 0.0 })></progress>
                        </li>
                    </For>
                </ul>
            </div>
        </section>
    }
}

#[component]
fn SectionAcces() -> impl IntoView {
    let liste = RwSignal::new(Vec::<Acces>::new());
    Effect::new(move |_| {
        spawn_local(async move {
            if let Ok(a) = acces_boite().await {
                liste.set(a);
            }
        })
    });
    view! {
        <section id="acces" aria-labelledby="t-acces">
            <h2 id="t-acces">"Accès"</h2>
            <p class="doux">"Identifiants préparés à l'installation. Vous pouvez les changer depuis chaque application."</p>
            <table class="table">
                <thead>
                    <tr>
                        <th scope="col">"Application"</th>
                        <th scope="col">"Identifiant"</th>
                        <th scope="col">"Mot de passe"</th>
                    </tr>
                </thead>
                <tbody>
                    <For each=move || liste.get() key=|a| a.service.clone() let:a>
                        <LigneAcces a />
                    </For>
                </tbody>
            </table>
        </section>
    }
}

#[component]
fn LigneAcces(a: Acces) -> impl IntoView {
    let visible = RwSignal::new(false);
    let mdp = a.mot_de_passe.clone();
    view! {
        <tr>
            <th scope="row">{a.service.clone()}</th>
            <td>{a.identifiant.clone()}</td>
            <td>
                {if mdp.is_empty() {
                    view! { <span class="doux">"–"</span> }.into_any()
                } else {
                    view! {
                        <code class="secret">{move || if visible.get() { mdp.clone() } else { "••••••••••".into() }}</code>
                        <button class="bouton discret" type="button" aria-pressed=move || visible.get().to_string() on:click=move |_| visible.update(|v| *v = !*v)>
                            {move || if visible.get() { "Masquer" } else { "Afficher" }}
                        </button>
                    }
                    .into_any()
                }}
            </td>
        </tr>
    }
}
