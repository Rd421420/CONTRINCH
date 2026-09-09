/**
 * WF-4 · Proposition de créneaux — testable seul.
 *
 * La logique tourne en production à l'intérieur de WF-2 bis, où le contexte
 * est déjà chargé. Ce workflow existe pour la vérifier à part : changer le
 * seuil de 12 km, tester un lot rural, voir quel après-midi le système
 * choisit et pourquoi — le journal renvoie le motif de chaque écart.
 */

const { fabrique, noeudParametres } = require('../lib');

const LOT = `// Renseigne ici le lot à tester. Les coordonnées se relèvent d'un
// « /lot » déjà passé, ou par l'API Adresse.
const parametres = $input.first().json;
const maintenant = new Date();

return [{
  json: {
    ...parametres,
    reference: '677',
    latitude: 42.6206,
    longitude: 3.0189,
    date_demande: maintenant.toISOString(),
    fenetre_debut: maintenant.toISOString(),
    fenetre_fin: new Date(maintenant.getTime() + 40 * 86400000).toISOString(),
  },
}];`;

const CONTEXTE = `SELECT
  (
    SELECT COALESCE(json_agg(j.jour), '[]'::json)
    FROM locatif.jours_feries j WHERE j.jour >= current_date - 7
  ) AS jours_feries,
  (
    SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json)
    FROM (
      SELECT reference, commune, latitude, longitude
      FROM locatif.lots WHERE latitude IS NOT NULL
    ) x
  ) AS lots,
  (
    SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json)
    FROM locatif.creneaux_reserves r
    WHERE r.confirme OR r.reserve_jusqu_a > now()
  ) AS reservations;`;

const PROPOSER = `const demande = $('Lot à tester').first().json;
const contexte = $('Contexte').first().json;

const lotsParReference = {};
for (const l of contexte.lots || []) lotsParReference[l.reference] = l;

const evenements = $input.all()
  .map((item) => item.json)
  .filter((e) => e && e.start && (e.start.dateTime || e.start.date))
  .map((e) => ({
    debut: e.start.dateTime || e.start.date,
    fin: (e.end && (e.end.dateTime || e.end.date)) || e.start.dateTime || e.start.date,
    summary: e.summary || '',
    description: e.description || '',
  }));

const resultat = ERA.creneaux.proposerCreneaux({
  lot: { reference: demande.reference, latitude: demande.latitude, longitude: demande.longitude },
  dateDemande: new Date(demande.date_demande),
  maintenant: new Date(),
  evenements,
  reservations: contexte.reservations || [],
  joursFeries: contexte.jours_feries || [],
  lots: lotsParReference,
});

return [{
  json: {
    evenements_lus: evenements.length,
    ancres_immoagenda: evenements.filter((e) => ERA.immoagenda.lireDescription(e.description)).length,
    date_mini: ERA.temps.isoJour(
      ERA.calendrier.dateMini(new Date(demande.date_demande), contexte.jours_feries || []),
    ),
    creneaux: resultat.creneaux.map((c) => ({
      quand: ERA.messages.libelleCreneau(c, ERA.temps),
      groupe: c.groupe,
      priorite: c.priorite,
      motif: c.motif,
      distance_ancre_km: c.distance_ancre_km,
    })),
    // Pourquoi les autres après-midis ont été écartés : plafond atteint,
    // hors rayon, ou ancre non localisée.
    journal: resultat.journal,
  },
}];`;

module.exports = {
  fichier: 'wf4-creneaux.json',
  description:
    'Propose deux créneaux pour un lot donné et explique pourquoi les autres après-midis ont été écartés.',

  construire(socle) {
    const f = fabrique('ERA · WF-4 · Proposition de créneaux');

    f.manuel('Lancer le test', [-480, 300]);
    noeudParametres(f, [-260, 300]);
    f.code('Lot à tester', [-40, 300], LOT);
    f.requete('Contexte', [180, 300], CONTEXTE);
    f.agendaLire('Google Agenda — occupation', [400, 300], { source: 'Lot à tester' });
    f.code('Proposer', [620, 300], PROPOSER, { socle });

    f.chaine('Lancer le test', 'Paramètres', 'Lot à tester', 'Contexte');
    // La lecture d'agenda a besoin de la fenêtre calculée dans « Lot à
    // tester » : on la relit depuis ce node plutôt que depuis « Contexte »,
    // qui ne renvoie que des agrégats.
    f.relier('Contexte', 'Google Agenda — occupation');
    f.relier('Google Agenda — occupation', 'Proposer');

    return f.construire({ description: module.exports.description });
  },
};
