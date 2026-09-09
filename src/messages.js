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

/**
 * Lien vers la mention d'information, sous une URL de la marque — les
 * raccourcisseurs génériques passent mal les filtres opérateurs français.
 *
 * `process` n'existe pas dans le bac à sable des nodes Code de n8n : la
 * lecture est donc gardée, sinon le module ne se charge pas du tout une
 * fois empaqueté.
 */
const URL_MENTION =
  (typeof process !== 'undefined' && process.env && process.env.URL_MENTION_INFORMATION) ||
  'https://era-dupontromain.fr/donnees';

/**
 * Mention d'information, forme courte.
 *
 * Le §7 l'autorise explicitement : « Si la place manque dans le message, un
 * lien court vers une page dédiée du site suffit. » Elle nomme le
 * responsable de traitement et la finalité ; la durée de conservation et le
 * détail des droits sont sur la page liée.
 *
 * L'URL est celle de la marque, jamais un raccourcisseur générique — les
 * filtres opérateurs français traitent les deux très différemment.
 */
const MENTION_RGPD =
  `ERA Dupont Romain traite vos données pour l'étude de cette demande. Vos droits : ${URL_MENTION}`;

/**
 * Nombre de segments SMS facturés par Twilio.
 *
 * Un seul caractère hors alphabet GSM 03.38 fait basculer tout le message en
 * UCS-2 : la capacité tombe de 160 à 70 caractères, et de 153 à 67 dès qu'il
 * y a concaténation. Autrement dit, une apostrophe typographique ou un « € »
 * mal placé peut doubler la facture d'un message.
 */
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
  + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_ETENDU = '^{}\\[~]|€';

function segmentsSms(texte) {
  const caracteres = [...String(texte)];
  const gsm = caracteres.every((c) => GSM.includes(c) || GSM_ETENDU.includes(c));

  if (!gsm) {
    const n = caracteres.length;
    return n <= 70 ? 1 : Math.ceil(n / 67);
  }
  // Les caractères étendus comptent double en GSM-7.
  const longueur = caracteres.reduce((total, c) => total + (GSM_ETENDU.includes(c) ? 2 : 1), 0);
  return longueur <= 160 ? 1 : Math.ceil(longueur / 153);
}

function euros(montant) {
  return Number(montant).toLocaleString('fr-FR', { maximumFractionDigits: 0 });
}

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/** « jeudi 11 septembre à 14h30 » */
function libelleCreneau(creneau, temps) {
  const c = temps.champs(creneau.debut);
  const minutes = c.minutes ? `h${String(c.minutes).padStart(2, '0')}` : 'h';
  const jour = String(c.jour).padStart(2, '0');
  return `${JOURS[c.jourSemaine]} ${jour}/${String(c.mois).padStart(2, '0')} à ${c.heures}${minutes}`;
}

const messages = {
  /**
   * SMS 1 — ouverture, situation ET garantie dans un seul message.
   *
   * Les deux questions étaient séparées à l'origine. Les fusionner supprime
   * un aller-retour complet — un message sortant, une attente, une réponse
   * entrante — sans rien perdre : ce sont deux questions fermées, et l'ordre
   * voulu au §4 est respecté puisque le montant reste posé en dernier.
   *
   * Ce que la fusion économise n'est pas tant la longueur que le préambule
   * dupliqué : présentation, désignation du bien et mention d'information ne
   * partent plus qu'une fois.
   */
  sms1Ouverture({ lot }) {
    const designation = [lot.reference, lot.commune].filter(Boolean).join(' / ');
    return [
      `Assistant automatisé de l'agence ERA Dupont Romain, au sujet de votre demande de visite : ${designation}, ${euros(lot.loyer_cc)} € charges comprises.`,
      '',
      'Deux questions, répondez avec 2 chiffres (ex. 1 3).',
      '',
      'Situation :',
      '1 CDI ou fonctionnaire',
      '2 CDD ou intérim',
      '3 Indépendant, profession libérale',
      '4 Retraité',
      '5 Étudiant ou apprenti',
      '6 Autre',
      '',
      'Garantie :',
      '1 Une ou plusieurs cautions',
      '2 Visale',
      '3 Aucune',
      '4 Autre (bancaire, garant payant, employeur)',
      '',
      'CONSEILLER à tout moment pour être rappelé.',
      MENTION_RGPD,
    ].join('\n');
  },

  /** Un seul chiffre reçu : on ne repose que la question qui manque. */
  sms1bisGarantieSeule() {
    return [
      'Merci. Il me manque la garantie. Répondez par un chiffre :',
      '1 Une ou plusieurs cautions',
      '2 Visale (Action Logement)',
      '3 Aucune',
      '4 Autre (caution bancaire, garant payant, employeur)',
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

  /**
   * Mot d'attente, envoyé au candidat dont le dossier traîne en arbitrage.
   *
   * Même contrainte que le SMS 4b, et elle est structurelle : ce message
   * n'annonce rien, ne sous-entend rien, ne laisse rien espérer. Il dit
   * seulement que le dossier est vivant. Un candidat qui n'a aucune nouvelle
   * pendant une semaine rappelle l'agence — c'est précisément le temps que
   * le dispositif doit faire gagner.
   */
  attenteArbitrage() {
    return "Bonjour, votre demande est toujours entre les mains d'un conseiller. Nous revenons vers vous dès que possible. Merci de votre patience.";
  },

  /** Réponse incomprise : une seule reformulation, puis bascule Telegram. */
  incompris() {
    return "Désolé, je n'ai pas compris votre réponse. Pouvez-vous la reformuler ? Répondez CONSEILLER pour être rappelé par un humain.";
  },
};

module.exports = { ...messages, libelleCreneau, segmentsSms, MENTION_RGPD, URL_MENTION, euros };
