# Image de la console de l'Aphrody Box : serveur Leptos (axum) et paquet WebAssembly construits par cargo-leptos.
# Contexte : box/console.

FROM rust:1.99 AS construction
RUN rustup target add wasm32-unknown-unknown \
 && curl -fsSL https://github.com/cargo-bins/cargo-binstall/releases/latest/download/cargo-binstall-x86_64-unknown-linux-musl.tgz | tar -xz -C /usr/local/cargo/bin \
 && cargo binstall -y --locked cargo-leptos
WORKDIR /w
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/w/target,id=aphrody-box-target \
    cargo test --features ssr --lib \
 && cargo leptos build --release \
 && mkdir -p /sortie \
 && cp target/release/aphrody-box /sortie/ \
 && cp -r target/site /sortie/site

FROM debian:trixie-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=construction /sortie/aphrody-box /usr/local/bin/aphrody-box
COPY --from=construction /sortie/site /srv/site
ENV LEPTOS_SITE_ROOT=/srv/site LEPTOS_SITE_PKG_DIR=pkg LEPTOS_OUTPUT_NAME=aphrody-box LEPTOS_SITE_ADDR=0.0.0.0:8080 LEPTOS_ENV=PROD
WORKDIR /srv
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s CMD ["aphrody-box", "sante"]
ENTRYPOINT ["aphrody-box"]
