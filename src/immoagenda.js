/**
 * Bloc ImmoAgenda — génération et lecture
 *
 * Format relevé sur les événements réels de l'agenda perpimmo.
 * Les workflows existants (relance RDV 24h, demande d'avis Google) lisent
 * cette section : tout écart de format les casse silencieusement.
 *
 * Le séparateur est le caractère U+2500 (─), pas un tiret ASCII.
 */

const OUVERTURE = '── ImmoAgenda (ne pas modifier cette section) ──';
const FERMETURE = '── Fin ImmoAgenda ───────────';

/**
 * Construit la description complète d'un événement de visite.
 *
 * @param {object} d
 *   type          - 'Visite' | 'Etat des lieux d\'entrée' | 'Etat des lieux de sortie'
 *                   | 'Estimation' | 'RDV Agence' | 'RDV téléphonique' | 'Déplacement'
 *                   | 'Réunion' | 'Autre événement'
 *   client        - { nom, email, telephone }
 *   lot           - { reference, loyer_cc, adresse, proprietaire, tel_proprietaire, occupe }
 *   notes         - texte libre (optionnel)
 */
function construireDescription(d) {
  const lignes = [OUVERTURE, `Type d'événement: ${d.type}`];

  if (d.client && d.client.nom) {
    const email = d.client.email ? ` (${d.client.email})` : '';
    const tel = d.client.telephone ? ` ${d.client.telephone}` : '';
    lignes.push('', 'Client(s):', `  ${d.client.nom}${email}${tel}`);
  }

  if (d.lot && d.lot.reference) {
    lignes.push('', 'Bien(s):', '');
    lignes.push(`Référence ${d.lot.reference} (${d.lot.loyer_cc} € par mois)`);
    if (d.lot.adresse) lignes.push(d.lot.adresse);

    const telProp = d.lot.tel_proprietaire ? ` - ${d.lot.tel_proprietaire}` : '';
    lignes.push(`Vendeur: ${d.lot.proprietaire || ''}${telProp}`);

    if (d.lot.occupe !== undefined && d.lot.occupe !== null) {
      lignes.push(`Bien occupé: ${d.lot.occupe ? 'Oui' : 'Non'}`);
    }
  }

  if (d.notes) lignes.push('', `Notes: ${d.notes}`);

  lignes.push(FERMETURE);
  return lignes.join('\n');
}

/**
 * Titre de l'événement. Préfixe VISITE — pour distinguer d'un coup d'œil
 * ce que le système a posé de ce qui a été saisi à la main.
 */
function construireTitre(d) {
  const commune = extraireCommune(d.lot && d.lot.adresse) || '';
  const nom = (d.client && d.client.nom) || 'Candidat';
  return `VISITE — ${nom}${commune ? ` — ${commune}` : ''}`;
}

/**
 * Relit un bloc ImmoAgenda. Renvoie null si l'événement n'en contient pas :
 * c'est ce test qui distingue un rendez-vous métier d'un événement personnel.
 */
function lireDescription(description) {
  if (!description || !description.includes('ImmoAgenda')) return null;

  const bloc = description.split(FERMETURE)[0].split(OUVERTURE)[1];
  if (!bloc) return null;

  const out = {
    type: null,
    client: null,
    lot: null,
    relance_envoyee: /\[RELANCE ENVOYÉE/.test(description),
    avis_demande: /\[AVIS DEMANDÉ/.test(description),
  };

  const type = bloc.match(/Type d'événement:\s*(.+)/);
  if (type) out.type = type[1].trim();

  // Client(s): sur la ligne suivante, indentée
  const client = bloc.match(/Client\(s\):\s*\n\s+(.+)/);
  if (client) {
    const l = client[1].trim();
    const email = l.match(/\(([^)]+@[^)]+)\)/);
    const tel = l.match(/(\+?\d[\d\s.]{8,})\s*$/);
    out.client = {
      nom: l.split('(')[0].trim(),
      email: email ? email[1] : null,
      telephone: tel ? tel[1].replace(/[\s.]/g, '') : null,
    };
  }

  const ref = bloc.match(/Référence\s+(\S+)\s*\((\d+)\s*€/);
  if (ref) {
    out.lot = { reference: ref[1], loyer_cc: Number(ref[2]), adresse: null, commune: null };
    const apres = bloc.split(/Référence\s+\S+\s*\([^)]+\)\s*\n/)[1];
    if (apres) {
      const adresse = apres.split('\n')[0].trim();
      if (adresse && !adresse.startsWith('Vendeur')) {
        out.lot.adresse = adresse;
        out.lot.commune = extraireCommune(adresse);
      }
    }
  }

  return out;
}

/** « 9 Impasse Jordi Barre 66750 SAINT CYPRIEN » → « SAINT CYPRIEN » */
function extraireCommune(adresse) {
  if (!adresse) return null;
  const m = adresse.match(/\b\d{5}\s+(.+)$/);
  return m ? m[1].trim() : null;
}

/** Code postal, utile pour le géocodage. */
function extraireCodePostal(adresse) {
  if (!adresse) return null;
  const m = adresse.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

module.exports = {
  construireDescription,
  construireTitre,
  lireDescription,
  extraireCommune,
  extraireCodePostal,
  OUVERTURE,
  FERMETURE,
};
