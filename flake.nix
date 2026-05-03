{
  description = "External Nix CI image experiments for workflow-builder";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs, ... }:
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
        let
          lib = pkgs.lib;
          nodejs = pkgs.nodejs_22;

          mcpGateway = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "mcp-gateway";
            version = "1.0.0";

            src = lib.cleanSourceWith {
              src = ./services/mcp-gateway;
              filter =
                path: type:
                let
                  base = baseNameOf path;
                in
                !(type == "directory" && builtins.elem base [
                  "node_modules"
                  "dist"
                ]);
            };

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              fetcherVersion = 2;
              hash = "sha256-iHJG2ThFjymunT2Zh7pMUwH4127XMMFA0c5mhVg4OAU=";
            };

            nativeBuildInputs = [
              nodejs
              pkgs.pnpm
              pkgs.pnpmConfigHook
            ];

            buildPhase = ''
              runHook preBuild
              export HOME="$TMPDIR"
              pnpm run build
              runHook postBuild
            '';

            doCheck = true;
            checkPhase = ''
              runHook preCheck
              node --check dist/index.js
              test -s dist/index.js
              runHook postCheck
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p "$out/app"
              cp -R dist package.json "$out/app/"
              runHook postInstall
            '';
          });

          mcpGatewayLayeredImage = pkgs.dockerTools.buildLayeredImage {
            name = "ghcr.io/pittampalliorg/mcp-gateway";
            tag = "nix-ci";
            created = "1970-01-01T00:00:01Z";
            contents = [
              nodejs
              pkgs.cacert
              mcpGateway
            ];
            config = {
              Cmd = [
                "${nodejs}/bin/node"
                "${mcpGateway}/app/dist/index.js"
              ];
              WorkingDir = "${mcpGateway}/app";
              Env = [
                "NODE_ENV=production"
                "PORT=8080"
                "HOST=0.0.0.0"
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              ];
              ExposedPorts = {
                "8080/tcp" = { };
              };
              User = "1001:1001";
              Labels = {
                "org.opencontainers.image.source" = "https://github.com/PittampalliOrg/workflow-builder";
                "org.opencontainers.image.title" = "mcp-gateway";
                "org.opencontainers.image.created" = "1970-01-01T00:00:01Z";
              };
            };
          };

          mcpGatewayImage = pkgs.runCommand "mcp-gateway-docker-archive.tar" { nativeBuildInputs = [ pkgs.gzip ]; } ''
            gzip -dc "${mcpGatewayLayeredImage}" > "$out"
          '';

          mcpGatewaySbom = pkgs.runCommand "mcp-gateway-sbom" { nativeBuildInputs = [ pkgs.syft ]; } ''
            export TMPDIR="$PWD/tmp"
            export HOME="$PWD/home"
            export XDG_CACHE_HOME="$PWD/cache"
            mkdir -p "$TMPDIR" "$HOME" "$XDG_CACHE_HOME"
            mkdir -p "$out"
            set +e
            syft "dir:${mcpGateway}" -o spdx-json > "$out/mcp-gateway.spdx.json" 2>syft.log
            status="$?"
            set -e
            cat syft.log >&2
            if [ "$status" -ne 0 ]; then
              exit "$status"
            fi
            test -s "$out/mcp-gateway.spdx.json"
          '';

          mcpGatewayImageDigest = pkgs.runCommand "mcp-gateway-image-digest" {
            nativeBuildInputs = [
              pkgs.coreutils
              pkgs.gawk
            ];
          } ''
            export TMPDIR="$PWD/tmp"
            mkdir -p "$TMPDIR"
            mkdir -p "$out"
            sha256sum "${mcpGatewayImage}" \
              | awk '{ print "sha256:" $1 }' > "$out/digest.txt"
            grep -Eq '^sha256:[0-9a-f]{64}$' "$out/digest.txt"
          '';
        in
        {
          default = mcpGateway;
          mcp-gateway = mcpGateway;
          mcp-gateway-image = mcpGatewayImage;
          mcp-gateway-sbom = mcpGatewaySbom;
          mcp-gateway-image-digest = mcpGatewayImageDigest;
        }
      );

      legacyPackages = forAllSystems (
        { system, ... }:
        {
          # Keep a nested image namespace for CI/discovery without making
          # packages.${system}.images an invalid flake package.
          images = {
            mcp-gateway = self.packages.${system}.mcp-gateway-image;
          };
        }
      );

      checks = forAllSystems (
        { system, ... }:
        {
          mcp-gateway = self.packages.${system}.mcp-gateway;
          mcp-gateway-image = self.packages.${system}.mcp-gateway-image;
          mcp-gateway-sbom = self.packages.${system}.mcp-gateway-sbom;
          mcp-gateway-image-digest = self.packages.${system}.mcp-gateway-image-digest;
        }
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
            ];
          };
        }
      );
    };
}
