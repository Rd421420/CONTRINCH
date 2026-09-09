/**
 * Script des SMS (§4).
 *
 * Ordre voulu : les questions fermées d'abord, le montant en dernier, quand
 * le candidat est déjà engagé dans l'échange — c'est aussi la seule question
 * qui demande de l'interprétation.
 *
 * Aucun de ces messages n'annonce ni ne sous-entend un refus. C'est le choix
 * d'architecture central du dispositif : le système transmet, il ne tranche
 * pas. Le jour où l'un de ces textes dirait « votre dossier ne correspond
 * pas », l'article 22 du RGPD redeviendrait applicable (§7).
 */

/** Lien vers la mention d'information, sous une URL de la marque. */
const URL_MENTION = process.env.URL_MENTION_INFORMATION || 'https://era-dupontromain.fr/donnees';

const MENTION_RGPD =
  `Vos données servent uniquement à l'étude de votre demande (ERA Dupont Romain, ` +
  `responsable de traitement), sont conservées 30 jours et vous disposez d'un droit ` +
  `d'accès et de rectification : ${URL_MENTION}`;

function euros(montant) {
  return Number(montant).toLocaleString('fr-FR', { maximumFractionDigits: 0 });
}

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/** « jeudi 11 septembre à 14h30 » */
function libelleCreneau(creneau, temps) {
  const c = temps.champs(creneau.debut);
  const minutes = c.minutes ? `h${String(c.minutes).padStart(2, '0')}` : 'h';
  return `${JOURS[c.jourSemaine]} ${c.jour}/${String(c.mois).padStart(2, '0')} à ${c.heures}${minutes}`;
}

