-- =====================================================================
--  File d'attente des SMS sortants
--
--  Le cahier des charges (§6, WF-2) prévoit « une file d'attente dans n8n
--  pour les demandes arrivées hors plage ». Elle est ici en base, pour la
--  même raison qui a fait sortir la purge de n8n : une file qui ne vit que
--  dans une exécution en attente disparaît au premier redémarrage, et
--  personne ne s'en aperçoit avant qu'un candidat se plaigne.
--
--  En base, elle est inspectable, rejouable, et la règle des heures
--  ouvrées ne s'applique qu'à un seul endroit : le workflow d'émission.
-- =====================================================================

SET search_path TO locatif, public;

CREATE TABLE IF NOT EXISTS file_sms (
    id            BIGSERIAL PRIMARY KEY,
    candidat_id   BIGINT REFERENCES candidats (id) ON DELETE CASCADE,
    mobile        TEXT NOT NULL,
    texte         TEXT NOT NULL,
    type_message  TEXT,                    -- sms1, sms2, sms4a, relance…
    cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
    envoyer_apres TIMESTAMPTZ NOT NULL DEFAULT now(),
    envoye_le     TIMESTAMPTZ,
    tentatives    SMALLINT NOT NULL DEFAULT 0,
    erreur        TEXT,
    sid_twilio    TEXT
);

-- Le workflow d'émission ne lit que cet index : les messages dus, non envoyés.
CREATE INDEX IF NOT EXISTS file_sms_a_envoyer_idx
    ON file_sms (envoyer_apres)
    WHERE envoye_le IS NULL;

CREATE INDEX IF NOT EXISTS file_sms_candidat_idx ON file_sms (candidat_id);


-- ---------------------------------------------------------------------
--  Purge : les messages envoyés suivent la fiche candidat (ON DELETE
--  CASCADE). Restent les messages orphelins, sans candidat, qu'on garde
--  30 jours pour le débogage.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purger_file_sms() RETURNS INTEGER AS $$
DECLARE
    supprimees INTEGER;
BEGIN
    DELETE FROM locatif.file_sms
    WHERE candidat_id IS NULL
      AND cree_le < now() - INTERVAL '30 days';
    GET DIAGNOSTICS supprimees = ROW_COUNT;
    RETURN supprimees;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------
--  Deux colonnes manquantes au schéma initial
-- ---------------------------------------------------------------------

--  Rang de la proposition : A ou B. Sans lui, la réponse « B » du candidat
--  ne peut être rattachée qu'en supposant que l'ordre d'insertion a été
--  conservé — une hypothèse qu'il vaut mieux ne pas prendre.
ALTER TABLE creneaux_reserves
    ADD COLUMN IF NOT EXISTS rang SMALLINT;

--  Marque le passage dans un récapitulatif Telegram. La file différée du
--  §6 (WF-5 bis) part en un seul message à 18 h : sans cette colonne, un
--  dossier non traité serait renvoyé tous les soirs.
ALTER TABLE candidats
    ADD COLUMN IF NOT EXISTS notifie_le TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS candidats_a_notifier_idx
    ON candidats (statut)
    WHERE notifie_le IS NULL;

--  Suivi de la demande de pièces (WF-5). La date de réception reste
--  saisie à la main tant que la boîte dédiée n'existe pas : détecter
--  automatiquement l'arrivée des pièces suppose de lire cette boîte.
ALTER TABLE candidats
    ADD COLUMN IF NOT EXISTS pieces_demandees_le TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pieces_recues_le    TIMESTAMPTZ;
