-- =====================================================================
--  Suivi des dossiers en attente d'arbitrage
--
--  Le §6 pose la fragilité sans la résoudre : « destinataire unique veut
--  dire que le système s'arrête quand tu es absent. Une semaine de congés,
--  ce sont dix arbitrages en attente et des candidats sans réponse. »
--
--  Jusqu'ici un dossier passait en `arbitrage`, partait dans le
--  récapitulatif de 18 h, `notifie_le` était posé — et plus rien ne le
--  faisait jamais remonter. Ces trois colonnes suffisent à le rattraper.
-- =====================================================================

SET search_path TO locatif, public;

ALTER TABLE candidats
    --  Entrée en file d'arbitrage. Distinct de `notifie_le`, qui date le
    --  premier récapitulatif : c'est l'attente du candidat qui compte, pas
    --  le moment où le message est parti.
    ADD COLUMN IF NOT EXISTS arbitrage_depuis   TIMESTAMPTZ,

    --  Clôture. Renseigné par la commande Telegram /traite. Tant qu'il est
    --  NULL, le dossier revient chaque matin. C'est la seule chose qui
    --  arrête la relance — et c'est voulu : un dossier qu'on oublie de
    --  clore doit rester bruyant.
    ADD COLUMN IF NOT EXISTS arbitre_le         TIMESTAMPTZ,

    --  Mots d'attente déjà envoyés au candidat. Plafonné à 1.
    ADD COLUMN IF NOT EXISTS relances_arbitrage SMALLINT NOT NULL DEFAULT 0;

--  L'index ne porte que sur ce que le workflow lit : les dossiers ouverts.
CREATE INDEX IF NOT EXISTS candidats_arbitrage_ouvert_idx
    ON candidats (arbitrage_depuis)
    WHERE statut = 'arbitrage' AND arbitre_le IS NULL;

--  Reprise des fiches déjà en base au moment de la migration.
UPDATE candidats
SET arbitrage_depuis = COALESCE(arbitrage_depuis, notifie_le, cree_le)
WHERE statut = 'arbitrage' AND arbitrage_depuis IS NULL;


-- ---------------------------------------------------------------------
--  Absences
--
--  Pendant une absence déclarée, deux choses changent : les rappels
--  partent vers le suppléant s'il y en a un, et le délai avant le mot
--  d'attente au candidat se resserre — c'est justement quand personne
--  n'arbitre qu'il ne faut pas laisser un candidat sans nouvelles.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS absences (
    id                BIGSERIAL PRIMARY KEY,
    debut             DATE NOT NULL,
    fin               DATE NOT NULL,
    chat_id_suppleant TEXT,
    cree_le           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT absences_periode_chk CHECK (fin >= debut)
);

CREATE INDEX IF NOT EXISTS absences_periode_idx ON absences (debut, fin);
