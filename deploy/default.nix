# The server, defined for the two tools that touch it. flake.nix merges this into its outputs.
#
#   nixosConfigurations.games  What nixos-anywhere installs on the bare server, once.
#   colmena                    What `colmena apply` deploys from then on. The same modules.
#
# Both are built on your machine, through a Linux builder (README.md), not on the server.
{
  nixpkgs,
  disko,
  crane,
  # Change to "aarch64-linux" for an ARM server, which also needs its own kexec image.
  system ? "x86_64-linux",
}:

let
  modules = [
    # Hands the crane flake to games.nix, which builds the backend with it. Being a module, it
    # reaches both nixosConfigurations and colmena.
    { _module.args = { inherit crane; }; }
    disko.nixosModules.disko
    ./nixos/configuration.nix
    ./nixos/games.nix
  ];
in
{
  nixosConfigurations.games = nixpkgs.lib.nixosSystem {
    inherit system modules;
  };

  colmena = {
    meta.nixpkgs = import nixpkgs { inherit system; };

    games = {
      deployment = {
        targetHost = "games.seequ.dev";
        targetUser = "root";
      };

      imports = modules;
    };
  };
}
