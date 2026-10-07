#!/usr/bin/env bash
#
# Préalables et création du projet sur le VPS.
#
# À lancer depuis la racine du dépôt, sur le VPS qui porte n8n, PostgreSQL
# et Ollama. Idempotent : relancé, il ne recrée rien et ne casse rien.
#
#   ./scripts/installer-vps.sh --essai     montre ce qu'il ferait
#   ./scripts/installer-vps.sh
#
# Variables reconnues :
#   BASE            nom de la base PostgreSQL     (défaut : era_loyers)
#   SANS_CRON=1     n'installe pas la ligne de crontab
#   SOCKET=1        passe par « sudo -u postgres », sur la socket unix
#
# SOCKET=1 est le mode le plus simple sur Debian et Ubuntu : ni TCP, ni
# pg_hba, ni mot de passe. Il exige seulement que l'utilisateur postgres
# puisse LIRE le dépôt — donc pas depuis /root, dont le mode est 0700.
#
# Ce qu'il ne fait pas : rien qui touche n8n. L'import des workflows est
# une étape séparée (scripts/importer-workflows.js), et l'activation vient
# encore après.

set -euo pipefail

BASE="${BASE:-era_loyers}"
ESSAI=0
[ "${1:-}" = "--essai" ] || [ "${1:-}" = "--dry-run" ] && ESSAI=1

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RACINE"

# En mode socket, tout passe par le compte postgres.
if [ "${SOCKET:-0}" = "1" ]; then
  PSQL="sudo -u postgres psql"
  CREATEDB="sudo -u postgres createdb"
else
  PSQL="psql"
  CREATEDB="createdb"
fi

etape() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()    { printf '   ok    %s\n' "$1"; }
info()  { printf '   ..    %s\n' "$1"; }
echec() { printf '   ÉCHEC %s\n' "$1" >&2; exit 1; }
faire() { if [ "$ESSAI" = 1 ]; then printf '   [essai] %s\n' "$*"; else eval "$@"; fi; }

# ---------------------------------------------------------------------
etape "1. Préalables"

command -v psql >/dev/null || echec "psql absent — installer le client PostgreSQL"
ok "psql présent"

# Node n'est pas nécessaire pour créer la base : psql suffit, et le
# chargement des jours fériés a une version shell. Il ne sert qu'aux tests
# et au contrôle des requêtes, qui peuvent tourner depuis un autre poste.
AVEC_NODE=0
if command -v node >/dev/null; then
  VERSION_NODE="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$VERSION_NODE" -ge 20 ]; then
    AVEC_NODE=1
    ok "Node $(node -v)"
  else
    info "Node $VERSION_NODE : trop ancien, il en faut 20. Tests et contrôle sautés."
  fi
else
  info "Node absent — la base se crée quand même, seuls les tests et le"
  info "contrôle des requêtes sont sautés. Ils tournent depuis n'importe"
  info "quel poste : voir la fin de ce message."
fi

if command -v ollama >/dev/null; then
  if ollama list 2>/dev/null | grep -q 'qwen2.5:3b-instruct'; then
    ok "modèle qwen2.5:3b-instruct présent"
  else
    info "modèle absent — le tri des mails (WF-1) en aura besoin :"
    info "  ollama pull qwen2.5:3b-instruct-q4_K_M"
  fi
else
  info "ollama absent — seul WF-1 en dépend, le reste tourne sans"
fi

# ---------------------------------------------------------------------
etape "2. Le socle, tel qu'il est livré"

if [ "$AVEC_NODE" = 0 ]; then
  info "sauté, faute de Node"
elif [ "$ESSAI" = 1 ]; then
  info "[essai] npm test"
else
  npm test >/tmp/era-tests.log 2>&1 || {
    tail -20 /tmp/era-tests.log >&2
    echec "les tests ne passent pas — ne pas installer sur cette base"
  }
  ok "$(grep -c '^ok ' /tmp/era-tests.log 2>/dev/null || echo '') tests passés"
fi

# ---------------------------------------------------------------------
etape "3. La base $BASE"

# Sur une installation Debian, seul le rôle « postgres » existe au départ,
# et l'authentification locale est en « peer » : root n'a aucun rôle. C'est
# la première chose sur laquelle on butte, autant la diagnostiquer.
if [ "${SOCKET:-0}" = "1" ]; then
  # psql tourne sous le compte postgres : il doit pouvoir lire les .sql.
  if ! sudo -u postgres test -r "$RACINE/db/schema.sql"; then
    cat >&2 <<AIDE

   ÉCHEC L'utilisateur postgres ne peut pas lire $RACINE.

   C'est le cas quand le dépôt est sous /root, dont le mode est 0700.
   Déplace-le à un endroit lisible, puis relance :

     mv "$RACINE" /opt/era-preetude
     chmod -R a+rX /opt/era-preetude
     cd /opt/era-preetude
     SOCKET=1 BASE=$BASE ./scripts/installer-vps.sh

AIDE
    exit 1
  fi
fi

