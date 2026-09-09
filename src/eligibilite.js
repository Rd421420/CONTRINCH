/**
 * WF-3 · Calcul d'éligibilité — critères Certification Sésame (Mila)
 * Contrat ERA Dupont Romain — taux d'effort revenus stables : 37 %
 *
 * Taux d'effort = loyer CC / revenus nets mensuels avant impôts
 * Aucune IA, aucun appel externe. Déterministe et rejouable.
 */

const CONFIG = {
  TAUX_REVENUS_STABLES: 0.37,   // à confirmer avec Mila (fourchette contractuelle 35–40 %)
  TAUX_AUTRES_REVENUS: 0.25,    // CDD / intérim > 12 mois
  TAUX_COMPLEMENTAIRES: 0.25,   // aide au logement, AF, pension, foncier, 13e mois…
  TAUX_GARANT: 0.33,
  MULTIPLE_MIN_CAUTION: 2,      // pluralité uniquement : chaque caution >= 2 x loyer CC
  DUREE_CONTRAT_MIN_MOIS: 12,   // strictement supérieure à 12
  PLAFOND_LOYER_ASSURABLE: 5000,
  RESTE_A_VIVRE_SEUL: 550,
  RESTE_A_VIVRE_COUPLE: 900,
  TYPES_DEROGATION_RAV: ['T1', 'T2', 'T3'],

  // --- Visale (Action Logement) — règles au 6 janvier 2026 ---------------
  // ⚠ À vérifier sur visale.fr avant mise en production, et à revérifier
  // chaque janvier : Action Logement révise ces montants régulièrement.
  //
  // Pas de zonage : le portefeuille tient sur des communes d'un même
  // secteur, et relever une zone par commune pour un plafond qui n'est
  // jamais atteint coûte plus qu'il ne rapporte. Les deux montants ci-
  // dessous sont les plus restrictifs de la grille — ceux que le système
  // appliquait déjà par défaut faute de zone renseignée. Ce sont les deux
  // seules valeurs à changer si le besoin s'en fait sentir.
  VISALE: {
    PLAFOND_LOYER: 1365,
    FORFAIT_ETUDIANT: 680,
    TAUX_EFFORT_MAX: 0.50,
    AGE_FORFAIT_ETUDIANT_MAX: 30,
  },
};

const REVENUS_STABLES = [
  'cdi', 'fonctionnaire', 'militaire', 'retraite',
  'auto_entrepreneur', 'liberale', 'independant',
];

const AUTRES_REVENUS = ['cdd', 'interim'];
const AVEC_CAUTION = ['etudiant', 'apprenti'];

function arrondi(n) {
  return Math.round(n * 100) / 100;
}

