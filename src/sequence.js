/**
 * WF-2 · Machine à états de la séquence SMS.
 *
 * Fonction pure : on lui passe la fiche candidat telle qu'elle est en base
 * et le texte reçu, elle renvoie le patch à écrire, les messages à envoyer
 * et l'éventuelle sortie vers Telegram. Aucun appel réseau, aucune écriture
 * — c'est ce qui permet de rejouer une conversation entière en test.
 *
 * Le champ `etape_sms` de la table `candidats` porte l'état. Le schéma le
 * commentait « 1 à 5 » : la séquence réelle compte plus d'étapes, à cause
 * des questions intercalaires (durée de contrat, nombre de cautions,
 * montant du visa). Le type SMALLINT couvre largement.
 */

const { ECHECS_PARSING_MAX } = require('./config');
const P = require('./parsing');
const M = require('./messages');
const T = require('./temps');
const { evaluer } = require('./eligibilite');

const ETAPE = {
  NOUVEAU: 0,
  SITUATION: 1,
  DUREE_CONTRAT: 2,
  GARANTIE: 3,
  NB_CAUTIONS: 4,
  REVENUS_CAUTIONS: 5,
  VISA_OBTENU: 6,
  VISA_MONTANT: 7,
  REVENUS: 8,
  COMPLEMENTAIRES: 9,
  COUPLE: 10,
  CRENEAU: 11,
  TERMINE: 12,
};

const SITUATIONS = { 1: 'cdi', 2: 'cdd', 3: 'independant', 4: 'retraite', 5: 'etudiant', 6: 'autre' };
const GARANTIES = { 1: 'caution', 2: 'visale', 3: 'aucune', 4: 'autre' };

/**
 * Les créneaux proposés reviennent de la base en chaînes ISO, alors que
 * ceux que le module de créneaux vient de calculer sont des `Date`. Tout
 * ce qui sort d'ici doit être des `Date` : le message de confirmation et
 * l'écriture dans l'agenda en dépendent.
 */
function versInstant(valeur) {
  return valeur instanceof Date ? valeur : T.depuisIso(String(valeur));
}

function normaliserCreneau(creneau) {
  if (!creneau) return null;
  return { ...creneau, debut: versInstant(creneau.debut), fin: versInstant(creneau.fin) };
}

/** Ce que le calculateur d'éligibilité attend, à partir de la fiche et du lot. */
function versEntreeEligibilite(candidat, lot) {
  return {
    loyer_cc: lot.loyer_cc,
    logement_type: lot.type_lot,
    zone_visale: lot.zone_visale,
    lot_accepte_visale: lot.accepte_visale,

    situation: candidat.situation,
    duree_contrat_mois: candidat.duree_contrat_mois,
    revenus_nets: candidat.revenus_nets,
    revenus_complementaires: candidat.revenus_complementaires,
    aide_logement: candidat.aide_logement,
    couple: candidat.couple,
    handicap: candidat.handicap,
    age: candidat.age,

    garantie: candidat.garantie,
    garant: candidat.garantie === 'caution',
    cautions: candidat.revenus_cautions || [],
    visale_visa_obtenu: candidat.visale_visa_obtenu,
    visale_montant_visa: candidat.visale_montant_visa,

    preavis: candidat.preavis,
    saisie_sur_salaire: candidat.saisie_sur_salaire,
  };
}

function reponse(patch = {}, envois = [], sortie = null) {
  return { patch, envois: [].concat(envois).filter(Boolean), sortie };
}

function envoi(texte, type) {
  return { texte, type };
}

/** Bascule Telegram : le système ne prononce aucun refus, il transmet. */
function versArbitrage(motif, { file = 'differee', patch = {} } = {}) {
  return reponse(
    { ...patch, statut: 'arbitrage', etape_sms: ETAPE.TERMINE },
    envoi(M.sms4bTransmis(), 'sms4b'),
    { file, motif },
  );
}

