# Compilation de la coque de bureau Tauri (apps/desktop) sans MSVC : Linux natif (WebKitGTK) et Windows par
# compilation croisée MinGW (cible x86_64-pc-windows-gnu, WebView2).
FROM rust:1.99
RUN rustup target add x86_64-pc-windows-gnu && rustup component add rustfmt clippy \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev pkg-config \
      gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 \
 && rm -rf /var/lib/apt/lists/*
