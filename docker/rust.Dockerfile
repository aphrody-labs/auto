FROM rust:1.99
RUN rustup component add clippy rustfmt \
 && rustup target add x86_64-pc-windows-gnu \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends gcc-mingw-w64-x86-64 \
 && rm -rf /var/lib/apt/lists/*
