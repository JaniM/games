# The Rust backend, built with crane. The dependencies are one derivation and the crate another, so
# a change under backend/src rebuilds only the crate. The dependencies are rebuilt when Cargo.toml
# or Cargo.lock change.
#
# Builds from backend/Cargo.lock, so a new crate needs no hash here.
{ lib, craneLib }:

let
  root = ../..;

  # Only what cargo reads, so editing the frontend or the docs doesn't rebuild the backend.
  # `sqlx::migrate!()` embeds backend/migrations at compile time, so crane's cleanCargoSource,
  # which keeps only Rust and cargo files, would break the build.
  src = lib.fileset.toSource {
    root = root + "/backend";
    fileset = lib.fileset.unions (map (path: root + "/backend/${path}") [
      "Cargo.toml"
      "Cargo.lock"
      "src"
      "migrations"
    ]);
  };

  commonArgs = {
    inherit src;
    strictDeps = true;

    # The tests use #[sqlx::test], which needs a Postgres server and DATABASE_URL. For the
    # dependencies this also skips building the dev-dependencies, which crane does by default.
    doCheck = false;
  };

  # Crane replaces the sources with stubs here, so only Cargo.toml and Cargo.lock reach this
  # derivation's inputs.
  cargoArtifacts = craneLib.buildDepsOnly commonArgs;
in
craneLib.buildPackage (commonArgs // {
  inherit cargoArtifacts;

  # pname and version come from backend/Cargo.toml.
  meta = {
    description = "Games backend";
    mainProgram = "games-backend";
    platforms = lib.platforms.linux;
  };
})
