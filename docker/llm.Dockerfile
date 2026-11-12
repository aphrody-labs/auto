# Serveur d'extraction compatible OpenAI pour auto (AUTO_LLM_URL) : llama.cpp compilé sur Alpine.
# Pas d'image officielle llama.cpp ici (base Ubuntu, exclue par la politique conteneurs).
#
#   docker build -f docker/llm.Dockerfile -t auto-llm:<tag> docker
#   docker run -v /srv/auto/llm:/models:ro auto-llm:<tag>   (modèle : /models/model.gguf)

FROM alpine:3.23 AS build
ARG LLAMA_TAG=v0.9.0
# hadolint ignore=DL3018
RUN apk add --no-cache build-base cmake git linux-headers openssl-dev
WORKDIR /src
RUN git clone --depth 1 --branch "${LLAMA_TAG}" https://github.com/ggml-org/llama.cpp.git . \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
       -DGGML_BACKEND_DL=OFF -DGGML_CPU_ALL_VARIANTS=OFF -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
       -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
    && cmake --build build --target llama-server -j"$(nproc)" \
    && install -D build/bin/llama-server /out/llama-server \
    && install -D LICENSE /out/LICENSE

FROM alpine:3.23
# hadolint ignore=DL3018
RUN apk add --no-cache libstdc++ libgomp openssl ca-certificates curl \
    && adduser -S -D -H -u 10001 llm
COPY --from=build /out/ /opt/llama/
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s CMD ["curl", "-fsS", "http://127.0.0.1:8080/health"]
ENTRYPOINT ["/opt/llama/llama-server", "--host", "0.0.0.0", "--port", "8080", "--model", "/models/model.gguf"]
CMD ["--alias", "auto-extraction", "--ctx-size", "8192", "--parallel", "1", "--threads", "3", "--jinja"]
