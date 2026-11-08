# The site: Postgres, the backend, and Caddy serving the frontend and proxying /api.
# Nothing here is specific to one machine; that is host.nix.
{ lib, pkgs, ... }:

let
  domain = "games.seequ.dev";
  backendAddr = "127.0.0.1:3000";

  backend = pkgs.callPackage ./backend.nix { };
  frontend = pkgs.callPackage ./frontend.nix { };
in
{
  # Postgres is reachable only through its Unix socket. The backend runs as the Unix user
  # `games`, which Postgres maps to the role of the same name (peer authentication, the
  # default for the socket), so there is no password to store.
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
    };

    serviceConfig = {
      # The backend runs its own migrations on startup.
      ExecStart = lib.getExe backend;
      User = "games";
      Group = "games";
      Restart = "on-failure";
      RestartSec = 2;

      # It only talks to Postgres and to Caddy, and writes nothing.
      NoNewPrivileges = true;
      PrivateTmp = true;
      PrivateDevices = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectControlGroups = true;
      RestrictAddressFamilies = [
        "AF_UNIX"
        "AF_INET"
        "AF_INET6"
      ];
      RestrictNamespaces = true;
      LockPersonality = true;
      SystemCallArchitectures = "native";
    };
  };

  # Caddy gets and renews the certificate itself. That needs ${domain} to point at this machine
  # and ports 80 and 443 open.
  services.caddy = {
    enable = true;
    virtualHosts.${domain}.extraConfig = ''
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

  networking.firewall = {
    allowedTCPPorts = [
      80
      443
    ];
    # HTTP/3.
    allowedUDPPorts = [ 443 ];
  };
}
