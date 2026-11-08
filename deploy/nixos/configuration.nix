# The machine: boot, network, SSH, Nix. games.nix is the site on top of it.
{ lib, modulesPath, ... }:

let
  keys = import ./keys.nix;
in
{
  imports = [
    # Virtio disk and network drivers, so there is no hardware-configuration.nix to generate.
    (modulesPath + "/profiles/qemu-guest.nix")
    ./disk.nix
  ];

  assertions = [{
    assertion = keys.admins != [ ];
    message = "deploy/nixos/keys.nix needs an admin SSH key, or nobody can log in.";
  }];

  # The release this server was installed with. It keeps old defaults, such as where state
  # lives, in place across upgrades. Never change it to upgrade.
  system.stateVersion = "26.05";
  networking.hostName = "games";
  networking.useDHCP = lib.mkDefault true;
  zramSwap.enable = true;

  boot.loader.grub = {
    # disko adds the disk with the EF02 partition as the install device.
    efiSupport = true;
    efiInstallAsRemovable = true;
  };

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };
  users.users.root.openssh.authorizedKeys.keys = keys.admins;

  nix = {
    settings = {
      experimental-features = [ "nix-command" "flakes" ];
      auto-optimise-store = true;
    };
    gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 14d";
    };
  };
}
