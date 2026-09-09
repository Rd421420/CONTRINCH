# Pré-étude de solvabilité et prise de rendez-vous

Socle de code du dispositif décrit dans [`docs/cahier-des-charges.md`](docs/cahier-des-charges.md)
(ERA Dupont Romain, version 2 — septembre 2026).

Une demande de visite arrive par écrit, le système mène une courte conversation
SMS, calcule le taux d'effort au regard des critères Sésame et — si la situation
est compatible — propose deux créneaux cohérents avec les rendez-vous déjà posés
dans le secteur. **Il ne sélectionne pas** : tout dossier non favorable part en
arbitrage humain, et c'est Romain qui décide puis qui écrit au candidat.

```
npm test        # 84 tests, aucune dépendance externe
```

Node 20 ou plus. Aucun `node_modules` : tout tourne sur la bibliothèque standard.

---

## Ce qui est construit ici

Les parties **déterministes** du dispositif — celles qui se testent seules, se
rejouent sur d'anciens dossiers et n'ont besoin ni de réseau ni de base.

| Module | Rôle | Cahier des charges |
|---|---|---|
| `src/eligibilite.js` | WF-3 · calcul du taux d'effort, quatre branches de garantie | §2, §2 bis, §6 |
| `src/creneaux.js` | WF-4 · ancres, rayon de 12 km, enchaînement sur le même lot | §5 |
| `src/calendrier.js` | J+2 ouvré, plage d'envoi 9 h–19 h, compteur de 2 h **ouvrées** | §5 |
| `src/sequence.js` | WF-2 · machine à états de la conversation SMS | §3, §4 |
| `src/messages.js` | script des SMS, mention RGPD | §4, §7 |
| `src/parsing.js` | lecture des réponses : fermées par `switch`, montants par regex | §6 |
| `src/immoagenda.js` | génération et lecture du bloc ImmoAgenda | §5 |
| `src/geo.js` | haversine, géocodage à la commune (API Adresse) | §5 |
| `src/temps.js` | heures murales Europe/Paris, robustes au changement d'heure | — |
| `src/config.js` | toutes les constantes de calendrier et d'agenda | §5 |
| `db/schema.sql` | schéma `locatif` | §6 |
| `scripts/charger-jours-feries.js` | alimente `jours_feries` depuis l'API Etalab | §5 |

Chaque module est une fonction pure : rien ne lit la base, rien n'appelle Google
Agenda, rien n'envoie de SMS. Les adaptateurs restent dans n8n, et c'est ce qui
permet de **rejouer WF-3 sur 20 dossiers passés** comme le demande la checklist.

## Ce qui n'est pas construit

Les adaptateurs — délibérément, ils appartiennent à n8n :

- WF-1, tri de la boîte générale (IMAP + LLM local sur le corps du mail seul)
- l'envoi Twilio et le webhook de réception
- les lectures et écritures Google Agenda
- les commandes Telegram `/lot` et `/loue`, et les deux files d'arbitrage
- WF-5, demande de pièces après visite

Le repli LLM sur les montants illisibles n'est pas branché non plus : `parseMontant`
renvoie `null` et c'est à l'appelant d'aller voir `qwen2.5:3b-instruct-q4_K_M` en
local. **Jamais `glm-5.3:cloud`** — le suffixe signifie que le texte sort du VPS,
et il contient nom, revenus et situation professionnelle du candidat.

---

## Mise en route

```bash
# 1. Schéma
psql -d era_loyers -f db/schema.sql

# 2. Jours fériés (une fois par an)
node scripts/charger-jours-feries.js | psql -d era_loyers

# 3. Purge quotidienne — cron système, pas pg_cron
#    0 3 * * *  psql -d era_loyers -c "SELECT locatif.purger_candidats();"

# 4. Vérification après 24 h
psql -d era_loyers -c "SELECT * FROM locatif.purge_log ORDER BY horodatage DESC LIMIT 7;"
```

Dans un node Code n8n :

```js
const { evaluer } = require('/data/era/src');
return items.map((item) => ({ json: { ...item.json, ...evaluer(item.json) } }));
```

Variable d'environnement facultative : `URL_MENTION_INFORMATION`, l'adresse de la
page de mention d'information. Une URL de la marque, jamais un raccourcisseur —
les filtres opérateurs français les traitent très différemment.

---

## Trois décisions prises en écrivant le code

