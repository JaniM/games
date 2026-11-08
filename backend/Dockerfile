# Keep the Rust version in step with the nix devshell.
FROM rust:1.95-slim-bookworm AS build
WORKDIR /app

# Build the dependencies against a stub first so this layer is cached
# until Cargo.toml or Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release --locked \
    && rm -r src

COPY src ./src
# `sqlx::migrate!()` embeds these at compile time.
COPY migrations ./migrations
# The stub build is newer than the copied sources, so force a rebuild of the crate.
RUN touch src/main.rs && cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd --system --no-create-home app
USER app
COPY --from=build /app/target/release/games-backend /usr/local/bin/games-backend
EXPOSE 3000
CMD ["games-backend"]
