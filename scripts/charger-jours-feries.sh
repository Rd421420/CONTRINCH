#!/usr/bin/env bash
#
# Jours fériés, sans Node.
#
# Même travail que charger-jours-feries.js : appelle l'API Etalab et produit
# les INSERT. Utile sur un serveur où Node n'est pas installé — la création
# de la base n'a besoin que de psql.
#
#   ./scripts/charger-jours-feries.sh                    # affiche le SQL
#   ./scripts/charger-jours-feries.sh | psql -d verif_loc
#
# À relancer une fois par an. WF-6 alerte quand le référentiel se périme.

set -euo pipefail

URL="https://calendrier.api.gouv.fr/jours-feries/metropole.json"

command -v python3 >/dev/null || { echo "python3 requis." >&2; exit 1; }

REPONSE="$(mktemp)"
trap 'rm -f "$REPONSE"' EXIT

if ! curl -fsS --max-time 30 "$URL" -o "$REPONSE"; then
  {
    echo "API des jours fériés injoignable : $URL"
    echo "Sans ce référentiel, le J+2 et le compteur de blocage traitent les"
    echo "jours fériés comme des jours ouvrés. À relancer plus tard."
  } >&2
  exit 1
fi

python3 - "$REPONSE" "$URL" <<'PY'
import datetime
import json
import sys

chemin, url = sys.argv[1], sys.argv[2]
with open(chemin, encoding='utf-8') as fichier:
    feries = json.load(fichier)

if not feries:
    sys.exit("Réponse vide de l'API des jours fériés.")


def litteral(valeur):
    """Chaîne SQL : l'apostrophe de « Jour de l'an » doit être doublée."""
    return "'" + str(valeur).replace("'", "''") + "'"


lignes = [f"  ({litteral(jour)}, {litteral(libelle)})"
          for jour, libelle in sorted(feries.items())]

print(f"-- Généré le {datetime.date.today()} depuis {url}")
print("INSERT INTO locatif.jours_feries (jour, libelle) VALUES")
print(",\n".join(lignes))
print("ON CONFLICT (jour) DO UPDATE SET libelle = EXCLUDED.libelle;")
PY