function evaluer(d) {
  const loyer = Number(d.loyer_cc);

  // Revenus principaux : NET A PAYER AVANT IMPOT (bas du bulletin de salaire),
  // et non le montant viré sur le compte. L'écart avec le net après
  // prélèvement à la source va de 5 à 15 % : c'est la première cause de
  // refus à tort.
  const revenus = Number(d.revenus_nets) || 0;

  // Revenus complémentaires : aide au logement (AL/APL), allocations CAF,
  // pension alimentaire, revenus fonciers, 13e mois, heures supplémentaires.
  // Pondérés au taux d'effort de 25 %, distinct du taux principal.
  const complementaires =
    (Number(d.aide_logement) || 0) + (Number(d.revenus_complementaires) || 0);
  const revenusTotaux = revenus + complementaires;

  const out = {
    verdict: null,
    motif: null,
    base: null,
    taux_applique: null,
    seuil_revenus: null,
    taux_effort_calcule: revenus > 0 ? arrondi(loyer / revenus) : null,
  };

  // --- 1. Garde-fous ------------------------------------------------------
  if (!loyer || loyer <= 0) {
    return { ...out, verdict: 'donnees_incompletes', motif: 'Loyer CC absent' };
  }
  if (loyer > CONFIG.PLAFOND_LOYER_ASSURABLE) {
    return {
      ...out,
      verdict: 'non_assurable',
      motif: `Loyer CC de ${loyer} € supérieur au plafond assurable de ${CONFIG.PLAFOND_LOYER_ASSURABLE} €`,
    };
  }

  // --- 2. Exclusions sèches ----------------------------------------------
  if (d.preavis === true) {
    return {
      ...out,
      verdict: 'non_assurable',
      motif: 'Période de licenciement ou de préavis de démission',
    };
  }
  if (d.saisie_sur_salaire === true) {
    return {
      ...out,
      verdict: 'non_assurable',
      motif: 'Saisie sur salaire ou avis à tiers détenteur',
    };
  }
  // Un CDD dont on ignore la durée ne doit pas glisser dans la grille des
  // contrats longs : sans le nombre de mois, l'exclusion sèche ne peut pas
  // être vérifiée, donc rien n'est décidé.
  if (AUTRES_REVENUS.includes(d.situation) && !Number.isFinite(Number(d.duree_contrat_mois))) {
    return {
      ...out,
      verdict: 'donnees_incompletes',
      motif: `Durée du contrat ${String(d.situation).toUpperCase()} non renseignée`,
    };
  }
  if (
    AUTRES_REVENUS.includes(d.situation) &&
    Number(d.duree_contrat_mois) <= CONFIG.DUREE_CONTRAT_MIN_MOIS
  ) {
    return {
      ...out,
      verdict: 'non_assurable',
      motif: `Contrat ${d.situation.toUpperCase()} de ${d.duree_contrat_mois} mois — durée supérieure à 12 mois exigée`,
    };
  }

  // --- 2 bis. Aiguillage par type de garantie -----------------------------
  // Le candidat a déclaré une demande de rappel : on sort immédiatement.
  if (d.garantie === 'conseiller' || d.demande_rappel === true) {
    return {
      ...out,
      verdict: 'a_qualifier',
      base: 'demande_rappel',
      motif: 'Le candidat demande à parler à un conseiller',
    };
  }

  // Visale : régime entièrement distinct, non cumulable avec la GLI.
  if (d.garantie === 'visale') {
    return evaluerVisale(d, loyer, revenusTotaux, out);
  }

  if (d.garantie === 'autre') {
    return {
      ...out,
      verdict: 'a_qualifier',
      base: 'garantie_autre',
      motif: 'Garantie déclarée hors grille (caution bancaire, garant payant, employeur…) — arbitrage humain',
    };
  }

  // --- 3. Étudiant / apprenti : le dossier repose sur la caution ----------
  if (AVEC_CAUTION.includes(d.situation)) {
    return evaluerCautions(d, loyer, out, 'Étudiant ou apprenti avec caution');
  }

  // --- 4. Taux d'effort sur les revenus propres --------------------------
  let taux = null;
  if (REVENUS_STABLES.includes(d.situation)) taux = CONFIG.TAUX_REVENUS_STABLES;
  else if (AUTRES_REVENUS.includes(d.situation)) taux = CONFIG.TAUX_AUTRES_REVENUS;

  // Capacité de loyer = somme des revenus pondérés par leur propre taux.
  // Un candidat à 1 750 € en CDI plus 250 € d'APL supporte
  // 1750 x 0,37 + 250 x 0,25 = 710 € de loyer.
  const capacite =
    taux === null
      ? null
      : arrondi(revenus * taux + complementaires * CONFIG.TAUX_COMPLEMENTAIRES);

  // Seuil affiché au candidat : revenus principaux minimum, complémentaires déduits.
  const seuil =
    taux === null
      ? null
      : arrondi(Math.max(0, (loyer - complementaires * CONFIG.TAUX_COMPLEMENTAIRES) / taux));

  if (taux !== null && capacite >= loyer) {
    return {
      ...out,
      verdict: 'eligible',
      base: complementaires > 0 ? 'revenus_propres_et_complementaires' : 'revenus_propres',
      taux_applique: taux,
      seuil_revenus: seuil,
      capacite_loyer: capacite,
      revenus_complementaires: complementaires,
      motif: complementaires > 0
        ? `Capacité de ${capacite} € (dont ${arrondi(complementaires * CONFIG.TAUX_COMPLEMENTAIRES)} € issus des revenus complémentaires) pour un loyer de ${loyer} € CC`
        : `Taux d'effort de ${arrondi((loyer / revenus) * 100)} % — seuil ${taux * 100} %`,
    };
  }

  // --- 5. Repli 1 : dérogation reste à vivre -----------------------------
  // Évaluée avant le rejet pour situation inconnue : une personne
  // handicapée peut être hors grille professionnelle et rester éligible.
  const rav = evaluerResteAVivre(d, loyer, revenusTotaux, out);
  if (rav) return rav;

  if (taux === null) {
    return {
      ...out,
      verdict: 'a_qualifier',
      motif: `Situation « ${d.situation} » hors grille — arbitrage humain`,
    };
  }

  // --- 6. Repli 2 : garant ------------------------------------------------
  if (d.garant === true) {
    const viaGarant = evaluerCautions(d, loyer, out, 'Dossier porté par le garant');
    if (viaGarant.verdict === 'eligible') return viaGarant;
  }

  // --- 7. Hors critères ---------------------------------------------------
  return {
    ...out,
    verdict: 'hors_criteres',
    base: 'revenus_propres',
    taux_applique: taux,
    seuil_revenus: seuil,
    capacite_loyer: capacite,
    revenus_complementaires: complementaires,
    motif: `Revenus de ${revenus} € pour un seuil de ${seuil} €${complementaires > 0 ? ` (après prise en compte de ${complementaires} € de revenus complémentaires)` : ''} — loyer ${loyer} € CC, taux ${taux * 100} %`,
  };
}