const messages = {
  /** SMS 1 — ouverture + situation professionnelle. */
  sms1Ouverture({ lot }) {
    const designation = [lot.reference, lot.commune].filter(Boolean).join(' / ');
    return [
      `Bonjour, ici l'assistant automatisé de l'agence ERA Dupont Romain, au sujet de votre demande de visite pour le ${designation} à ${euros(lot.loyer_cc)} € charges comprises.`,
      '',
      'Quelques questions rapides pour préparer votre dossier.',
      '',
      'Votre situation ? Répondez par un chiffre :',
      '1 — CDI ou fonctionnaire',
      '2 — CDD ou intérim',
      '3 — Indépendant ou profession libérale',
      '4 — Retraité',
      '5 — Étudiant ou apprenti',
      '6 — Autre',
      '',
      'Répondez CONSEILLER à tout moment pour être rappelé par un humain.',
      '',
      MENTION_RGPD,
    ].join('\n');
  },

  /** Intercalaire après « 2 » : le CDD ≤ 12 mois n'est pas assurable. */
  sms1bisDureeContrat() {
    return 'Votre contrat court sur plus de 12 mois ? OUI / NON';
  },

  /** SMS 2 — garantie. Quatre branches exclusives, pas une case à cocher. */
  sms2Garantie() {
    return [
      'Merci. Quelle garantie pouvez-vous présenter ?',
      '1 — Une ou plusieurs personnes qui se portent caution',
      '2 — La garantie Visale (Action Logement)',
      '3 — Aucune garantie',
      '4 — Autre (caution bancaire, garant payant, employeur)',
    ].join('\n');
  },

  /** Le nombre de cautions doit être demandé avant les montants : le seuil en dépend. */
  sms2bisNombreCautions() {
    return 'Combien de personnes se portent caution ? Répondez par un chiffre.';
  },

  sms2terRevenusCautions({ nb }) {
    return nb > 1
      ? `Quels sont les revenus mensuels nets de chacune de ces ${nb} personnes ? Séparez les montants par « et ».`
      : 'Quels sont les revenus mensuels nets de cette personne ?';
  },

  sms2quaterVisaObtenu() {
    return 'Avez-vous déjà votre visa Visale ? OUI / NON';
  },

  sms2quinquiesMontantVisa() {
    return 'Quel montant de loyer maximum figure sur votre visa Visale ?';
  },

  /**
   * SMS 3 — revenus principaux.
   *
   * La précision « net à payer avant impôt » n'est pas cosmétique : sans
   * elle, un dossier réellement à 2 000 € se présente à 1 850 € et se fait
   * refuser à tort. Première cause de faux négatif du système.
   */
  sms3Revenus() {
    return [
      'Quels sont les revenus mensuels du foyer, en net à payer avant impôt — le montant en bas du bulletin de salaire, pas la somme virée sur le compte ?',
      '',
      'Indiquez le total si vous êtes plusieurs à signer le bail.',
    ].join('\n');
  },

  /** SMS 3 bis — revenus complémentaires, pondérés à 25 %. */
  sms3bisComplementaires() {
    return [
      'Percevez-vous l’un de ces revenus ? Indiquez le total mensuel, ou 0 :',
      'aide au logement (APL/AL), allocations familiales, pension alimentaire, revenus fonciers, 13ᵉ mois, heures supplémentaires, pension d’invalidité.',
    ].join('\n');
  },

  /** SMS 3 ter — posé uniquement aux retraités et personnes handicapées. */
  sms3terFoyer() {
    return 'Vivez-vous seul ou en couple ?';
  },

  /**
   * SMS 4a — situation compatible.
   * « semble compatible », pas « correspond » : rien n'a été vérifié.
   * Aucune mention de l'assurance loyers impayés : le candidat n'a pas à
   * connaître le montage de garantie choisi par le propriétaire.
   */
  sms4aCreneaux({ creneaux, temps, sousReserveVisale = false }) {
    const entete = sousReserveVisale
      ? "Merci. D'après vos éléments, votre situation semble compatible avec ce logement, sous réserve de l'obtention de votre visa auprès d'Action Logement et de l'étude de votre dossier sur pièces."
      : "Merci. D'après les éléments que vous nous avez indiqués, votre situation semble compatible avec ce logement. Il s'agit d'une première approche déclarative : votre dossier sera étudié sur pièces après la visite.";

    return [
      entete,
      '',
      'Deux créneaux de visite possibles :',
      `A — ${libelleCreneau(creneaux[0], temps)}`,
      `B — ${libelleCreneau(creneaux[1], temps)}`,
      '',
      'Répondez A ou B. Si aucun ne convient, répondez AUTRE.',
    ].join('\n');
  },

  /**
   * SMS 4b — demande transmise.
   * Envoyé pour TOUS les verdicts non favorables. Le candidat n'apprend
   * rien sur son dossier, et pour cause : rien n'a été décidé.
   */
  sms4bTransmis() {
    return 'Merci pour ces éléments. Votre demande est transmise à un conseiller, qui revient vers vous rapidement.';
  },

  /** SMS 5 — confirmation. */
  sms5Confirmation({ lot, creneau, temps }) {
    return `C'est noté : visite du ${lot.adresse || lot.commune} le ${libelleCreneau(creneau, temps)}. Vous recevrez un rappel la veille. À bientôt.`;
  },

  /** Créneau pris entre-temps : ne jamais renvoyer d'échec au candidat. */
  creneauPris({ creneaux, temps }) {
    return [
      'Ce créneau vient d’être pris, voici deux autres possibilités :',
      `A — ${libelleCreneau(creneaux[0], temps)}`,
      `B — ${libelleCreneau(creneaux[1], temps)}`,
      '',
      'Répondez A ou B. Si aucun ne convient, répondez AUTRE.',
    ].join('\n');
  },

  /** Relance unique après expiration du blocage de 2 heures ouvrées. */
  relanceCreneaux({ creneaux, temps }) {
    return [
      'Sans nouvelle de votre part, voici deux nouveaux créneaux :',
      `A — ${libelleCreneau(creneaux[0], temps)}`,
      `B — ${libelleCreneau(creneaux[1], temps)}`,
      '',
      'Répondez A ou B. Si aucun ne convient, répondez AUTRE.',
    ].join('\n');
  },

  /** Réponse incomprise : une seule reformulation, puis bascule Telegram. */
  incompris() {
    return "Désolé, je n'ai pas compris votre réponse. Pouvez-vous la reformuler ? Répondez CONSEILLER pour être rappelé par un humain.";
  },
};

module.exports = { ...messages, libelleCreneau, MENTION_RGPD, URL_MENTION, euros };
