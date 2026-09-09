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
#   BASE          nom de la base PostgreSQL      (défaut : era_loyers)
#   SANS_CRON=1   n'installe pas la ligne de crontab
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

etape() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()    { printf '   ok    %s\n' "$1"; }
info()  { printf '   ..    %s\n' "$1"; }
echec() { printf '   ÉCHEC %s\n' "$1" >&2; exit 1; }
faire() { if [ "$ESSAI" = 1 ]; then printf '   [essai] %s\n' "$*"; else eval "$@"; fi; }

# ---------------------------------------------------------------------
etape "1. Préalables"

command -v node >/dev/null || echec "node absent — il faut Node 20 ou plus"
VERSION_NODE="$(node -p 'process.versions.node.split(".")[0]')"
[ "$VERSION_NODE" -ge 20 ] || echec "Node $VERSION_NODE — il en faut 20 au minimum"
ok "Node $(node -v)"

command -v psql >/dev/null || echec "psql absent — installer le client PostgreSQL"
ok "psql présent"

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

if [ -d node_modules ] || [ -f package-lock.json ]; then
  info "aucune dépendance à installer : le projet n'en a pas"
fi
if [ "$ESSAI" = 1 ]; then
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

if psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$BASE"; then
  ok "base $BASE déjà présente"
else
  info "base $BASE absente, création"
  faire "createdb '$BASE'"
fi

for migration in db/schema.sql db/002-file-sms.sql db/003-arbitrage.sql; do
  faire "psql -d '$BASE' -v ON_ERROR_STOP=1 -q -f '$migration'"
  ok "$migration"
done

if [ "$ESSAI" = 0 ]; then
  TABLES="$(psql -d "$BASE" -At -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='locatif'")"
  [ "$TABLES" -ge 8 ] || echec "seulement $TABLES tables dans le schéma locatif, il en faut 8"
  ok "$TABLES tables dans le schéma locatif"
fi

# ---------------------------------------------------------------------
etape "4. Les jours fériés"

if [ "$ESSAI" = 1 ]; then
  info "[essai] node scripts/charger-jours-feries.js | psql -d $BASE"
else
  if node scripts/charger-jours-feries.js > /tmp/era-feries.sql 2>/tmp/era-feries.err; then
    psql -d "$BASE" -v ON_ERROR_STOP=1 -q -f /tmp/era-feries.sql
    ANNEE="$(psql -d "$BASE" -At -c "SELECT extract(year FROM max(jour)) FROM locatif.jours_feries")"
    ok "référentiel chargé, couvert jusqu'en ${ANNEE%.*}"
  else
    info "API Etalab injoignable : $(head -1 /tmp/era-feries.err)"
    info "sans ce référentiel, le J+2 et le compteur de blocage traitent"
    info "les jours fériés comme des jours ouvrés — à relancer plus tard :"
    info "  node scripts/charger-jours-feries.js | psql -d $BASE"
  fi
fi

# ---------------------------------------------------------------------
etape "5. La purge quotidienne"

LIGNE="0 3 * * *  psql -d $BASE -c \"SELECT locatif.purger_candidats();\""
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

if [ "$ESSAI" = 1 ]; then
  info "[essai] node scripts/verifier-base.js --base $BASE"
else
  node scripts/verifier-base.js --base "$BASE" || echec "le contrôle a relevé des écarts"
fi

# ---------------------------------------------------------------------
cat <<FIN

$( [ "$ESSAI" = 1 ] && echo "Essai terminé : rien n'a été écrit." || echo "Préalables terminés." )

Il reste, dans l'ordre :

  1. Importer les workflows dans n8n
       n8n → Settings → API → Create an API key
       export N8N_URL=https://ton-n8n.fr N8N_API_KEY=...
       node scripts/importer-workflows.js

  2. Rattacher les identifiants dans n8n
       Postgres, Twilio, Telegram, Google Agenda, Gmail, SMTP

  3. Renseigner le node « Paramètres » dans les douze workflows

  4. Coller l'URL du webhook de WF-2 bis dans Twilio

  5. Les essais à blanc, puis l'activation
       docs/INSTALLATION.md, étapes 10 et 11

  Ne pas activer WF-2 ter avant d'être en confiance : tant qu'il dort,
  tout s'accumule dans file_sms et aucun SMS ne part.

FIN