/**
 * Évaluation d'un ou plusieurs cautionnaires.
 *
 * Règle Mila, confirmée :
 *  - caution unique   → taux d'effort garant de 33 %, soit 3,03 x le loyer CC
 *  - pluralité        → chaque cautionnaire s'engage individuellement pour la
 *                       totalité du loyer et doit gagner au moins 2 x le loyer CC.
 *                       Le seuil par tête remplace alors le seuil global : il
 *                       n'y a pas de cumul des revenus des cautions.
 */
function evaluerCautions(d, loyer, out, libelle) {
  const cautions = Array.isArray(d.cautions) && d.cautions.length
    ? d.cautions.map(Number)
    : (d.revenus_garant ? [Number(d.revenus_garant)] : []);

  const seuilGarant = arrondi(loyer / CONFIG.TAUX_GARANT);
  const seuilUnitaire = arrondi(loyer * CONFIG.MULTIPLE_MIN_CAUTION);

  if (!cautions.length) {
    return {
      ...out,
      verdict: 'hors_criteres',
      base: 'caution',
      taux_applique: CONFIG.TAUX_GARANT,
      seuil_revenus: seuilGarant,
      motif: `${libelle} : aucune caution renseignée (seuil ${seuilGarant} €)`,
    };
  }

  // --- Pluralité de cautions : seuil par tête, pas de cumul ---------------
  if (cautions.length > 1) {
    const insuffisante = cautions.find((c) => c < seuilUnitaire);
    if (insuffisante !== undefined) {
      return {
        ...out,
        verdict: 'hors_criteres',
        base: 'cautions_multiples',
        taux_applique: null,
        seuil_revenus: seuilUnitaire,
        motif: `Pluralité de cautions : chaque cautionnaire doit gagner au moins ${seuilUnitaire} € (une caution à ${insuffisante} €)`,
      };
    }
    return {
      ...out,
      verdict: 'eligible',
      base: 'cautions_multiples',
      taux_applique: null,
      seuil_revenus: seuilUnitaire,
      motif: `${libelle} — ${cautions.length} cautions, toutes au-dessus de ${seuilUnitaire} €`,
    };
  }

  // --- Caution unique : taux d'effort garant 33 % -------------------------
  const total = cautions[0];

  return {
    ...out,
    verdict: total >= seuilGarant ? 'eligible' : 'hors_criteres',
    base: 'caution',
    taux_applique: CONFIG.TAUX_GARANT,
    seuil_revenus: seuilGarant,
    motif: `${libelle} — ${total} € pour un seuil de ${seuilGarant} €`,
  };
}

