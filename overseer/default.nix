{ pkgs }:

pkgs.stdenv.mkDerivation {
  pname = "homie-overseer";
  version = "0.1.0";
  src = ./.;

  buildInputs = [ pkgs.python3 ];

  installPhase = ''
    mkdir -p $out/bin
    echo "#!${pkgs.python3}/bin/python3" > $out/bin/homie-overseer
    cat overseer.py >> $out/bin/homie-overseer
    chmod +x $out/bin/homie-overseer
  '';
}
