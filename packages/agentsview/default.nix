{ pkgs, agentsview-src }:

let
  frontend = pkgs.buildNpmPackage {
    pname = "agentsview-frontend";
    version = "0.0.1";
    src = "${agentsview-src}/frontend";
    npmDepsHash = "sha256-WD488AWxu7xa29P0oqcLBYS2TgvUyjLPIz1V0zY+iC4=";
    installPhase = ''
      mkdir -p $out
      cp -r dist/* $out/
    '';
  };
in
pkgs.buildGoModule {
  pname = "agentsview";
  version = "0.0.1";
  src = agentsview-src;

  vendorHash = "sha256-EssCuGpX/GTqkKkg9mGZgOK13Cgc60PKKHlG9X94orU=";

  tags = [ "fts5" ];
  env.CGO_ENABLED = "1";

  ldflags = [ "-s" "-w" ];
  subPackages = [ "cmd/agentsview" ];

  preBuild = ''
    rm -rf internal/web/dist
    cp -r ${frontend} internal/web/dist
  '';
}
