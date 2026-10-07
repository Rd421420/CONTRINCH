/**
 * WF-6 · Contrôle quotidien.
 *
 * La purge, elle, tourne en cron système sur la base — un workflow n8n qui
 * ne tourne pas est une purge qui n'a pas lieu, et personne ne s'en aperçoit
 * avant le contrôle. Ce workflow ne purge donc rien : il vérifie que la
 * purge a bien eu lieu, et alerte si ce n'est pas le cas.
 *
 * Silencieux quand tout va bien.
 */

const { fabrique, noeudParametres } = require('../lib');

const ETAT = `SELECT
  -- Preuve d'exécution de la purge : c'est ce qu'on montre en cas de contrôle.
  (SELECT max(horodatage) FROM locatif.purge_log) AS derniere_purge,

  -- Fiches dont la date de purge est dépassée : si ce nombre grimpe, la
  -- ligne de crontab ne tourne plus.
  (SELECT count(*) FROM locatif.candidats
   WHERE purge_le IS NOT NULL AND purge_le < now() AND statut <> 'retenu') AS a_purger,

  -- Messages bloqués en file : Twilio en panne, ou numéro invalide.
  (SELECT count(*) FROM locatif.file_sms
   WHERE envoye_le IS NULL AND tentatives >= 5) AS sms_en_echec,

  -- File d'attente anormalement longue.
  (SELECT count(*) FROM locatif.file_sms
   WHERE envoye_le IS NULL AND envoyer_apres < now() - INTERVAL '12 hours') AS sms_en_retard,

  -- Jours fériés : le référentiel se recharge une fois par an. S'il ne
  -- couvre plus l'année en cours, le J+2 et le compteur de 2 h dérivent.
  (SELECT max(jour) FROM locatif.jours_feries) AS dernier_ferie,

  -- Pièces demandées sans retour depuis 48 h.
  (SELECT COALESCE(json_agg(json_build_object('id', id, 'nom', nom)), '[]'::json)
   FROM locatif.candidats
   WHERE pieces_demandees_le < now() - INTERVAL '48 hours'
     AND pieces_recues_le IS NULL) AS pieces_en_attente;`;

const ALERTES = `const parametres = $('Paramètres').first().json;
const etat = $input.first().json;
const alertes = [];

const derniere = etat.derniere_purge ? new Date(etat.derniere_purge) : null;
const heures = derniere ? (Date.now() - derniere.getTime()) / 3600000 : null;

if (!derniere) {
  alertes.push('• La purge n’a jamais tourné — vérifier la ligne de crontab.');
} else if (heures > 36) {
  alertes.push(\`• Dernière purge il y a \${Math.round(heures)} h — la crontab ne tourne plus.\`);
}

if (Number(etat.a_purger) > 0) {
  alertes.push(\`• \${etat.a_purger} fiche(s) auraient dû être purgées.\`);
}
if (Number(etat.sms_en_echec) > 0) {
  alertes.push(\`• \${etat.sms_en_echec} SMS abandonnés après 5 tentatives.\`);
}
if (Number(etat.sms_en_retard) > 0) {
  alertes.push(\`• \${etat.sms_en_retard} SMS en file depuis plus de 12 h.\`);
}

const dernierFerie = etat.dernier_ferie ? String(etat.dernier_ferie).slice(0, 4) : null;
if (!dernierFerie || Number(dernierFerie) < new Date().getFullYear()) {
  alertes.push('• Table des jours fériés périmée — relancer scripts/charger-jours-feries.js.');
}

const pieces = etat.pieces_en_attente || [];
if (pieces.length) {
  alertes.push(
    \`• \${pieces.length} dossier(s) sans pièces depuis 48 h : \` +
    pieces.map((p) => \`\${p.nom || 'sans nom'} (#\${p.id})\`).join(', '),
  );
}

// Silence quand tout va bien : une alerte quotidienne qui dit « rien à
// signaler » finit par ne plus être lue.
if (!alertes.length) return [];

return [{
  json: {
    chat_id: parametres.chat_id,
    texte: ['<b>Contrôle quotidien</b>', '', ...alertes].join('\\n'),
  },
}];`;

module.exports = {
  fichier: 'wf6-controle.json',
  description:
    'Chaque matin : vérifie que la purge tourne, que la file SMS s’écoule et que le référentiel de fériés est à jour.',

  construire(socle) {
    const f = fabrique('ERA · WF-6 · Contrôle quotidien');

    f.planification('Chaque jour ouvré à 8 h', [-480, 300], {
      interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }],
    });
    noeudParametres(f, [-260, 300]);
    f.requete('État du dispositif', [-40, 300], ETAT);
    f.code('Alertes', [180, 300], ALERTES);
    f.telegram('Prévenir sur Telegram', [400, 300]);

    f.chaine('Chaque jour ouvré à 8 h', 'Paramètres', 'État du dispositif', 'Alertes', 'Prévenir sur Telegram');

    return f.construire({ description: module.exports.description });
  },
};