DIAGNOSTIC="$($PSQL -lqt 2>&1 >/dev/null || true)"
if printf '%s' "$DIAGNOSTIC" | grep -q 'role .* does not exist'; then
  UTILISATEUR="$(id -un)"
  cat >&2 <<AIDE

   ÉCHEC PostgreSQL ne connaît aucun rôle « $UTILISATEUR ».

   C'est le comportement normal d'une installation Debian ou Ubuntu :
   seul le rôle « postgres » existe, et l'authentification locale est en
   « peer » — le nom du compte système doit correspondre au rôle.

   Le plus simple, sans TCP ni mot de passe — le dépôt doit être lisible
   par postgres, donc hors de /root :

     SOCKET=1 BASE=$BASE ./scripts/installer-vps.sh

   Si tu préfères passer par TCP, crée d'abord le rôle applicatif — c'est
   aussi celui dont n8n aura besoin :

     sudo -u postgres psql -c "CREATE ROLE era LOGIN PASSWORD 'À_CHANGER';"
     sudo -u postgres createdb -O era $BASE
     export PGHOST=127.0.0.1 PGUSER=era PGPASSWORD='À_CHANGER' PGDATABASE=$BASE
     BASE=$BASE ./scripts/installer-vps.sh

AIDE
  exit 1
fi

if $PSQL -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$BASE"; then
  ok "base $BASE déjà présente"
else
  info "base $BASE absente, création"
  faire "$CREATEDB '$BASE'"
fi

for migration in db/schema.sql db/002-file-sms.sql db/003-arbitrage.sql; do
  faire "$PSQL -d '$BASE' -v ON_ERROR_STOP=1 -q -f '$RACINE/$migration'"
  ok "$migration"
done

if [ "$ESSAI" = 0 ]; then
  TABLES="$($PSQL -d "$BASE" -At -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='locatif'")"
  [ "$TABLES" -ge 8 ] || echec "seulement $TABLES tables dans le schéma locatif, il en faut 8"
  ok "$TABLES tables dans le schéma locatif"
fi

# ---------------------------------------------------------------------
etape "4. Les jours fériés"

# La version shell ne demande que curl et python3 : elle passe partout.
if [ -x scripts/charger-jours-feries.sh ]; then
  CHARGEUR="./scripts/charger-jours-feries.sh"
else
  CHARGEUR="node scripts/charger-jours-feries.js"
fi

if [ "$ESSAI" = 1 ]; then
  info "[essai] $CHARGEUR | psql -d $BASE"
else
  if $CHARGEUR > /tmp/era-feries.sql 2>/tmp/era-feries.err; then
    chmod a+r /tmp/era-feries.sql
    $PSQL -d "$BASE" -v ON_ERROR_STOP=1 -q -f /tmp/era-feries.sql
    ANNEE="$($PSQL -d "$BASE" -At -c "SELECT extract(year FROM max(jour)) FROM locatif.jours_feries")"
    ok "référentiel chargé, couvert jusqu'en ${ANNEE%.*}"
  else
    info "API Etalab injoignable : $(head -1 /tmp/era-feries.err)"
    info "sans ce référentiel, le J+2 et le compteur de blocage traitent"
    info "les jours fériés comme des jours ouvrés — à relancer plus tard :"
    info "  $CHARGEUR | $PSQL -d $BASE"
  fi
fi

# ---------------------------------------------------------------------
etape "5. La purge quotidienne"

LIGNE="0 3 * * *  $PSQL -d $BASE -c \"SELECT locatif.purger_candidats();\""
if [ "${SANS_CRON:-0}" = "1" ]; then
  info "ignorée (SANS_CRON=1). À ajouter à la main :"
  info "  $LIGNE"
elif crontab -l 2>/dev/null | grep -q 'purger_candidats'; then
  ok "ligne de crontab déjà en place"
elif [ "$ESSAI" = 1 ]; then
  info "[essai] ajout à la crontab : $LIGNE"
else
  { crontab -l 2>/dev/null || true; echo "$LIGNE"; } | crontab -
  ok "ligne de crontab ajoutée — vérifier purge_log demain"
fi

# ---------------------------------------------------------------------
etape "6. Contrôle du schéma et des requêtes"

if [ "$AVEC_NODE" = 0 ]; then
  info "sauté, faute de Node. À lancer depuis un poste qui en a :"
  info "  node scripts/verifier-base.js --base $BASE"
elif [ "$ESSAI" = 1 ]; then
  info "[essai] node scripts/verifier-base.js --base $BASE"
else
  SOCKET="${SOCKET:-0}" node scripts/verifier-base.js --base "$BASE" \
    || echec "le contrôle a relevé des écarts"
fi

# ---------------------------------------------------------------------
cat <<FIN

$( [ "$ESSAI" = 1 ] && echo "Essai terminé : rien n'a été écrit." || echo "Préalables terminés." )

Il reste, dans l'ordre :

  0. Si Node manque sur ce serveur, ce n'est pas bloquant : les tests,
     le contrôle des requêtes et l'import des workflows tournent depuis
     n'importe quel poste. L'import parle à n8n en HTTPS, il n'a pas
     besoin d'être sur le serveur.

  1. Importer les workflows dans n8n
       n8n → Settings → API → Create an API key
       export N8N_URL=https://ton-n8n.fr N8N_API_KEY=...
       node scripts/importer-workflows.js

  1 bis. Si l'installation vient de tourner en mode SOCKET=1, tout
     appartient au compte postgres et le rôle de n8n n'a aucun droit :

       sudo -u postgres psql -c "CREATE ROLE era LOGIN PASSWORD 'ÀChanger';"
       ./scripts/attribuer-role.sh $BASE era

  2. Rattacher les identifiants dans n8n
       Postgres, Twilio, Telegram, Google Agenda, Gmail, SMTP

  3. Renseigner le node « Paramètres » dans les douze workflows

  4. Coller l'URL du webhook de WF-2 bis dans Twilio

  5. Les essais à blanc, puis l'activation
       docs/INSTALLATION.md, étapes 10 et 11

  Ne pas activer WF-2 ter avant d'être en confiance : tant qu'il dort,
  tout s'accumule dans file_sms et aucun SMS ne part.

FIN
