/**
 * Constantes de calendrier et d'agenda.
 *
 * Cahier des charges §5 : « Ces deux constantes gouvernent tout : le J+2,
 * le compteur de 2 h, la file d'attente des SMS. Aucune autre règle de
 * calendrier à écrire ailleurs. »
 */

const FUSEAU = 'Europe/Paris';

const JOURS_OUVRES = [1, 2, 3, 4, 5];        // lundi à vendredi — agence fermée le samedi
const PLAGE_ENVOI = { debut: 9, fin: 19 };   // aucun SMS hors de cette plage

/** Délai minimum entre la demande et le premier créneau proposé. */
const DELAI_MINI_JOURS_OUVRES = 2;

/**
 * Délai de réponse laissé au candidat, en heures OUVRÉES, pendant lequel
 * les deux créneaux proposés lui sont réservés.
 *
 * Passé ce délai sans réponse, les deux créneaux sont réellement SUPPRIMÉS
 * de `creneaux_reserves` — ils ne sont plus seulement ignorés — et
 * redeviennent proposables à d'autres candidats.
 *
 * Le compteur est ouvré : il se met en pause à 19 h et reprend à 9 h le
 * lendemain ouvré. Une proposition partie à 18 h expire donc le lendemain
 * à 10 h, pas à 20 h.
 */
const BLOCAGE_HEURES_OUVREES = 2;

/** Une seule relance après expiration du premier blocage (§5). */
const RELANCES_MAX = 1;

/** Deux réponses incomprises d'affilée sur la même question → Telegram. */
const ECHECS_PARSING_MAX = 2;

/**
 * Suivi des dossiers en attente d'arbitrage.
 *
 * Le §6 pose la fragilité sans la résoudre : « destinataire unique veut dire
 * que le système s'arrête quand tu es absent. Une semaine de congés, ce sont
 * dix arbitrages en attente et des candidats sans réponse. » Ces trois seuils
 * sont la réponse, comptés en jours OUVRÉS — un dossier tombé le vendredi
 * soir n'a pas vieilli le lundi matin.
 */
const ARBITRAGE_RAPPEL_JOURS = 1;   // au-delà, le dossier revient chaque matin
const ARBITRAGE_ATTENTE_JOURS = 3;  // au-delà, le candidat reçoit un mot d'attente
const ARBITRAGE_ATTENTE_ABSENCE_JOURS = 1; // pendant une absence, le délai se resserre

/**
 * Blocs terrain : une demi-journée est l'unité de regroupement.
 *
 * Le cahier des charges hésitait entre deux options (§5) : matin +
 * après-midi, ou après-midi coupé en deux. C'est la première qui est
 * retenue — la demi-journée entière, matin ou après-midi.
 *
 * Ouvrir les matinées n'entre pas en conflit avec les blocs Chantier et
 * Dossiers gestion : ils sont dans l'agenda, et le filtre d'occupation les
 * respecte comme n'importe quel autre événement. Une matinée déjà prise ne
 * propose rien, sans qu'aucune règle n'ait à la connaître.
 */
const BLOCS_TERRAIN = [
  { jour: 1, groupe: 'matin', debut: 9, fin: 12 },        // lundi
  { jour: 1, groupe: 'apres-midi', debut: 14, fin: 18 },
  { jour: 3, groupe: 'matin', debut: 9, fin: 12 },        // mercredi
  { jour: 3, groupe: 'apres-midi', debut: 14, fin: 18 },
  { jour: 4, groupe: 'matin', debut: 9, fin: 12 },        // jeudi
  { jour: 4, groupe: 'apres-midi', debut: 14, fin: 18 },
];

/** Durée d'un créneau de visite, en minutes (champ `end` de l'événement). */
const DUREE_VISITE_MIN = 30;

/**
 * Rayon d'agrégation autour de l'ancre. Point ouvert §9 : à réévaluer
 * après les premières semaines, sur les trajets réels.
 */
const RAYON_ANCRE_KM = 12;

/**
 * Plafond de visites par demi-journée. Le cahier des charges arrête 6 comme
 * maximum théorique mais demande de démarrer à 5, le temps de mesurer les
 * trajets réels.
 */
const PLAFOND_VISITES_DEMI_JOURNEE = 5;
const PLAFOND_VISITES_MAX = 6;

/** Un seul état des lieux par demi-journée ; s'il y en a un, il devient l'ancre. */
const PLAFOND_EDL_DEMI_JOURNEE = 1;

/** Horizon de recherche de créneaux avant abandon. */
const SEMAINES_RECHERCHE_MAX = 4;

/** Durées de conservation (§6, WF-6). */
const PURGE_JOURS_SANS_SUITE = 30;
const PURGE_JOURS_APRES_VISITE = 90;

const API_ADRESSE = 'https://api-adresse.data.gouv.fr/search/';
const API_JOURS_FERIES = 'https://calendrier.api.gouv.fr/jours-feries/metropole.json';

module.exports = {
  FUSEAU,
  JOURS_OUVRES,
  PLAGE_ENVOI,
  DELAI_MINI_JOURS_OUVRES,
  BLOCAGE_HEURES_OUVREES,
  RELANCES_MAX,
  ECHECS_PARSING_MAX,
  ARBITRAGE_RAPPEL_JOURS,
  ARBITRAGE_ATTENTE_JOURS,
  ARBITRAGE_ATTENTE_ABSENCE_JOURS,
  BLOCS_TERRAIN,
  DUREE_VISITE_MIN,
  RAYON_ANCRE_KM,
  PLAFOND_VISITES_DEMI_JOURNEE,
  PLAFOND_VISITES_MAX,
  PLAFOND_EDL_DEMI_JOURNEE,
  SEMAINES_RECHERCHE_MAX,
  PURGE_JOURS_SANS_SUITE,
  PURGE_JOURS_APRES_VISITE,
  API_ADRESSE,
  API_JOURS_FERIES,
};
