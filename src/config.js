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

/** Durée de blocage provisoire des deux créneaux proposés, en heures ouvrées. */
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
 * Blocs terrain — option B retenue au cahier des charges §5 :
 * l'après-midi est coupé en deux groupes indépendants, chacun avec sa
 * propre ancre géographique. Les matinées restent aux blocs Chantier
 * et Dossiers gestion.
 */
const BLOCS_TERRAIN = [
  { jour: 1, groupe: 'A', debut: 14, fin: 16 },   // lundi
  { jour: 1, groupe: 'B', debut: 16, fin: 18 },
  { jour: 3, groupe: 'A', debut: 14, fin: 16 },   // mercredi
  { jour: 3, groupe: 'B', debut: 16, fin: 18 },
  { jour: 4, groupe: 'A', debut: 14, fin: 16 },   // jeudi
  { jour: 4, groupe: 'B', debut: 16, fin: 18 },
];

/** Durée d'un créneau de visite, en minutes (champ `end` de l'événement). */
const DUREE_VISITE_MIN = 30;

/**
 * Rayon d'agrégation autour de l'ancre. Point ouvert §9 : à réévaluer
 * après les premières semaines, sur les trajets réels.
 */
const RAYON_ANCRE_KM = 12;

/**
 * Plafond de visites par après-midi terrain. Le cahier des charges arrête
 * 6 comme maximum théorique mais demande de démarrer à 5, le temps de
 * mesurer les trajets réels.
 */
const PLAFOND_VISITES_APRES_MIDI = 5;
const PLAFOND_VISITES_MAX = 6;

/** Un seul état des lieux par après-midi ; s'il y en a un, il devient l'ancre. */
const PLAFOND_EDL_APRES_MIDI = 1;

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
  PLAFOND_VISITES_APRES_MIDI,
  PLAFOND_VISITES_MAX,
  PLAFOND_EDL_APRES_MIDI,
  SEMAINES_RECHERCHE_MAX,
  PURGE_JOURS_SANS_SUITE,
  PURGE_JOURS_APRES_VISITE,
  API_ADRESSE,
  API_JOURS_FERIES,
};