/**
 * Dérogation reste à vivre : retraité ou handicapé, logement T1/T2/T3.
 * S'applique à la place du taux d'effort, jamais en plus.
 */
function evaluerResteAVivre(d, loyer, revenus, out) {
  const concerne = d.situation === 'retraite' || d.handicap === true;
  const typeOk = CONFIG.TYPES_DEROGATION_RAV.includes(String(d.logement_type || '').toUpperCase());
  if (!concerne || !typeOk) return null;

  const seuilRav = d.couple === true ? CONFIG.RESTE_A_VIVRE_COUPLE : CONFIG.RESTE_A_VIVRE_SEUL;
  const reste = arrondi(revenus - loyer);

  if (reste > seuilRav) {
    return {
      ...out,
      verdict: 'eligible',
      base: 'reste_a_vivre',
      taux_applique: null,
      seuil_revenus: arrondi(loyer + seuilRav),
      motif: `Dérogation reste à vivre : ${reste} € restants pour un minimum de ${seuilRav} €`,
    };
  }
  return null;
}

/**
 * Visale (Action Logement) — régime distinct.
 *
 * Point structurant : Visale ne se cumule NI avec une caution physique NI
 * avec une assurance loyers impayés. Le bailleur choisit une garantie et
 * une seule. Les critères Mila ne s'appliquent donc pas ici.
 *
 * Ce module ne délivre aucun verdict d'éligibilité : seul Action Logement
 * délivre le visa, et il doit être obtenu AVANT la signature du bail.
 * On produit une pré-vérification, jamais une décision.
 */
function evaluerVisale(d, loyer, revenus, out) {
  const V = CONFIG.VISALE;
  const plafond = V.PLAFOND_LOYER;
  const forfaitEtudiant = V.FORFAIT_ETUDIANT;

  const base = { ...out, base: 'visale', taux_applique: V.TAUX_EFFORT_MAX };

  // Incohérence de saisie : non-cumul.
  if (d.garant === true || (Array.isArray(d.cautions) && d.cautions.length)) {
    return {
      ...base,
      verdict: 'a_qualifier',
      motif: 'Visale déclaré avec une caution physique — non cumulables, à trancher avec le candidat',
    };
  }

  // Le mandat impose la GLI : Visale n'est pas une option sur ce lot.
  if (d.lot_accepte_visale === false) {
    return {
      ...base,
      verdict: 'a_qualifier',
      motif: 'Le propriétaire a opté pour la GLI sur ce lot — Visale non cumulable, arbitrage humain',
    };
  }

  // --- Visa déjà obtenu : le montant du visa fait foi ---------------------
  // Le visa certifié porte un loyer maximum garanti. Si ce montant est
  // inférieur au loyer CC du lot, le dossier est refusé — aucun calcul de
  // taux d'effort ne rattrape cela, et le visa ne se renégocie pas à la hausse
  // sans nouvelle demande auprès d'Action Logement.
  if (d.visale_visa_obtenu === true) {
    const montantVisa = Number(d.visale_montant_visa);

    if (!montantVisa || montantVisa <= 0) {
      return {
        ...base,
        verdict: 'a_qualifier',
        motif: 'Visa Visale déclaré sans montant garanti — demander le montant figurant sur le visa',
      };
    }

    if (montantVisa < loyer) {
      return {
        ...base,
        verdict: 'hors_criteres',
        seuil_revenus: null,
        seuil_visa: loyer,
        montant_visa: montantVisa,
        motif: `Visa Visale plafonné à ${montantVisa} € pour un loyer de ${loyer} € CC — écart de ${arrondi(loyer - montantVisa)} €. Une nouvelle demande auprès d'Action Logement est nécessaire.`,
      };
    }

    return {
      ...base,
      verdict: 'eligible',
      base: 'visale_visa',
      taux_applique: null,
      seuil_revenus: null,
      montant_visa: montantVisa,
      motif: `Visa Visale de ${montantVisa} € couvrant le loyer de ${loyer} € CC — activation obligatoire avant signature du bail`,
    };
  }

  // --- Pas encore de visa : pré-vérification seulement --------------------
  if (loyer > plafond) {
    return {
      ...base,
      verdict: 'hors_criteres',
      seuil_revenus: null,
      motif: `Loyer de ${loyer} € CC supérieur au plafond Visale de ${plafond} €`,
    };
  }

  // Forfait étudiant : jusqu'à 30 ans, sans examen des ressources.
  const estEtudiant = ['etudiant', 'apprenti'].includes(d.situation);
  const age = Number(d.age);
  if (estEtudiant && (!age || age <= V.AGE_FORFAIT_ETUDIANT_MAX) && loyer <= forfaitEtudiant) {
    return {
      ...base,
      verdict: 'a_verifier_visale',
      taux_applique: null,
      seuil_revenus: null,
      motif: `Forfait étudiant Visale (loyer <= ${forfaitEtudiant} €) — visa à demander sur visale.fr`,
    };
  }

  const seuil = arrondi(loyer / V.TAUX_EFFORT_MAX);
  if (revenus >= seuil) {
    return {
      ...base,
      verdict: 'a_verifier_visale',
      seuil_revenus: seuil,
      motif: `Pré-vérification Visale favorable (${revenus} € pour un seuil de ${seuil} €) — visa à demander sur visale.fr avant signature`,
    };
  }

  return {
    ...base,
    verdict: 'hors_criteres',
    seuil_revenus: seuil,
    motif: `Taux d'effort Visale dépassé : ${revenus} € pour un minimum de ${seuil} € (loyer ${loyer} € CC)`,
  };
}

