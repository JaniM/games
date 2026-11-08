# The Rust backend. Builds from backend/Cargo.lock, so a new crate needs no hash here.
{ lib, rustPlatform }:

rustPlatform.buildRustPackage {
  pname = "games-backend";
  version = "0.1.0";

  # Only what cargo reads, so editing the frontend or the docs doesn't rebuild the backend.
  # `sqlx::migrate!()` embeds backend/migrations at compile time.
  src = lib.fileset.toSource {
    root = ../backend;
    fileset = lib.fileset.unions [
      ../backend/Cargo.toml
      ../backend/Cargo.lock
      ../backend/src
      ../backend/migrations
    ];
  };

  cargoLock.lockFile = ../backend/Cargo.lock;

  # The tests use #[sqlx::test], which needs a Postgres server and DATABASE_URL.
  doCheck = false;

  meta.mainProgram = "games-backend";
}
