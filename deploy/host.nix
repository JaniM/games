# What belongs to this one machine rather than to the site.
{ config, ... }:

{
  imports = [
    # Written by nixos-anywhere during the install (`--generate-hardware-config`), from what
    # the installer finds on the server: kernel modules for the disk and network, mostly.
    # The disk layout is disk.nix, so it holds no filesystems. Commit it afterwards.
    ./hardware-configuration.nix
  ];

  networking.hostName = "games";

  # disko adds the disk's BIOS boot partition to GRUB's devices; this adds the EFI side.
  boot.loader.grub = {
    efiSupport = true;
    efiInstallAsRemovable = true;
  };

  services.openssh.enable = true;

  # The only way in after the install: nixos-anywhere replaces the server's own login. Colmena
  # connects with this key too.
  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAep8T/oQbVzeRvHBhm6AlIfCQjp5uI4ALK0fs6nELHh"
  ];

  # NixOS has a check like this, but it is off while users.mutableUsers is true, the default.
  assertions = [
    {
      assertion = config.users.users.root.openssh.authorizedKeys.keys != [ ];
      message = "deploy/host.nix: add your SSH public key to root's authorizedKeys. Without it the installed server can't be logged into.";
    }
  ];

  # The release this server was installed with. It keeps old defaults, such as where state lives,
  # in place across upgrades. Never change it to upgrade.
  system.stateVersion = "26.05";
}