/**
 * Texte destiné au candidat.
 *
 * Séparé volontairement de `motif`, qui reste interne (Telegram, refus_log,
 * arbitrage). Le motif contient des seuils et des montants ; le message
 * candidat n'en contient jamais.
 *
 * Deux raisons : un seuil affiché invite à ajuster la déclaration à la
 * hausse, et le dispositif n'a pas à exposer les critères de l'assurance
 * du propriétaire.
 *
 * Point d'architecture : le système ne prononce AUCUN refus. Tout verdict
 * autre qu'eligible / a_verifier_visale débouche sur un passage en revue
 * humaine, et le message au candidat se borne à l'annoncer. La question de
 * l'article 22 du RGPD ne se pose donc pas : il n'y a pas de décision
 * automatisée, seulement une collecte d'informations et un aiguillage.
 */
function messageCandidat(resultat) {
  switch (resultat.verdict) {
    case 'eligible':
      return "Merci. D'après les éléments que vous nous avez indiqués, votre situation semble compatible avec ce logement. Il s'agit d'une première approche déclarative : votre dossier sera étudié sur pièces après la visite.";

    case 'a_verifier_visale':
      return "Merci. D'après vos éléments, votre situation semble compatible avec ce logement, sous réserve de l'obtention de votre visa auprès d'Action Logement et de l'étude de votre dossier sur pièces.";

    // Aucun refus n'est prononcé par le système. Le candidat est informé
    // que sa demande part en traitement humain, rien de plus : c'est
    // Romain qui décide et qui écrit le message final.
    case 'hors_criteres':
    case 'non_assurable':
    case 'a_qualifier':
    case 'donnees_incompletes':
    default:
      return "Merci pour ces éléments. Votre demande est transmise à un conseiller, qui revient vers vous rapidement.";
  }
}

// --- Entrée n8n -----------------------------------------------------------
// Décommenter dans le node Code n8n :
//
// return items.map((item) => ({ json: { ...item.json, ...evaluer(item.json) } }));

module.exports = { evaluer, messageCandidat, CONFIG };
