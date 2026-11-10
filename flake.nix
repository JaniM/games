{
  description = "Board game website development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";
    crane.url = "github:ipetkov/crane";
  };

  outputs = { self, nixpkgs, flake-utils, disko, crane, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Keep pnpm in step with packageManager in package.json.
        projectTools = with pkgs; [
          cargo
          clippy
          nodejs_24
          pnpm_11
          postgresql_17
          rustc
          rustfmt
          sqlx-cli
        ];

        # zsh has no hook after .zshrc, so this wraps it to add the label on top of the user's theme.
        devshellZdotdir = pkgs.writeTextFile {
          name = "devshell-zdotdir";
          destination = "/.zshrc";
          text = ''
            ZDOTDIR=$DEVSHELL_ZDOTDIR
            unset DEVSHELL_ZDOTDIR
            [[ -f $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
            [[ -f $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
            PROMPT="%F{cyan}devshell%f $PROMPT"
          '';
        };
      in
      {
        # NoCC keeps Rust on Apple's linker, as outside the shell.
        devShells.default = pkgs.mkShellNoCC {
          packages = projectTools ++ [ pkgs.colmena pkgs.nixos-anywhere ];
          LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.libiconv ];
          # A child, not exec, so nix develop's exit cleanup still runs. Scripts using -c stay in bash.
          shellHook = ''
            unset MACOSX_DEPLOYMENT_TARGET
            if [[ $- == *i* ]] && command -v zsh >/dev/null; then
              DEVSHELL_ZDOTDIR=''${ZDOTDIR:-$HOME} ZDOTDIR=${devshellZdotdir} SHELL=$(command -v zsh) zsh
              exit $?
            fi
          '';
        };
      })
    # The server: nixosConfigurations.bootstrap for nixos-anywhere, colmena for Colmena.
    // import ./deploy { inherit nixpkgs disko crane; };
}
