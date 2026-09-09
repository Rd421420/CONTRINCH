# Workflows n8n

Douze workflows importables tels quels. Le code des modules `src/` est
**empaqueté dans les nodes Code** : aucun `require`, aucun volume à monter,
aucune variable d'environnement. Un import et ça tourne.

```bash
npm run n8n:build       # régénère n8n/workflows/*.json depuis src/
npm run n8n:verifier    # échoue si un fichier n'est plus à jour
```

`npm test` vérifie aussi que les workflows sont à jour : un changement dans
`src/` qui n'a pas été régénéré fait échouer la suite.

---

## Ordre d'import

À importer dans cet ordre — WF-7 appelle WF-5, qui doit donc exister avant.

| Ordre | Fichier | Rôle | Déclencheur |
|---|---|---|---|
| 1 | `wf3-eligibilite.json` | calcul du taux d'effort, rejouable seul | manuel + sous-workflow |
| 2 | `wf4-creneaux.json` | proposition de créneaux, testable seule | manuel |
| 3 | `wf5-demande-pieces.json` | liste des justificatifs | manuel + sous-workflow |
| 4 | `wf1-tri-boite-generale.json` | tri des mails, création de la fiche | Gmail, 10 min |
| 5 | `wf2-sequence-demarrage.json` | envoi du SMS 1 | planifié, 5 min |
| 6 | `wf2bis-sequence-reponses.json` | **cœur** : réponses entrantes | webhook Twilio |
| 7 | `wf2ter-emission-sms.json` | vide la file, dans la plage 9 h – 19 h | planifié, 5 min |
| 8 | `wf2quater-expiration-relance.json` | expiration, relance unique, abandon | planifié, 15 min |
| 9 | `wf5bis-recapitulatif-telegram.json` | un seul message à 18 h | planifié |
| 10 | `wf6-controle.json` | contrôle de la purge et de la file | planifié, 8 h |
| 11 | `wf8-arbitrages-en-attente.json` | rappelle les dossiers non clos | planifié, 9 h |
| 12 | `wf7-telegram-commandes.json` | `/lot`, `/loue`, `/pieces`, `/traite`, `/absence` | Telegram |

**Un seul déclencheur Telegram dans tout le dispositif** (WF-7). Deux
workflows qui écoutent le même jeton se volent les mises à jour.

## Après l'import

1. **Le node « Paramètres »**, présent en tête de chaque workflow, est le
   seul à modifier : numéro Twilio, identifiant de conversation Telegram,
   agenda, boîte pièces, URL Ollama. Rien d'autre ne contient de valeur
   locale — un test le vérifie.

2. **Les identifiants** ne sont pas exportés. À rattacher une fois par type,
   n8n les propose ensuite automatiquement : Postgres, Twilio, Telegram,
   Google Calendar (OAuth2), Gmail (OAuth2), SMTP.

3. **Le webhook Twilio.** Copier l'URL de production du node « Webhook
   Twilio » de WF-2 bis, et la coller dans la console Twilio, sur le numéro
   long code, champ « A MESSAGE COMES IN », méthode POST.

4. **La base.** `db/schema.sql`, `db/002-file-sms.sql`, `db/003-arbitrage.sql`,
   dans cet ordre.

5. **Les jours fériés** : `node scripts/charger-jours-feries.js | psql -d era_loyers`.
   Une fois par an — WF-6 alerte quand le référentiel devient périmé.

## Ce qu'il faut vérifier avant d'activer

Dans l'ordre de la checklist du §8 :

- WF-3 en manuel, sur vingt dossiers passés dont tu connais l'issue
- WF-4 en manuel : le journal renvoyé dit pourquoi chaque après-midi a été
  écarté (plafond, hors rayon, ancre non localisée)
- WF-7 : `/lot`, puis vérifier en base que la commune a bien été géocodée
- WF-2 bis : envoyer un SMS depuis ton propre numéro, dérouler la séquence
- WF-2 ter : vérifier qu'un message préparé après 19 h ne part que le
  lendemain 9 h
- WF-8 : laisser volontairement un dossier en arbitrage une journée, vérifier
  qu'il remonte le lendemain matin et que `/traite` l'arrête

