{ pkgs, lib }:

let
  nodejs = pkgs.nodejs_22;

  sourceFilter =
    path: type:
    let
      base = baseNameOf path;
    in
    !(type == "directory" && builtins.elem base [
      "node_modules"
      "dist"
      "build"
      "target"
      ".venv"
      ".pytest_cache"
      ".ruff_cache"
      "__pycache__"
    ]);

  cleanSource = src: lib.cleanSourceWith { inherit src; filter = sourceFilter; };

  repositoryFor = name:
    if name == "workspace-runtime" then
      "opencode-durable-agent"
    else
      name;

  ghcrRepositoryFor = name: "ghcr.io/pittampalliorg/${repositoryFor name}";

  mkArchive = name: layeredImage:
    pkgs.runCommand "${name}-docker-archive.tar" { nativeBuildInputs = [ pkgs.gzip ]; } ''
      gzip -dc "${layeredImage}" > "$out"
    '';

  mkDigest = name: image:
    pkgs.runCommand "${name}-image-digest" {
      nativeBuildInputs = [
        pkgs.coreutils
        pkgs.gawk
      ];
    } ''
      export TMPDIR="$PWD/tmp"
      mkdir -p "$TMPDIR" "$out"
      sha256sum "${image}" | awk '{ print "sha256:" $1 }' > "$out/digest.txt"
      grep -Eq '^sha256:[0-9a-f]{64}$' "$out/digest.txt"
    '';

  mkSbom = name: app:
    pkgs.runCommand "${name}-sbom" { nativeBuildInputs = [ pkgs.syft ]; } ''
      export TMPDIR="$PWD/tmp"
      export HOME="$PWD/home"
      export XDG_CACHE_HOME="$PWD/cache"
      export SYFT_CHECK_FOR_APP_UPDATE=false
      mkdir -p "$TMPDIR" "$HOME" "$XDG_CACHE_HOME" "$out"
      syft -q "dir:${app}" -o spdx-json > "$out/${name}.spdx.json"
      test -s "$out/${name}.spdx.json"
    '';

  mkNodeService =
    {
      name,
      src,
      pnpmDepsHash,
      distEntry ? "dist/index.js",
      port ? 8080,
      copyNodeModules ? false,
      extraRuntimeContents ? [ ],
      extraEnv ? [ ],
      checkEntry ? distEntry,
      buildScript ? "build",
    }:
    let
      app = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = name;
        version = "1.0.0";

        src = cleanSource src;

        pnpmDeps = pkgs.fetchPnpmDeps {
          inherit (finalAttrs) pname version src;
          fetcherVersion = 2;
          hash = pnpmDepsHash;
        };

        nativeBuildInputs = [
          nodejs
          pkgs.pnpm
          pkgs.pnpmConfigHook
        ];

        buildPhase = ''
          runHook preBuild
          export HOME="$TMPDIR"
          pnpm run ${buildScript}
          runHook postBuild
        '';

        doCheck = true;
        checkPhase = ''
          runHook preCheck
          node --check ${checkEntry}
          test -s ${distEntry}
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/app"
          cp -R dist package.json "$out/app/"
        '' + lib.optionalString copyNodeModules ''
          cp -R node_modules "$out/app/node_modules"
        '' + ''
          runHook postInstall
        '';
      });

      layeredImage = pkgs.dockerTools.buildLayeredImage {
        name = ghcrRepositoryFor name;
        tag = "nix-ci";
        created = "1970-01-01T00:00:01Z";
        contents = [
          nodejs
          pkgs.cacert
          app
        ] ++ extraRuntimeContents;
        config = {
          Cmd = [
            "${nodejs}/bin/node"
            "${app}/app/${distEntry}"
          ];
          WorkingDir = "${app}/app";
          Env = [
            "NODE_ENV=production"
            "PORT=${toString port}"
            "HOST=0.0.0.0"
            "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
          ] ++ extraEnv;
          ExposedPorts = {
            "${toString port}/tcp" = { };
          };
          User = "1001:1001";
          Labels = {
            "org.opencontainers.image.source" = "https://github.com/PittampalliOrg/workflow-builder";
            "org.opencontainers.image.title" = name;
            "org.opencontainers.image.created" = "1970-01-01T00:00:01Z";
          };
        };
      };

      image = mkArchive name layeredImage;
    in
    {
      package = app;
      inherit image;
      sbom = mkSbom name app;
      digest = mkDigest name image;
    };

  nodeServices = {
    mcp-gateway = mkNodeService {
      name = "mcp-gateway";
      src = ../services/mcp-gateway;
      pnpmDepsHash = "sha256-iHJG2ThFjymunT2Zh7pMUwH4127XMMFA0c5mhVg4OAU=";
    };

    function-router = mkNodeService {
      name = "function-router";
      src = ../services/function-router;
      pnpmDepsHash = "sha256-XXTWDeUTYnWFU6Hh42vzbpHDVuaHhw6i/AVDmLw1ReA=";
    };

    code-runtime = mkNodeService {
      name = "code-runtime";
      src = ../services/code-runtime;
      pnpmDepsHash = "sha256-0RDCyVrsuQLpOdP9PlB55MXptaWFQlO4Bbret6jOCz4=";
      distEntry = "dist/index.cjs";
      copyNodeModules = true;
      extraRuntimeContents = [ pkgs.python312 ];
    };

    fn-system = mkNodeService {
      name = "fn-system";
      src = ../services/fn-system;
      pnpmDepsHash = "sha256-9oXV+enp2yrnhrJJ7DWrfjaCj/eVbVZovcl+ljxrJic=";
    };

    fn-activepieces = mkNodeService {
      name = "fn-activepieces";
      src = ../services/fn-activepieces;
      pnpmDepsHash = "sha256-gNxD767DT7iufa5tLJm5eqncMf3sXTVxSDuWCnNs700=";
      copyNodeModules = true;
    };

    workflow-mcp-server = mkNodeService {
      name = "workflow-mcp-server";
      src = ../services/workflow-mcp-server;
      pnpmDepsHash = "sha256-mZLOAfUptRWU2dRCCk3oKLipIa9AvznNf22/8+1ETF4=";
      port = 3200;
      copyNodeModules = true;
      buildScript = "build:all";
    };
  };

  imageCatalog = [
    {
      name = "workflow-builder";
      kind = "node-sveltekit-root";
      dockerfile = "Dockerfile";
      context = ".";
      buildable = false;
      enabled = false;
      blocker = "Root SvelteKit app needs a root pnpmDeps hash and a production node_modules split before enabling.";
    }
    {
      name = "workflow-mcp-server";
      kind = "node-service";
      dockerfile = "services/workflow-mcp-server/Dockerfile";
      context = "services/workflow-mcp-server";
      buildable = true;
      enabled = false;
    }
    {
      name = "mcp-gateway";
      kind = "node-service";
      dockerfile = "services/mcp-gateway/Dockerfile";
      context = ".";
      buildable = true;
      enabled = true;
    }
    {
      name = "function-router";
      kind = "node-service";
      dockerfile = "services/function-router/Dockerfile";
      context = ".";
      buildable = true;
      enabled = false;
    }
    {
      name = "workflow-orchestrator";
      kind = "python-uv-service";
      dockerfile = "services/workflow-orchestrator/Dockerfile";
      context = "services/workflow-orchestrator";
      buildable = false;
      enabled = false;
      blocker = "Python uv/pyproject lock needs a Nix resolver before building without pip network access.";
    }
    {
      name = "code-parser";
      kind = "rust-service";
      dockerfile = "services/code-parser/Dockerfile";
      context = "services/code-parser";
      buildable = false;
      enabled = false;
      blocker = "Cargo vendor hash needs to be captured before enabling the Rust image output.";
    }
    {
      name = "code-runtime";
      kind = "node-service";
      dockerfile = "services/code-runtime/Dockerfile";
      context = ".";
      buildable = true;
      enabled = false;
    }
    {
      name = "openshell-agent-runtime";
      kind = "manifest-configmap-runtime";
      dockerfile = "";
      context = "";
      buildable = false;
      enabled = false;
      blocker = "Runtime code is mounted from stacks ConfigMaps; define a base runtime image contract before producing an app image.";
    }
    {
      name = "openshell-sandbox";
      kind = "sandbox-base";
      dockerfile = "services/openshell-sandbox/Dockerfile";
      context = "services/openshell-sandbox";
      buildable = false;
      enabled = false;
      blocker = "Depends on external Ubuntu/Playwright sandbox base and browser payload; pin base digest before Nix-native rebuild.";
    }
    {
      name = "openshell-sandbox-xlsx";
      kind = "sandbox-base";
      dockerfile = "services/openshell-sandbox/Dockerfile.xlsx";
      context = "services/openshell-sandbox";
      buildable = false;
      enabled = false;
      blocker = "Depends on external Ubuntu/LibreOffice/Playwright base payload; pin base digest before Nix-native rebuild.";
    }
    {
      name = "dapr-agent-py-sandbox";
      kind = "python-uv-sandbox";
      dockerfile = "services/dapr-agent-py/Dockerfile.sandbox";
      context = "services/dapr-agent-py";
      buildable = false;
      enabled = false;
      blocker = "Depends on openshell-sandbox base image and uv Python dependency resolution.";
    }
    {
      name = "dapr-agent-py-testing-sandbox";
      kind = "python-uv-sandbox";
      dockerfile = "services/dapr-agent-py/Dockerfile.sandbox-testing";
      context = "services/dapr-agent-py";
      buildable = false;
      enabled = false;
      blocker = "Depends on openshell-sandbox base image and uv Python dependency resolution.";
    }
    {
      name = "browser-use-agent-sandbox";
      kind = "python-browser-sandbox";
      dockerfile = "";
      context = "";
      buildable = false;
      enabled = false;
      blocker = "No current workflow-builder Dockerfile is present for this release-pin image.";
    }
    {
      name = "browserstation";
      kind = "python-ray-service";
      dockerfile = "services/browserstation/Dockerfile";
      context = "services/browserstation";
      buildable = false;
      enabled = false;
      blocker = "Depends on rayproject/ray base semantics; replace with pinned Nix Ray runtime before enabling.";
    }
    {
      name = "chrome-sandbox";
      kind = "go-browser-sandbox";
      dockerfile = "services/chrome-sandbox/Dockerfile";
      context = "services/chrome-sandbox";
      buildable = false;
      enabled = false;
      blocker = "Depends on openshell-sandbox base plus VNC/Chromium runtime contract.";
    }
    {
      name = "workspace-runtime";
      kind = "durable-agent";
      dockerfile = "";
      context = "";
      buildable = false;
      enabled = false;
      blocker = "Release pin maps to ghcr.io/pittampalliorg/opencode-durable-agent, but no current source Dockerfile exists in this repo.";
    }
    {
      name = "evaluation-coordinator";
      kind = "python-service";
      dockerfile = "services/evaluation-coordinator/Dockerfile";
      context = "services/evaluation-coordinator";
      buildable = false;
      enabled = false;
      blocker = "Python pyproject dependency lock needs a Nix resolver before building without pip network access.";
    }
    {
      name = "swebench-coordinator";
      kind = "python-service";
      dockerfile = "services/swebench-coordinator/Dockerfile";
      context = "services/swebench-coordinator";
      buildable = false;
      enabled = false;
      blocker = "Python pyproject dependency lock needs a Nix resolver before building without pip network access.";
    }
    {
      name = "swebench-evaluator";
      kind = "python-service";
      dockerfile = "services/swebench-evaluator/Dockerfile";
      context = "services/swebench-evaluator";
      buildable = false;
      enabled = false;
      blocker = "Ad-hoc pip install list needs a Nix Python dependency set before building without pip network access.";
    }
    {
      name = "fn-system";
      kind = "node-service";
      dockerfile = "services/fn-system/Dockerfile";
      context = ".";
      buildable = true;
      enabled = false;
    }
    {
      name = "fn-activepieces";
      kind = "node-service";
      dockerfile = "services/fn-activepieces/Dockerfile";
      context = ".";
      buildable = true;
      enabled = false;
    }
  ];

  configFor = entry:
    let
      repo = ghcrRepositoryFor entry.name;
    in
    entry // {
      registryRepository = repo;
      nixPackage = "${entry.name}-image";
      digestPackage = "${entry.name}-image-digest";
      sbomPackage = "${entry.name}-sbom";
    };

  imageConfigurations = map configFor imageCatalog;

  nodePackages = lib.concatMapAttrs (
    name: outputs:
    {
      "${name}" = outputs.package;
      "${name}-image" = outputs.image;
      "${name}-sbom" = outputs.sbom;
      "${name}-image-digest" = outputs.digest;
    }
  ) nodeServices;

  imageNamespace = lib.mapAttrs (_: outputs: outputs.image) nodeServices;

  catalogCheck = pkgs.runCommand "workflow-builder-image-catalog-check" { } ''
    test ${toString (builtins.length imageConfigurations)} -eq 21
    touch "$out"
  '';
in
{
  packages = nodePackages // {
    default = nodeServices.mcp-gateway.package;
  };

  legacyPackages = {
    images = imageNamespace;
    inherit imageConfigurations;
    nixCiImages = imageConfigurations;
  };

  checks = {
    image-catalog = catalogCheck;
  } // lib.mapAttrs' (name: outputs: {
    name = "${name}-image";
    value = outputs.image;
  }) nodeServices;
}
