# The server, defined for the two tools that touch it. flake.nix merges this into its outputs.
#
#   nixosConfigurations.bootstrap  What nixos-anywhere installs on the bare server, once: a
#                                  system that boots, has a disk layout and accepts SSH.
#   colmena                        What `colmena apply` deploys from then on: the same system
#                                  plus the site (games.nix).
#
# The site is not in the bootstrap on purpose. The installer keeps its filesystem in RAM, and
# compiling the backend and the frontend there could run a small server out of memory. Colmena
# builds them afterwards, on the installed system's disk.
{
  nixpkgs,
  disko,
  # Change to "aarch64-linux" for an ARM server, which also needs its own kexec image.
  system ? "x86_64-linux",
}:

let
  base = [
    disko.nixosModules.disko
    ./disk.nix
    ./host.nix
  ];
in
{
  nixosConfigurations.bootstrap = nixpkgs.lib.nixosSystem {
    inherit system;
    modules = base;
  };

  colmena = {
    meta.nixpkgs = import nixpkgs { inherit system; };

    games = {
      deployment = {
        targetHost = "games.seequ.dev";
        targetUser = "root";
        # The Mac can't build Linux packages and has no Linux builder, so the server builds its
        # own closure. Colmena evaluates here and copies only the derivations over.
        buildOnTarget = true;
      };

      imports = base ++ [ ./games.nix ];
    };
  };
}
