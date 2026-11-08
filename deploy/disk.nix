# The server's disk, which nixos-anywhere partitions and formats with disko when it installs
# NixOS. It ERASES the whole disk. `lsblk` on the server shows which one is right.
#
# GPT with a BIOS boot partition (for GRUB) and an EFI system partition, so the same layout
# boots on either kind of firmware. host.nix tells GRUB to use both.
{
  disko.devices.disk.main = {
    type = "disk";
    device = "/dev/vda";
    content = {
      type = "gpt";
      partitions = {
        boot = {
          size = "1M";
          type = "EF02";
        };
        ESP = {
          size = "512M";
          type = "EF00";
          content = {
            type = "filesystem";
            format = "vfat";
            mountpoint = "/boot";
            mountOptions = [ "umask=0077" ];
          };
        };
        root = {
          size = "100%";
          content = {
            type = "filesystem";
            format = "ext4";
            mountpoint = "/";
          };
        };
      };
    };
  };
}
