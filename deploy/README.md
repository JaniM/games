# Deployment

Production is one VM running NixOS, deployed with [Colmena](https://github.com/zhaofengli/colmena).
Nothing runs in a container: Nix builds the backend and the frontend, systemd runs the backend, and
NixOS runs Postgres and Caddy as ordinary services. Caddy serves the frontend at
`games.seequ.dev` and proxies `/api` (WebSockets included) to the backend.

```
flake.nix                            inputs, plus the outputs imported from deploy/
deploy/default.nix                   nixosConfigurations.games and colmena, from the same modules
deploy/nixos/configuration.nix       host: boot, network, SSH, swap, nix
deploy/nixos/disk.nix                disko partitioning (/dev/vda, BIOS+UEFI). Erases the disk
deploy/nixos/keys.nix                admin SSH keys
deploy/nixos/games.nix               firewall, Postgres, the `games-backend` unit, Caddy
deploy/nixos/games-backend.nix       the backend binary (crane: dependencies and crate built apart)
deploy/nixos/games-frontend.nix      the frontend's static files (pnpm + Vite)
```

Postgres listens on its Unix socket only. The backend connects as the Unix user `games`, which
Postgres maps to the role `games` (peer authentication), so there are no passwords or secrets to
manage. The backend runs its own migrations on startup.

## Everyday use

Run inside `nix develop`, which provides `colmena` and `nixos-anywhere`.

```bash
colmena apply --on games       # build, copy, switch; restarts `games-backend` if its binary or config changed
```

What runs is the checkout you apply from: there is no image tag. The closure is built on your
machine, through a local Linux builder (below), not on the VM, which is too small to build.

`games-backend` restarts when its binary or config changes, so the API is down for a second or two
and open game sockets drop (clients reconnect). The unit fails if the backend doesn't answer
`/api/health` within 60 seconds, which fails `colmena apply`. Frontend and Caddy config changes
don't touch the backend.

On the VM:

```bash
systemctl status games-backend caddy postgresql
journalctl -u games-backend -f       # also caddy, postgresql
sudo -u postgres psql games
```

To undo a bad deploy, revert and apply again, or run
`ssh root@games.seequ.dev nixos-rebuild switch --rollback`, which also returns the backend and
frontend to the previous version.

Nothing backs up the database. Before there are users you'd miss, add `services.postgresqlBackup`
and copy the dumps off the machine.

## Local Linux builder

The VM is x86_64-linux and the Mac is Apple Silicon, so Nix needs a Linux builder that can run
x86_64 binaries. nix-darwin's `linux-builder` is an aarch64 VM that does this by emulation. It is
slow: with no binary cache, the first build compiles the backend's dependencies under emulation.
Crane builds them as a derivation of their own, so after that a change to the backend's code
compiles only the crate, and the dependencies build again only when `backend/Cargo.toml` or
`Cargo.lock` change. In the nix-darwin configuration:

```nix
nix.linux-builder = {
  enable = true;
  systems = [ "aarch64-linux" "x86_64-linux" ];
  config.boot.binfmt.emulatedSystems = [ "x86_64-linux" ];
};
```

The customized builder image isn't in the cache, so bootstrap it in two switches: first with only
`enable = true`, then with the full block, which the first builder builds. Once it runs,
`nix build .#nixosConfigurations.games.config.system.build.toplevel` builds on it. Only `nix.conf`'s
`builders` changes, so nothing in this repo depends on the builder.

## First install

Everything on the VM's disk is erased. The first deploy to a VM that runs another OS is
[nixos-anywhere](https://github.com/nix-community/nixos-anywhere), which kexecs into an installer,
partitions the disk with disko and installs. The closure is built here first (`--build-on local`),
so the installer only receives it.

1. Check `lsblk` on the VM against `nixos/disk.nix` (`/dev/vda`). Put your SSH public key in
   `nixos/keys.nix` (`admins`); evaluation fails without one, so you can't lock yourself out.
   Point `games.seequ.dev` (A, and AAAA if the VM has IPv6) at the VM, because Caddy asks Let's
   Encrypt for its certificate on first start.
2. `flake.nix` lives in the git tree, so `git add` (or `jj file track`) new files first or Nix
   won't see them.
3. Pin the frontend's npm hash. `nixos/games-frontend.nix` has `lib.fakeHash`:

   ```bash
   nix build .#nixosConfigurations.games.config.system.build.gamesFrontend
   ```

   fails on the pnpm dependencies with `got: sha256-…`. Put that hash in the file and run it again
   until it builds. Repeat whenever `frontend/pnpm-lock.yaml` changes. Then build the whole system
   once, to find problems before the disk is wiped:

   ```bash
   nix build .#nixosConfigurations.games.config.system.build.toplevel
   ```

4. Install (this wipes the disk):

   ```bash
   caffeinate -i nixos-anywhere --flake .#games --build-on local \
     --kexec-extra-flags "--kexec-syscall" root@games.seequ.dev
   ssh-keygen -R games.seequ.dev   # the host key changed
   ```

   If DNS doesn't point at the VM yet, use its IP instead. `caffeinate` keeps the Mac, and so the
   Linux builder's clock, from sleeping mid-build.
5. Check `curl https://games.seequ.dev/api/health`,
   `ssh root@games.seequ.dev systemctl status games-backend caddy`, and that
   `colmena apply --on games` has nothing to do.

`--kexec-extra-flags "--kexec-syscall"` makes kexec load the installer through the old
`kexec_load` interface. On the current Ubuntu 26.04 image (kernel 7.0, memory hot-plug on) the
default one, `kexec_file_load`, was OOM-killed on a 2 GB VM with 1.4 GB free, however many times it
was retried (`Kexec failed`, `Out of memory: Killed process … (kexec)`), while the old one loaded
the same 349 MB image. It is not a matter of RAM: another 2 GB VM worked without the flag.
Drop the flag if your VM's kernel doesn't need it.

DHCP gives the VM its address. If the VM has no network after the install, use the provider's
console and set `networking` in `nixos/configuration.nix`.

A VM that already runs NixOS doesn't need the installer: `colmena apply` replaces its
configuration, and anything its old configuration set that this tree doesn't is gone.
