{
  description = "External Nix CI image experiments for workflow-builder";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f {
            inherit system;
            pkgs = import nixpkgs { inherit system; };
          }
        );
    in
    {
      packages = forAllSystems (
        { pkgs, ... }:
        (import ./nix/images.nix {
          inherit pkgs;
          inherit (pkgs) lib;
        }).packages
      );

      legacyPackages = forAllSystems (
        { pkgs, ... }:
        (import ./nix/images.nix {
          inherit pkgs;
          inherit (pkgs) lib;
        }).legacyPackages
      );

      checks = forAllSystems (
        { pkgs, ... }:
        (import ./nix/images.nix {
          inherit pkgs;
          inherit (pkgs) lib;
        }).checks
      );

      devShells = forAllSystems (
        { pkgs, ... }:
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nix
              pkgs.skopeo
              pkgs.crane
              pkgs.cosign
              pkgs.syft
              pkgs.grype
              pkgs.jq
              pkgs.yq-go
              pkgs.git
              pkgs.nodejs_22
              pkgs.pnpm
              pkgs.python312
              pkgs.cargo
              pkgs.rustc
            ];
          };
        }
      );
    };
}
