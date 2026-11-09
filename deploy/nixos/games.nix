# The site: Postgres, the backend, and Caddy serving the frontend and proxying /api.
# Nothing here is specific to one machine; that is configuration.nix.
{ lib, pkgs, crane, ... }:

let
  domain = "games.seequ.dev";
  backendAddr = "127.0.0.1:3000";

  backend = pkgs.callPackage ./games-backend.nix { craneLib = crane.mkLib pkgs; };
  frontend = pkgs.callPackage ./games-frontend.nix { };

  # /api/health answers 200 only while the database does.
  waitHealthy = pkgs.writeShellApplication {
    name = "games-wait-healthy";
    runtimeInputs = [ pkgs.coreutils pkgs.curl ];
    text = ''
      for _ in $(seq 30); do
        if curl -fs http://${backendAddr}/api/health >/dev/null; then
          echo "backend healthy"
          exit 0
        fi
        sleep 2
      done
      echo "backend not healthy after 60s: journalctl -u games-backend" >&2
      exit 1
    '';
  };
in
{
  # Postgres is reachable only through its Unix socket. The backend runs as the Unix user
  # `games`, which Postgres maps to the role of the same name (peer authentication, the
  # default for the socket), so there is no password and no secret to store. That is also why
  # the user is a static one: a dynamic user's name isn't known to Postgres ahead of time.
  services.postgresql = {
    enable = true;
    # The version compose.yaml and the devshell use. A major upgrade needs a dump and restore,
    # so don't let a stateVersion or nixpkgs change pick it.
    package = pkgs.postgresql_17;
    ensureDatabases = [ "games" ];
    ensureUsers = [
      {
        name = "games";
        ensureDBOwnership = true;
      }
    ];
  };

  users.users.games = {
    isSystemUser = true;
    group = "games";
  };
  users.groups.games = { };

  # The packages by name, to build one alone:
  # nix build .#nixosConfigurations.games.config.system.build.gamesFrontend
  system.build = {
    gamesBackend = backend;
    gamesFrontend = frontend;
  };

  networking.firewall = {
    allowedTCPPorts = [ 80 443 ];
    # HTTP/3.
    allowedUDPPorts = [ 443 ];
  };

  systemd.services.games-backend = {
    description = "Games backend";
    wantedBy = [ "multi-user.target" ];
    # postgresql.target is reached once the server accepts connections and the database and role
    # above exist. Requires= also restarts the backend whenever Postgres restarts.
    requires = [ "postgresql.target" ];
    after = [ "postgresql.target" ];

    environment = {
      DATABASE_URL = "postgres:///games?host=/run/postgresql&user=games";
      BIND_ADDR = backendAddr;
      RUST_LOG = "warn,games_backend=info";
    };

    serviceConfig = {
      # The backend runs its own migrations on startup.
      ExecStart = lib.getExe backend;
      # The unit fails, and so does colmena apply, if the backend isn't healthy after a start.
      ExecStartPost = lib.getExe waitHealthy;
      User = "games";
      Group = "games";
      Restart = "always";
      RestartSec = 2;

      # It only talks to Postgres and to Caddy, and writes nothing.
      CapabilityBoundingSet = "";
      LockPersonality = true;
      NoNewPrivileges = true;
      PrivateDevices = true;
      PrivateTmp = true;
      ProcSubset = "pid";
      ProtectClock = true;
      ProtectControlGroups = true;
      ProtectHome = true;
      ProtectHostname = true;
      ProtectKernelLogs = true;
      ProtectKernelModules = true;
      ProtectKernelTunables = true;
      ProtectProc = "invisible";
      ProtectSystem = "strict";
      RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_NETLINK" "AF_UNIX" ];
      RestrictNamespaces = true;
      RestrictRealtime = true;
      SystemCallArchitectures = "native";
      UMask = "0077";
    };
  };

  # Caddy gets and renews the certificate itself. That needs ${domain} to point at this machine
  # and ports 80 and 443 open.
  services.caddy = {
    enable = true;
    email = "contact@seequ.dev";
    virtualHosts.${domain}.extraConfig = ''
      header {
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
      }

      # The game sockets (/api/games/<id>/ws) go through here too. Left out of `encode` on purpose.
      handle /api/* {
        reverse_proxy ${backendAddr}
      }

      # Vite puts a hash in these names, so a file never changes. A missing one is a 404, not
      # index.html: a tab left open across a deploy asks for chunks that no longer exist.
      handle /assets/* {
        root * ${frontend}
        encode zstd gzip
        header Cache-Control "public, max-age=31536000, immutable"
        file_server
      }

      # Every other path is a page of the single-page app. index.html must not be cached,
      # or visitors keep the old file names after a deploy.
      handle {
        root * ${frontend}
        encode zstd gzip
        header Cache-Control "no-cache"
        try_files {path} /index.html
        file_server
      }
    '';
  };
}