/** Premier message : présentation et question de situation. */
function demarrer({ lot }) {
  return reponse(
    { etape_sms: ETAPE.SITUATION, statut: 'en_cours', echecs_parsing: 0 },
    envoi(M.sms1Ouverture({ lot }), 'sms1'),
  );
}

/**
 * Traite une réponse entrante.
 *
 * Les réponses sont enregistrées à toute heure, y compris à 22 h — c'est
 * seulement l'émission qui attend la plage 9 h–19 h (§5). La mise en file
 * est du ressort de l'appelant, via calendrier.prochaineOuverture().
 */
function traiterReponse(candidat, texte, contexte = {}) {
  const { lot, temps = T } = contexte;

  if (P.demandeDesinscription(texte)) {
    return reponse({ statut: 'abandon', etape_sms: ETAPE.TERMINE, motif: 'Désinscription STOP' }, []);
  }

  // CONSEILLER est disponible à tout moment, y compris comme réponse à
  // n'importe quelle question. Aucun calcul n'est effectué.
  if (P.demandeConseiller(texte)) {
    return reponse(
      { statut: 'arbitrage', etape_sms: ETAPE.TERMINE, verdict: 'a_qualifier', motif: 'Le candidat demande à parler à un conseiller' },
      envoi(M.sms4bTransmis(), 'sms4b'),
      { file: 'immediate', motif: 'demande_rappel' },
    );
  }

  const etape = Number(candidat.etape_sms) || 0;
  const suite = ETAPES[etape];
  if (!suite) {
    return versArbitrage('etape_inconnue', { patch: { verdict: 'a_qualifier' } });
  }

  const resultat = suite(candidat, texte, { ...contexte, temps });
  if (resultat) return resultat;

  return echecParsing(candidat, texte);
}

/**
 * Filet de sécurité : deux réponses incompréhensibles d'affilée sur la même
 * question → bascule Telegram, fin de séquence. Pas de troisième tentative.
 */
function echecParsing(candidat) {
  const echecs = (Number(candidat.echecs_parsing) || 0) + 1;
  if (echecs >= ECHECS_PARSING_MAX) {
    return versArbitrage('reponses_incomprises', {
      patch: { echecs_parsing: echecs, verdict: 'donnees_incompletes' },
    });
  }
  return reponse({ echecs_parsing: echecs }, envoi(M.incompris(), 'incompris'));
}

/** Passe à la question suivante, en repartant d'un compteur d'échecs neuf. */
function avancer(etape, message, type, patch = {}) {
  return reponse({ ...patch, etape_sms: etape, echecs_parsing: 0 }, envoi(message, type));
}

/** Aiguillage après la question de garantie. */
function apresGarantie(garantie, patch) {
  switch (garantie) {
    case 'caution':
      return avancer(ETAPE.NB_CAUTIONS, M.sms2bisNombreCautions(), 'sms2bis', patch);
    case 'visale':
      return avancer(ETAPE.VISA_OBTENU, M.sms2quaterVisaObtenu(), 'sms2quater', patch);
    case 'aucune':
      return avancer(ETAPE.REVENUS, M.sms3Revenus(), 'sms3', patch);
    default:
      // Caution bancaire, garant payant, employeur : aucune règle
      // automatisable, ces montages se jugent au cas par cas.
      return versArbitrage('garantie_hors_grille', {
        patch: { ...patch, verdict: 'a_qualifier', motif: 'Garantie déclarée hors grille — arbitrage humain' },
      });
  }
}

/**
 * Fin du questionnaire : calcul déterministe, puis proposition de créneaux
 * ou transmission au conseiller. Aucun refus n'est prononcé ici.
 */
