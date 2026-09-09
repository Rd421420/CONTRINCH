/**
 * WF-5 · Liste des pièces à demander, selon la situation déclarée.
 *
 * C'est le gain réel de ce workflow : produire la liste exacte, et elle
 * seule. La loi du 6 juillet 1989 et le décret du 5 novembre 2015 fixent
 * une liste limitative — demander une pièce hors liste est interdit, et
 * en demander trop fait revenir des dossiers incomplets.
 *
 * Aucune pièce n'est demandée au stade de la pré-étude : uniquement du
 * déclaratif. Ce module ne sert qu'aux candidats retenus après visite.
 */

const IDENTITE = "Pièce d'identité en cours de validité (recto-verso)";
const DOMICILE = 'Justificatif de domicile actuel : 3 dernières quittances de loyer, ou attestation d\'hébergement, ou avis de taxe foncière';
const AVIS_IMPOSITION = "Dernier ou avant-dernier avis d'imposition";

const PAR_SITUATION = {
  cdi: [
    IDENTITE,
    DOMICILE,
    "Contrat de travail ou attestation de l'employeur datant de moins de 3 mois",
    '3 derniers bulletins de salaire',
    AVIS_IMPOSITION,
  ],
  cdd: [
    IDENTITE,
    DOMICILE,
    'Contrat de travail mentionnant la date de fin',
    '3 derniers bulletins de salaire',
    AVIS_IMPOSITION,
  ],
  independant: [
    IDENTITE,
    DOMICILE,
    "Extrait K ou K bis de moins de 3 mois, ou attestation d'affiliation URSSAF",
    '2 derniers bilans ou attestation de votre comptable',
    AVIS_IMPOSITION,
  ],
  retraite: [
    IDENTITE,
    DOMICILE,
    'Titre de pension ou attestation de paiement de moins de 3 mois',
    AVIS_IMPOSITION,
  ],
  etudiant: [
    IDENTITE,
    'Carte étudiant ou certificat de scolarité pour l\'année en cours',
  ],
  autre: [IDENTITE, DOMICILE, AVIS_IMPOSITION],
};

/** Pièces exigées de chaque cautionnaire — un dossier complet par personne. */
const PAR_CAUTION = [
  IDENTITE,
  DOMICILE,
  "Justificatif d'activité professionnelle",
  '3 derniers bulletins de salaire',
  AVIS_IMPOSITION,
];

const PAR_REVENU_COMPLEMENTAIRE = {
  aide_logement: 'Attestation CAF ou MSA de moins de 3 mois',
  pension_alimentaire: 'Jugement ou justificatif de versement de la pension alimentaire',
  revenus_fonciers: "Avis d'imposition faisant apparaître les revenus fonciers",
};

/**
 * Construit la liste pour un dossier donné.
 * Renvoie des sections nommées : c'est ainsi que le mail se lit, et c'est
 * aussi ce qui permet à la relance de nommer les pièces manquantes une
 * par une.
 */
function listePieces(candidat) {
  const situation = PAR_SITUATION[candidat.situation] ? candidat.situation : 'autre';
  const sections = [{ titre: 'Votre dossier', pieces: [...PAR_SITUATION[situation]] }];

  if (Number(candidat.revenus_complementaires) > 0 || Number(candidat.aide_logement) > 0) {
    sections.push({
      titre: 'Vos revenus complémentaires',
      pieces: [PAR_REVENU_COMPLEMENTAIRE.aide_logement],
    });
  }

  if (candidat.garantie === 'caution') {
    const nb = Number(candidat.nb_cautions) || 1;
    for (let i = 1; i <= nb; i += 1) {
      sections.push({
        titre: nb > 1 ? `Cautionnaire ${i}` : 'Votre cautionnaire',
        pieces: [...PAR_CAUTION, 'Acte de cautionnement signé (fourni par nos soins)'],
      });
    }
  }

  if (candidat.garantie === 'visale') {
    sections.push({
      titre: 'Votre garantie Visale',
      pieces: ['Visa Visale certifié, faisant apparaître le numéro et le loyer maximum garanti'],
    });
  }

  return sections;
}

/** Version plate, pour cocher les pièces reçues et relancer sur le reste. */
function piecesAPlat(candidat) {
  return listePieces(candidat).flatMap((s) =>
    s.pieces.map((piece) => (s.titre === 'Votre dossier' ? piece : `${s.titre} — ${piece}`)),
  );
}

/** Corps du mail de demande de pièces. */
function mailDemandePieces({ candidat, lot }) {
  const sections = listePieces(candidat)
    .map((s) => [`${s.titre} :`, ...s.pieces.map((p) => `  • ${p}`)].join('\n'))
    .join('\n\n');

  return [
    `Bonjour ${candidat.nom || ''},`.trim(),
    '',
    `Suite à votre visite du bien ${lot.reference} (${lot.adresse || lot.commune}), nous vous remercions de nous transmettre les pièces suivantes :`,
    '',
    sections,
    '',
    'Merci de répondre directement à ce message en y joignant les documents.',
    'Aucune autre pièce ne vous sera demandée : cette liste est limitative.',
    '',
    'Cordialement,',
    'ERA Dupont Romain',
  ].join('\n');
}

module.exports = {
  listePieces,
  piecesAPlat,
  mailDemandePieces,
  PAR_SITUATION,
  PAR_CAUTION,
};
