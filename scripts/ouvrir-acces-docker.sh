#!/usr/bin/env bash
#
# Autorise n8n, qui tourne en conteneur, à joindre PostgreSQL.
#
# Un conteneur se présente avec une adresse du pont Docker (172.x.y.z).
# Si pg_hba.conf ne la couvre pas, la connexion est refusée avant même
# l'examen du mot de passe — n8n affiche « Couldn't connect ».
#
#   ./scripts/ouvrir-acces-docker.sh verif_loc era            # détecte les ponts
#   ./scripts/ouvrir-acces-docker.sh verif_loc era 172.18.0.0/16
#   ESSAI=1 ./scripts/ouvrir-acces-docker.sh verif_loc era    # sans rien écrire
#
# La règle ajoutée est étroite : cette base, ce rôle, ce réseau. Le fichier
# est sauvegardé avant modification.

set -euo pipefail

BASE="${1:-}"
ROLE="${2:-}"
RESEAU="${3:-}"
ESSAI="${ESSAI:-0}"

[ -n "$BASE" ] && [ -n "$ROLE" ] || {
  echo "Usage : $0 BASE ROLE [RESEAU]" >&2
  echo "  ex.  $0 verif_loc era" >&2
  exit 1
}
for nom in "$BASE" "$ROLE"; do
  printf '%s' "$nom" | grep -qE '^[a-zA-Z_][a-zA-Z0-9_]*$' || {
    echo "Nom invalide : « $nom »" >&2; exit 1; }
done

PSQL="sudo -u postgres psql -At"
HBA="$($PSQL -c 'SHOW hba_file')"
[ -r "$HBA" ] || { echo "pg_hba.conf introuvable : $HBA" >&2; exit 1; }

echo "Fichier      : $HBA"
echo "Écoute sur   : $($PSQL -c 'SHOW listen_addresses'):$($PSQL -c 'SHOW port')"

# --- quels réseaux Docker existent sur cette machine ? -----------------
if [ -z "$RESEAU" ]; then
  RESEAUX="$(ip -4 -o addr show 2>/dev/null \
    | awk '$2 ~ /^(docker|br-)/ {print $4}' \
    | awk -F'[./]' '{print $1"."$2".0.0/16"}' \
    | sort -u)"
  [ -n "$RESEAUX" ] || RESEAUX="172.17.0.0/16"
else
  RESEAUX="$RESEAU"
fi
echo "Réseaux      : $(echo "$RESEAUX" | tr '\n' ' ')"
echo

# --- règles déjà présentes ---------------------------------------------
echo "Règles actuelles :"
grep -vE '^\s*#|^\s*$' "$HBA" | sed 's/^/   /'
echo

# --- ce qu'il manque ----------------------------------------------------
A_AJOUTER=""
for reseau in $RESEAUX; do
  if grep -qE "^\s*host\s+.*\s${reseau//./\\.}\s" "$HBA"; then
    echo "   déjà couvert : $reseau"
  else
    A_AJOUTER="$A_AJOUTER $reseau"
  fi
done

if [ -z "${A_AJOUTER// /}" ]; then
  echo
  echo "Rien à ajouter : pg_hba.conf couvre déjà les réseaux Docker."
  echo "Si n8n échoue encore, c'est le mot de passe. Remets-en un :"
  echo "  sudo -u postgres psql   puis   \\password $ROLE"
  exit 0
fi

echo
echo "À ajouter :"
for reseau in $A_AJOUTER; do
  printf '   host    %s    %s    %s    scram-sha-256\n' "$BASE" "$ROLE" "$reseau"
done

if [ "$ESSAI" = "1" ]; then
  echo
  echo "Essai : rien n'a été écrit."
  exit 0
fi

# --- sauvegarde puis ajout ---------------------------------------------
SAUVEGARDE="$HBA.avant-era.$(date +%Y%m%d%H%M%S)"
sudo cp -p "$HBA" "$SAUVEGARDE"
echo
echo "Sauvegarde   : $SAUVEGARDE"

{
  echo ""
  echo "# Accès de n8n (conteneur Docker) — ajouté le $(date +%F)"
  for reseau in $A_AJOUTER; do
    printf 'host    %s    %s    %s    scram-sha-256\n' "$BASE" "$ROLE" "$reseau"
  done
} | sudo tee -a "$HBA" >/dev/null

# --- rechargement, sans redémarrer le cluster --------------------------
if sudo -u postgres psql -q -c 'SELECT pg_reload_conf()' >/dev/null; then
  echo "Rechargé     : configuration prise en compte, sans coupure"
else
  echo "Rechargement impossible — restaure avec :" >&2
  echo "  sudo cp -p '$SAUVEGARDE' '$HBA'" >&2
  exit 1
fi

echo
echo "Règles effectives :"
sudo -u postgres psql -q -c \
  "SELECT type, database, user_name, address, auth_method
   FROM pg_hba_file_rules
   WHERE error IS NULL AND address IS NOT NULL" 2>/dev/null \
  || grep -vE '^\s*#|^\s*$' "$HBA" | sed 's/^/   /'

echo
echo "Retente maintenant le test de l'identifiant dans n8n."