Le cahier des charges laissait ces points implicites ou contradictoires. Voici ce
qui a été retenu, à confirmer ou à corriger.

**1. Demande reçue un vendredi → premier créneau le mercredi, pas le lundi.**
La règle écrite au §5 est `date_mini = date_demande + 2 jours ouvrés`. Depuis un
vendredi, cela donne mardi, donc mercredi une fois filtrés les blocs terrain
(lundi, mercredi, jeudi). Le tableau d'illustration juste en dessous annonce
« lundi suivant » — ce qui reviendrait à 3 jours ouvrés et contredit les quatre
autres lignes du même tableau, toutes cohérentes avec la règle. **C'est la règle
qui a été implémentée.** Si le tableau fait foi, une ligne suffit à changer
(`DELAI_MINI_JOURS_OUVRES` dans `src/config.js`).

**2. Un CDD de 12 mois ou moins arrête la séquence tout de suite.**
Le cahier classe cette situation en « exclusion sèche » mais ne dit pas quand
sortir. Continuer à poser quatre questions à un candidat déjà exclu coûte quatre
SMS et laisse croire à un examen. Le système envoie donc le SMS 4b — qui n'annonce
rien — et bascule sur Telegram. Conséquence à connaître : `refus_log.ecart_seuil`
reste nul sur ces dossiers, faute de revenus déclarés.

**3. Un CDD dont la durée est inconnue ne passe plus en silence.**
Dans le fichier `wf3eligibilite.js` d'origine, `Number(undefined) <= 12` vaut
`false` : un CDD sans durée renseignée échappait à l'exclusion et se retrouvait
évalué comme un contrat long, à 4 × le loyer. Il renvoie maintenant
`donnees_incompletes`, donc un arbitrage humain.

## Un bug corrigé au passage

`src/sequence.js` calculait le verdict à partir de la dernière réponse reçue mais
ne l'écrivait pas dans le patch : les revenus complémentaires et la composition du
foyer servaient au calcul puis disparaissaient. La fiche en base devenait
irrejouable — et c'est exactement ce que le journal WF-6 bis doit permettre de
relire à trois mois. Couvert par un test de régression.

---

## Points restés ouverts

Ils viennent du §9 du cahier des charges et n'ont pas de réponse dans le code :

| Sujet | Où c'est câblé | Ce qui manque |
|---|---|---|
| Zone Visale des communes du portefeuille | `lots.zone_visale`, défaut zone 3 | à relever une fois sur visale.fr |
| Plafonds Visale au 6 janvier 2026 | `CONFIG.VISALE` dans `src/eligibilite.js` | à vérifier avant production, puis chaque janvier |
| Taux Mila de 37 % | `CONFIG.TAUX_REVENUS_STABLES` | fourchette contractuelle 35–40 %, à confirmer |
| Seuil de 12 km | `RAYON_ANCRE_KM` | à ajuster sur les trajets réels |
| Plafond de visites | `PLAFOND_VISITES_APRES_MIDI = 5` | démarrer à 5, remonter à 6 une fois mesuré |
| Libellé du SMS 4a | `src/messages.js` | validation juridique ERA |

Deux règles du §5 ne sont pas implémentées et ne le seront pas en v1 : l'ordre des
visites **par itinéraire** à l'intérieur d'un après-midi (il faudrait replanifier
des rendez-vous déjà confirmés) et le calcul de distance routière (haversine
suffit à 12 km de seuil).

---

## Ce qui ne doit jamais changer sans y penser à deux fois

**Le séparateur du bloc ImmoAgenda est U+2500 (`─`), pas un tiret ASCII.** Une
substitution silencieuse casse le workflow de relance RDV 24 h et celui des avis
Google, sans le moindre message d'erreur. Un test le vérifie.

**Aucun message au candidat n'annonce ni ne sous-entend un refus.** Ce n'est pas
une précaution de style : c'est ce qui maintient le dispositif hors du champ de
l'article 22 du RGPD. Le jour où le SMS 4b dirait « votre dossier ne correspond
pas », il y aurait décision automatisée. Un test balaie tous les parcours non
favorables et vérifie qu'aucun message ne contient de refus, de seuil ou de
montant.

**Le mot-clé de mise en relation humaine est CONSEILLER, jamais STOP.** Twilio
intercepte STOP avant le webhook et place le numéro en liste de blocage
définitive. STOP reste traité comme la véritable désinscription, qui est
obligatoire.
