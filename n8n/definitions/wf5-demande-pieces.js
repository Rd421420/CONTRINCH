/**
 * WF-5 · Demande de pièces après visite.
 *
 * Déclenché par toi, quand tu retiens un candidat — jamais automatiquement.
 * Le gain réel du workflow n'est pas l'envoi : c'est la liste exacte des
 * justificatifs correspondant à la situation déclarée, tirée de la liste
 * limitative du décret du 5 novembre 2015. Ni plus, ni moins.
 *
 * Les pièces arrivent sur une boîte dédiée, pas sur la boîte générale.
 */

const { fabrique, noeudParametres } = require('../lib');

const DOSSIER = `SELECT row_to_json(c) AS candidat,
       row_to_json(l) AS lot
FROM locatif.candidats c
JOIN locatif.lots l ON l.reference = c.ref_lot
WHERE c.id = $1::bigint;`;

const COMPOSER = `const parametres = $('Paramètres').first().json;

return $input.all()
  .filter((item) => item.json.candidat && item.json.candidat.email)
  .map((item) => {
    const { candidat, lot } = item.json;
    return {
      json: {
        candidat_id: candidat.id,
        expediteur: parametres.mail_pieces,
        destinataire: candidat.email,
        sujet: \`Votre dossier de location — bien \${lot.reference} (\${lot.commune})\`,
        corps: ERA.justificatifs.mailDemandePieces({ candidat, lot }),
        // Sert à la relance : c'est la liste attendue, nommée pièce par pièce.
        pieces_attendues: ERA.justificatifs.piecesAPlat(candidat),
      },
    };
  });`;

const MARQUER = `UPDATE locatif.candidats
SET statut              = 'retenu',
    pieces_demandees_le = now(),
    -- Le dossier bascule dans SPI à la signature : la purge ne l'emporte
    -- plus tant qu'il est retenu.
    purge_le            = NULL
WHERE id = $1::bigint;`;

module.exports = {
  fichier: 'wf5-demande-pieces.json',
  description:
    'Envoie au candidat retenu la liste exacte des justificatifs correspondant à sa situation.',

  construire(socle) {
    const f = fabrique('ERA · WF-5 · Demande de pièces');

    f.manuel('Lancer à la main', [-480, 200]);
    f.code(
      'Candidat retenu',
      [-260, 200],
      "// Identifiant de la fiche à traiter, repris du récapitulatif Telegram.\nreturn [{ json: { candidat_id: 1 } }];",
    );
    f.sousWorkflow('Appel depuis Telegram', [-260, 420], ['candidat_id']);
    noeudParametres(f, [-40, 300]);
    f.requete('Charger le dossier', [180, 300], DOSSIER, {
      remplacements: '={{ $json.candidat_id }}',
    });
    f.code('Composer la demande', [400, 300], COMPOSER, { socle });
    f.mail('Envoyer sur la boîte pièces', [620, 300]);
    f.requete('Marquer le dossier retenu', [840, 300], MARQUER, {
      remplacements: "={{ $('Composer la demande').item.json.candidat_id }}",
    });

    f.relier('Lancer à la main', 'Candidat retenu');
    f.relier('Candidat retenu', 'Paramètres');
    f.relier('Appel depuis Telegram', 'Paramètres');
    f.chaine(
      'Paramètres',
      'Charger le dossier',
      'Composer la demande',
      'Envoyer sur la boîte pièces',
      'Marquer le dossier retenu',
    );

    return f.construire({ description: module.exports.description });
  },
};