**Phase 1 : le système propose, tu valides.** Le moyen le plus simple de
tenir cette phase sans modifier les workflows est de désactiver WF-2 ter :
tout s'accumule dans `file_sms`, visible en SQL, et rien ne part. Tu
réactives quand tu es en confiance.

---

## Deux règles de construction à respecter si tu modifies les workflows

**Les paramètres SQL sont découpés sur les virgules.** n8n coupe la liste
`queryReplacement` sur les virgules avant de la passer à Postgres : une
valeur qui en contient décale silencieusement tous les paramètres suivants.
Les trois endroits concernés sont neutralisés (référence de lot, message
d'erreur Twilio, liste d'identifiants passée par `|`), et un test le
vérifie. Ne jamais passer de texte libre en paramètre sans le nettoyer.

**Un node Postgres renvoie un item par ligne.** Deux requêtes de contexte
en série produisent un produit cartésien d'items, et l'appariement des
nodes suivants est perdu. C'est pourquoi le contexte se charge en une seule
requête, qui renvoie une ligne unique portant des colonnes `json_agg`.

Accessoirement : aucun node IF ni Switch. Leur schéma a changé plusieurs
fois entre les versions 1.x de n8n. Un node Code qui renvoie zéro item
arrête sa branche tout aussi bien.

---

## Le cycle d'un dossier d'arbitrage

C'est le point que le §6 signalait comme fragile sans le résoudre — « une
semaine de congés, ce sont dix arbitrages en attente et des candidats sans
réponse ». Trois workflows s'en partagent la charge :

```
Verdict non favorable, ou CONSEILLER, ou créneaux refusés
        ↓  WF-2 bis / WF-2 quater
   statut = arbitrage, arbitrage_depuis = maintenant
        ↓
   File immédiate ─→ Telegram tout de suite   (demande de rappel)
   File différée  ─→ récapitulatif de 18 h    (WF-5 bis, une seule fois)
        ↓
   ┌─ WF-8, chaque matin, tant que arbitre_le est NULL ─────────┐
   │  J+1 ouvré  → le dossier revient dans le rappel du matin   │
   │  J+3 ouvrés → mot d'attente au candidat (une seule fois)   │
   │  en absence → rappels au suppléant, mot d'attente dès J+1  │
   └────────────────────────────────────────────────────────────┘
        ↓
   /traite ID  →  arbitre_le posé, le dossier se tait
```

**Un dossier revient tous les matins tant qu'il n'est pas clos, et c'est
voulu.** Le récapitulatif de 18 h annonce ce qui vient d'arriver et ne le
répète jamais ; WF-8 rappelle ce qui traîne. Sans lui, un dossier passé
inaperçu un soir disparaissait définitivement, et le candidat attendait sans
que personne ne s'en aperçoive.

`/traite` est le seul moyen d'arrêter la relance. Il ne fait rien d'autre :
c'est toi qui écris au candidat, comme aujourd'hui.

**Le mode absence** se déclare avec `/absence 2026-10-20 2026-10-27` et un
identifiant de conversation suppléant, facultatif. Sans suppléant le
dispositif ne s'arrête pas : le délai avant le mot d'attente tombe à un jour
ouvré, pour qu'un candidat ne reste pas une semaine sans nouvelles. `/retour`
y met fin plus tôt.

---

## Ce que ces workflows ne font pas

- **Aucune relance automatique sur les pièces manquantes.** Détecter qu'une
  pièce est arrivée suppose de lire la boîte dédiée, qui n'existe pas encore
  (point ouvert de la checklist). WF-6 signale à la place les dossiers sans
  retour depuis 48 h, et tu relances toi-même.
- **Aucun repli LLM sur les montants illisibles.** `parseMontant` renvoie
  `null`, la séquence repose la question une fois, puis bascule sur
  Telegram. Brancher `qwen2.5:3b-instruct-q4_K_M` ne se justifie qu'au vu
  du taux d'échec réel de la regex — à mesurer sur les cinquante premiers
  cas, comme prévu au §9.
- **Aucun ordonnancement par itinéraire** à l'intérieur d'un après-midi :
  cela supposerait de déplacer des rendez-vous déjà confirmés.
