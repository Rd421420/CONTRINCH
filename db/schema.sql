-- =====================================================================
--  Pré-étude de solvabilité et prise de rendez-vous
--  Schéma PostgreSQL — à créer dans le cluster existant du VPS
--
--  Aucune donnée ne sort du serveur : le seul sous-traitant restant
--  est Twilio, pour l'acheminement des SMS.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS locatif;
SET search_path TO locatif, public;


-- ---------------------------------------------------------------------
--  Jours fériés — alimentée une fois par an depuis l'API Etalab
--  https://calendrier.api.gouv.fr/jours-feries/metropole.json
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jours_feries (
    jour        DATE PRIMARY KEY,
    libelle     TEXT NOT NULL
);


-- ---------------------------------------------------------------------
--  Lots — uniquement les biens disponibles, pas tout le portefeuille.
--  Alimentée par commande Telegram /lot et /loue.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lots (
    reference        TEXT PRIMARY KEY,
    commune          TEXT NOT NULL,
    code_postal      TEXT,
    adresse          TEXT,
    type_lot         TEXT,                       -- T1, T2, T3...
    loyer_cc         NUMERIC(8,2) NOT NULL,
    proprietaire     TEXT,
    tel_proprietaire TEXT,
    accepte_visale   BOOLEAN NOT NULL DEFAULT FALSE,
    zone_visale      SMALLINT,                   -- 1, 2 ou 3 — relevé une fois par commune
    latitude         DOUBLE PRECISION,
    longitude        DOUBLE PRECISION,
    statut           TEXT NOT NULL DEFAULT 'disponible',
    cree_le          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT lots_statut_chk CHECK (statut IN ('disponible', 'loue')),
    CONSTRAINT lots_zone_chk   CHECK (zone_visale IS NULL OR zone_visale BETWEEN 1 AND 3)
);

CREATE INDEX IF NOT EXISTS lots_dispo_idx ON lots (statut, loyer_cc);


-- ---------------------------------------------------------------------
--  Candidats — durée de vie courte, purge quotidienne
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS candidats (
    id                      BIGSERIAL PRIMARY KEY,
    cree_le                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    source                  TEXT,                    -- seloger, leboncoin, formulaire, autre
    nom                     TEXT,
    mobile                  TEXT,
    email                   TEXT,
    ref_lot                 TEXT REFERENCES lots (reference),

    -- déclaratif collecté par SMS
    situation               TEXT,
    duree_contrat_mois      SMALLINT,
    revenus_nets            NUMERIC(10,2),
    revenus_complementaires NUMERIC(10,2) DEFAULT 0,
    aide_logement           NUMERIC(10,2) DEFAULT 0,
    couple                  BOOLEAN,
    garantie                TEXT,                    -- caution, visale, aucune, autre, conseiller
    nb_cautions             SMALLINT,
    revenus_cautions        NUMERIC(10,2)[],
    visale_visa_obtenu      BOOLEAN,
    visale_montant_visa     NUMERIC(8,2),

    -- état de la séquence
    etape_sms               SMALLINT NOT NULL DEFAULT 0,
    dernier_envoi           TIMESTAMPTZ,
    nb_relances             SMALLINT NOT NULL DEFAULT 0,
    echecs_parsing          SMALLINT NOT NULL DEFAULT 0,

    -- résultat
    verdict                 TEXT,
    motif                   TEXT,                    -- interne, jamais envoyé au candidat
    capacite_loyer          NUMERIC(8,2),
    rdv_event_id            TEXT,
    statut                  TEXT NOT NULL DEFAULT 'nouveau',
    purge_le                TIMESTAMPTZ,

    CONSTRAINT candidats_statut_chk CHECK (statut IN
        ('nouveau', 'en_cours', 'rdv_pose', 'arbitrage', 'abandon', 'retenu'))
);

CREATE INDEX IF NOT EXISTS candidats_mobile_idx ON candidats (mobile);
CREATE INDEX IF NOT EXISTS candidats_statut_idx ON candidats (statut, cree_le);
CREATE INDEX IF NOT EXISTS candidats_purge_idx  ON candidats (purge_le)
    WHERE purge_le IS NOT NULL;


-- ---------------------------------------------------------------------
--  Blocages provisoires de créneaux — 2 heures ouvrées
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creneaux_reserves (
    id              BIGSERIAL PRIMARY KEY,
    candidat_id     BIGINT NOT NULL REFERENCES candidats (id) ON DELETE CASCADE,
    ref_lot         TEXT REFERENCES lots (reference),
    debut           TIMESTAMPTZ NOT NULL,
    fin             TIMESTAMPTZ NOT NULL,
    reserve_jusqu_a TIMESTAMPTZ NOT NULL,
    confirme        BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS creneaux_actifs_idx
    ON creneaux_reserves (debut, reserve_jusqu_a)
    WHERE confirme = FALSE;


-- ---------------------------------------------------------------------
--  Journal des dossiers écartés — anonyme, donc jamais purgé.
--  Sert à mesurer ce que le système fait perdre.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refus_log (
    id              BIGSERIAL PRIMARY KEY,
    horodatage      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ref_lot         TEXT,
    commune         TEXT,
    loyer_cc        NUMERIC(8,2),
    type_lot        TEXT,
    situation       TEXT,
    garantie        TEXT,
    verdict         TEXT,
    motif           TEXT,
    ecart_seuil     NUMERIC(10,2)
);

CREATE INDEX IF NOT EXISTS refus_log_date_idx ON refus_log (horodatage);


-- ---------------------------------------------------------------------
--  Preuve d'exécution de la purge
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purge_log (
    id            BIGSERIAL PRIMARY KEY,
    horodatage    TIMESTAMPTZ NOT NULL DEFAULT now(),
    lignes_purgees INTEGER NOT NULL
);


-- ---------------------------------------------------------------------
--  Purge quotidienne
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purger_candidats() RETURNS INTEGER AS $$
DECLARE
    supprimees INTEGER;
BEGIN
    DELETE FROM locatif.candidats
    WHERE purge_le IS NOT NULL
      AND purge_le < now()
      AND statut <> 'retenu';

    GET DIAGNOSTICS supprimees = ROW_COUNT;

    INSERT INTO locatif.purge_log (lignes_purgees) VALUES (supprimees);

    DELETE FROM locatif.creneaux_reserves
    WHERE confirme = FALSE AND reserve_jusqu_a < now() - INTERVAL '7 days';

    RETURN supprimees;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------
--  Planification
--
--  pg_cron demande shared_preload_libraries et un redémarrage du cluster.
--  Sur un VPS que tu administres, le cron système est plus simple et tout
--  aussi fiable. Ajouter dans la crontab :
--
--    0 3 * * *  psql -d era_loyers -c "SELECT locatif.purger_candidats();"
--
--  Vérification hebdomadaire :
--    SELECT * FROM locatif.purge_log ORDER BY horodatage DESC LIMIT 7;
-- ---------------------------------------------------------------------
