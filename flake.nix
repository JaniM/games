{
  description = "Board game website development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
    llm-agents.url = "github:numtide/llm-agents.nix";
    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";
    crane.url = "github:ipetkov/crane";
  };

  outputs = { self, nixpkgs, flake-utils, llm-agents, disko, crane, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        agents = llm-agents.packages.${system};

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

        # The only commands on Claude's PATH.
        jailTools = projectTools ++ (with pkgs; [
          agents.claude-code
          (neovim.override { viAlias = true; vimAlias = true; })
          bashInteractive
          clang
          coreutils
          curl
          diffutils
          findutils
          gawk
          git
          gnugrep
          gnused
          gnutar
          gzip
          jq
          less
          llvm
          ripgrep
          unzip
          which
        ]);

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

        jailed-claude = pkgs.writeShellApplication {
          name = "jailed-claude";
          runtimeInputs = [ agents.sandbox-runtime ];
          text = ''
            config="''${XDG_CONFIG_HOME:-$HOME/.config}/games-sandbox"
            state="''${XDG_STATE_HOME:-$HOME/.local/state}/games-sandbox"

            # srt-settings.json uses paths relative to the working directory.
            if [ ! -f flake.nix ] || [ ! -d sandbox ]; then
              echo "Run jailed-claude from the repo root." >&2
              exit 1
            fi
            if [ ! -s "$config/claude-token" ]; then
              echo "No token at $config/claude-token. See sandbox/README.md." >&2
              exit 1
            fi

            mkdir -p "$state/home/tmp"
            CLAUDE_CODE_OAUTH_TOKEN=$(cat "$config/claude-token")

            export CLAUDE_CODE_OAUTH_TOKEN
            export HOME="$state/home"
            export TMPDIR="$HOME/tmp"
            export CLAUDE_CODE_TMPDIR="$HOME/tmp"
            export PATH="${pkgs.lib.makeBinPath jailTools}:${agents.sandbox-runtime}/bin"
            export SHELL="${pkgs.bashInteractive}/bin/bash"
            export EDITOR=nvim VISUAL=nvim
            export CARGO_TARGET_DIR="$HOME/cargo-target"
            export LIBRARY_PATH="${pkgs.lib.makeLibraryPath [ pkgs.libiconv ]}"
            # Without it rustc asks xcrun, which isn't on PATH. This is the SDK clang's wrapper falls back to.
            ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''export SDKROOT="${pkgs.apple-sdk.sdkroot}"''}
            export DISABLE_AUTOUPDATER=1
            export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
            export GAMES_SANDBOX=1

            exec srt --settings ${./sandbox/srt-settings.json} -- "''${JAILED_COMMAND:-claude}" "$@"
          '';
        };
      in
      {
        packages.jailed-claude = jailed-claude;
        # NoCC keeps Rust on Apple's linker, as outside the shell.
        devShells.default = pkgs.mkShellNoCC {
          packages = projectTools ++ [ jailed-claude pkgs.colmena pkgs.nixos-anywhere ];
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
