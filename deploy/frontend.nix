# The built frontend: a directory of static files (index.html and assets/) for Caddy to serve.
{
  lib,
  stdenv,
  nodejs_24,
  pnpm_11,
  fetchPnpmDeps,
  pnpmConfigHook,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "games-frontend";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../frontend;
    fileset = lib.fileset.unions [
      ../frontend/index.html
      ../frontend/package.json
      ../frontend/pnpm-lock.yaml
      ../frontend/tsconfig.json
      ../frontend/vite.config.ts
      ../frontend/src
    ];
  };

  # The npm packages, fetched once with network access and checked against `hash`.
  # Change pnpm-lock.yaml and the hash goes stale: set it to lib.fakeHash, build, and copy the
  # `got:` hash from the error. Keep pnpm_11 in step with packageManager in package.json.
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_11;
    fetcherVersion = 4;
    hash = lib.fakeHash;
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_11
    pnpmConfigHook
  ];

  buildPhase = ''
    runHook preBuild
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    cp -r dist $out
    runHook postInstall
  '';
})
