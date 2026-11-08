# The built frontend: a directory of static files (index.html and assets/) for Caddy to serve.
{
  lib,
  stdenvNoCC,
  nodejs_24,
  pnpm_11,
  pnpmConfigHook,
  fetchPnpmDeps,
  writableTmpDirAsHomeHook,
}:

let
  root = ../..;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "games-frontend";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = root + "/frontend";
    fileset = lib.fileset.unions (map (path: root + "/frontend/${path}") [
      "index.html"
      "package.json"
      "pnpm-lock.yaml"
      "tsconfig.json"
      "vite.config.ts"
      "src"
    ]);
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_11
    pnpmConfigHook
    writableTmpDirAsHomeHook
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_11;
    fetcherVersion = 5;
    hash = "sha256-6eFzEgecijkkJ6x70F6ijUm8rZmO6x4CJTs1LziRJfg=";
  };

  # `pnpm build` type-checks first, so a build that exists has passed that.
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