function conclure(candidat, contexte) {
  const { lot, temps = T } = contexte;
  const fiche = { ...candidat, ...contexte.patchEnCours };
  const resultat = evaluer(versEntreeEligibilite(fiche, lot));

  // La dernière réponse reçue fait partie du patch : sans elle, le montant
  // des revenus complémentaires ou la composition du foyer servent au calcul
  // puis disparaissent, et la fiche en base ne permet plus de le rejouer.
  const patch = {
    ...contexte.patchEnCours,
    verdict: resultat.verdict,
    motif: resultat.motif,
    capacite_loyer: resultat.capacite_loyer ?? null,
  };

  const favorable = resultat.verdict === 'eligible' || resultat.verdict === 'a_verifier_visale';
  if (!favorable) {
    return {
      ...versArbitrage(resultat.verdict, { patch }),
      eligibilite: resultat,
    };
  }

  const creneaux = (contexte.proposerCreneaux ? contexte.proposerCreneaux(fiche, resultat) : []) || [];
  if (creneaux.length < 2) {
    // Aucun déplacement isolé : faute de créneau cohérent, le dossier part
    // en arbitrage plutôt que d'inventer une visite hors secteur.
    return {
      ...versArbitrage('aucun_creneau_disponible', { patch: { ...patch, statut: 'arbitrage' } }),
      eligibilite: resultat,
    };
  }

  return {
    ...reponse(
      { ...patch, etape_sms: ETAPE.CRENEAU, statut: 'en_cours', echecs_parsing: 0 },
      envoi(
        M.sms4aCreneaux({
          creneaux,
          temps,
          sousReserveVisale: resultat.verdict === 'a_verifier_visale',
        }),
        'sms4a',
      ),
    ),
    eligibilite: resultat,
    creneaux,
  };
}

/** Une fois la dernière question posée, faut-il encore demander le foyer ? */
function finQuestionnaire(candidat, patch, contexte) {
  const fiche = { ...candidat, ...patch };
  const concerne = fiche.situation === 'retraite' || fiche.handicap === true;
  if (concerne && fiche.couple === undefined) {
    return avancer(ETAPE.COUPLE, M.sms3terFoyer(), 'sms3ter', patch);
  }
  return conclure(candidat, { ...contexte, patchEnCours: patch });
}

