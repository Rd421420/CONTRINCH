#!/usr/bin/env bash
#
# Donne la base et son schéma au rôle applicatif.
#
# Utile quand l'installation a été faite en mode SOCKET=1 : psql tournait
# alors sous le compte postgres, qui se retrouve propriétaire de tout. Le
# rôle avec lequel n8n se connecte n'a alors aucun droit.
#
#   ./scripts/attribuer-role.sh verif_loc era
#
# Sans effet si c'est déjà fait : relançable sans risque.

set -euo pipefail

BASE="${1:-}"
ROLE="${2:-}"

if [ -z "$BASE" ] || [ -z "$ROLE" ]; then
  echo "Usage : $0 BASE ROLE" >&2
  echo "  ex.  $0 verif_loc era" >&2
  exit 1
fi

# Les deux noms partent dans du SQL construit : on n'accepte que des
# identifiants simples, plutôt que de parier sur l'échappement.
for nom in "$BASE" "$ROLE"; do
  if ! printf '%s' "$nom" | grep -qE '^[a-zA-Z_][a-zA-Z0-9_]*$'; then
    echo "Nom invalide : « $nom » — lettres, chiffres et souligné seulement." >&2
    exit 1
  fi
done

PSQL="sudo -u postgres psql -v ON_ERROR_STOP=1 -q"

$PSQL -c "SELECT 1 FROM pg_roles WHERE rolname = '$ROLE'" | grep -q 1 || {
  echo "Le rôle « $ROLE » n'existe pas. Créez-le d'abord :" >&2
  echo "  sudo -u postgres psql -c \"CREATE ROLE $ROLE LOGIN PASSWORD '...';\"" >&2
  exit 1
}

$PSQL -c "ALTER DATABASE $BASE OWNER TO $ROLE;"

$PSQL -d "$BASE" <<SQL
ALTER SCHEMA locatif OWNER TO $ROLE;

-- Tables, séquences et fonctions : le propriétaire se change objet par
-- objet. REASSIGN OWNED BY postgres emporterait aussi ce qui ne nous
-- regarde pas.
DO \$\$
DECLARE ligne record;
BEGIN
  FOR ligne IN SELECT tablename FROM pg_tables WHERE schemaname = 'locatif' LOOP
    EXECUTE format('ALTER TABLE locatif.%I OWNER TO $ROLE', ligne.tablename);
  END LOOP;

  FOR ligne IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'locatif' LOOP
    EXECUTE format('ALTER SEQUENCE locatif.%I OWNER TO $ROLE', ligne.sequencename);
  END LOOP;

  FOR ligne IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS parametres
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'locatif'
  LOOP
    EXECUTE format('ALTER FUNCTION locatif.%I(%s) OWNER TO $ROLE',
                   ligne.proname, ligne.parametres);
  END LOOP;
END
\$\$;
SQL

RESTANT="$($PSQL -d "$BASE" -At -c "
  SELECT count(*) FROM pg_tables
  WHERE schemaname = 'locatif' AND tableowner <> '$ROLE'")"

if [ "$RESTANT" != "0" ]; then
  echo "Il reste $RESTANT table(s) hors de $ROLE." >&2
  exit 1
fi

echo "La base $BASE et le schéma locatif appartiennent à $ROLE."
$PSQL -d "$BASE" -c "\dt locatif.*"
