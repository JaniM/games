# The Rust backend. Builds from backend/Cargo.lock, so a new crate needs no hash here.
{ lib, rustPlatform }:

let
  root = ../..;
in
rustPlatform.buildRustPackage {
  pname = "games-backend";
  version = (lib.importTOML (root + "/backend/Cargo.toml")).package.version;

  # Only what cargo reads, so editing the frontend or the docs doesn't rebuild the backend.
  # `sqlx::migrate!()` embeds backend/migrations at compile time.
  src = lib.fileset.toSource {
    root = root + "/backend";
    fileset = lib.fileset.unions (map (path: root + "/backend/${path}") [
      "Cargo.toml"
      "Cargo.lock"
      "src"
      "migrations"
    ]);
  };

  cargoLock.lockFile = root + "/backend/Cargo.lock";

  # The tests use #[sqlx::test], which needs a Postgres server and DATABASE_URL.
  doCheck = false;

  meta = {
    description = "Games backend";
    mainProgram = "games-backend";
    platforms = lib.platforms.linux;
  };
}