const ETAPES = {
  [ETAPE.SITUATION](candidat, texte) {
    const choix = P.parseChoix(texte, 6);
    if (!choix) return null;
    const situation = SITUATIONS[choix];

    if (situation === 'cdd') {
      return avancer(ETAPE.DUREE_CONTRAT, M.sms1bisDureeContrat(), 'sms1bis', { situation });
    }
    return avancer(ETAPE.GARANTIE, M.sms2Garantie(), 'sms2', { situation });
  },

  [ETAPE.DUREE_CONTRAT](candidat, texte) {
    const plusDe12 = P.parseOuiNon(texte);
    if (plusDe12 === null) return null;

    // Exclusion sèche : un CDD de 12 mois ou moins n'est pas assurable, et
    // aucune réponse ultérieure ne peut le rattraper. On sort ici plutôt
    // que de poser quatre questions de plus — et de les facturer.
    if (!plusDe12) {
      return versArbitrage('cdd_non_assurable', {
        patch: {
          duree_contrat_mois: 12,
          verdict: 'non_assurable',
          motif: 'Contrat CDD ou intérim de 12 mois ou moins — durée supérieure à 12 mois exigée',
        },
      });
    }
    return avancer(ETAPE.GARANTIE, M.sms2Garantie(), 'sms2', { duree_contrat_mois: 24 });
  },

  [ETAPE.GARANTIE](candidat, texte) {
    const choix = P.parseChoix(texte, 4);
    if (!choix) return null;
    const garantie = GARANTIES[choix];
    return apresGarantie(garantie, { garantie });
  },

  [ETAPE.NB_CAUTIONS](candidat, texte) {
    const nb = P.parseEntier(texte, { min: 1, max: 4 });
    if (!nb) return null;
    return avancer(ETAPE.REVENUS_CAUTIONS, M.sms2terRevenusCautions({ nb }), 'sms2ter', { nb_cautions: nb });
  },

  [ETAPE.REVENUS_CAUTIONS](candidat, texte) {
    const attendus = Number(candidat.nb_cautions) || 1;
    const montants = P.parseMontants(texte, attendus);
    if (!montants) return null;
    return avancer(ETAPE.REVENUS, M.sms3Revenus(), 'sms3', { revenus_cautions: montants });
  },

  [ETAPE.VISA_OBTENU](candidat, texte) {
    const obtenu = P.parseOuiNon(texte);
    if (obtenu === null) return null;
    if (obtenu) {
      return avancer(ETAPE.VISA_MONTANT, M.sms2quinquiesMontantVisa(), 'sms2quinquies', {
        visale_visa_obtenu: true,
      });
    }
    return avancer(ETAPE.REVENUS, M.sms3Revenus(), 'sms3', { visale_visa_obtenu: false });
  },

  [ETAPE.VISA_MONTANT](candidat, texte) {
    const montant = P.parseMontant(texte);
    if (!montant) return null;
    return avancer(ETAPE.REVENUS, M.sms3Revenus(), 'sms3', { visale_montant_visa: montant });
  },

  [ETAPE.REVENUS](candidat, texte) {
    const montant = P.parseMontant(texte);
    if (montant === null) return null;
    return avancer(ETAPE.COMPLEMENTAIRES, M.sms3bisComplementaires(), 'sms3bis', {
      revenus_nets: montant,
    });
  },

  [ETAPE.COMPLEMENTAIRES](candidat, texte, contexte) {
    const montant = P.parseMontantOuZero(texte);
    if (montant === null) return null;
    return finQuestionnaire(candidat, { revenus_complementaires: montant }, contexte);
  },

  [ETAPE.COUPLE](candidat, texte, contexte) {
    const n = P.normaliser(texte);
    let couple = null;
    if (/\bcouple\b|\bdeux\b|\bmarie|\bconcubin|\bpacs/.test(n)) couple = true;
    else if (/\bseul\b|\bseule\b|\bun\b|\bcelibataire\b/.test(n)) couple = false;
    if (couple === null) return null;
    return finQuestionnaire(candidat, { couple }, contexte);
  },

  [ETAPE.CRENEAU](candidat, texte, contexte) {
    const choix = P.parseCreneau(texte);
    if (!choix) return null;

    if (choix === 'AUTRE') {
      return versArbitrage('creneaux_refuses', {
        patch: { verdict: candidat.verdict, motif: 'Aucun des créneaux proposés ne convient' },
      });
    }

    const creneau = normaliserCreneau((contexte.creneauxProposes || [])[choix === 'A' ? 0 : 1]);
    if (!creneau) return versArbitrage('creneau_introuvable');

    // Vérification systématique AVANT écriture : le blocage en base ne
    // connaît que les réservations du système, pas ce que tu poses toi-même
    // dans ImmoFacile.
    if (contexte.creneauEncoreLibre && !contexte.creneauEncoreLibre(creneau)) {
      const rechange = (contexte.reproposer ? contexte.reproposer() : []) || [];
      if (rechange.length < 2) return versArbitrage('collision_sans_rechange');
      return reponse(
        { etape_sms: ETAPE.CRENEAU, echecs_parsing: 0 },
        envoi(M.creneauPris({ creneaux: rechange, temps: contexte.temps || T }), 'creneau_pris'),
        null,
      );
    }

    return {
      ...reponse(
        { etape_sms: ETAPE.TERMINE, statut: 'rdv_pose' },
        envoi(M.sms5Confirmation({ lot: contexte.lot, creneau, temps: contexte.temps || T }), 'sms5'),
      ),
      creneauRetenu: creneau,
    };
  },
};

module.exports = { ETAPE, SITUATIONS, GARANTIES, demarrer, traiterReponse, versEntreeEligibilite };
