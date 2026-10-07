# Installation, étape par étape

Guide de mise en place du dispositif de pré-étude de solvabilité.
Compter **une demi-journée** pour tout dérouler, sans se presser.

Chaque étape se vérifie avant de passer à la suivante. Rien ne s'active
avant la phase 8 : jusque-là, aucun SMS ne peut partir, même par erreur.

---

## Node est-il nécessaire ?

**Pas pour créer la base.** Les étapes 1 à 3 ne demandent que `psql`,
`curl` et `python3`.

Node sert à trois choses, et **aucune ne doit tourner sur le serveur** :

| Quoi | Où le lancer |
|---|---|
| `npm test` | ton poste, ou le serveur |
| `verifier-base.js` | tout poste qui atteint la base |
| `importer-workflows.js` | tout poste qui atteint n8n en HTTPS |

Si Node manque sur le VPS, l'installeur s'en accommode : il crée la base et
saute les deux contrôles en te disant comment les rejouer ailleurs.

Pour l'installer quand même, sur Debian ou Ubuntu :

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v
```

`apt install nodejs` sans ce dépôt donne une version trop ancienne sur la
plupart des distributions.

---

## Avant de commencer

À avoir sous la main :

| | |
|---|---|
| Accès SSH au VPS | celui qui porte n8n, PostgreSQL et Ollama |
| Accès administrateur n8n | l'interface web |
| Console Twilio | compte + long code français déjà acheté |
| Un bot Telegram | à créer, voir étape 5 |
| Un projet Google Cloud | pour Agenda et Gmail, voir étape 4 |

Et le dépôt, sur le VPS ou sur ton poste :

```bash
git clone <url-du-depot> era-preetude
cd era-preetude
npm test          # 127 tests, doit passer entièrement
```

Si `npm test` échoue, ne va pas plus loin : quelque chose ne va pas dans
l'environnement Node (il faut la version 20 au minimum).

---

## Étape 1 — La base de données

### Le plus simple : passer par le compte postgres

Sur Debian et Ubuntu, PostgreSQL n'écoute souvent que sur sa socket unix,
et seul le rôle `postgres` existe. Le mode `SOCKET=1` s'appuie dessus : ni
TCP, ni `pg_hba`, ni mot de passe.

Une seule contrainte : **l'utilisateur postgres doit pouvoir lire le
dépôt**, donc pas depuis `/root`, dont le mode est 0700.

```bash
mv ~/era-preetude /opt/era-preetude
chmod -R a+rX /opt/era-preetude
cd /opt/era-preetude

SOCKET=1 BASE=verif_loc ./scripts/installer-vps.sh
```

C'est tout. La base, les huit tables, les jours fériés et le contrôle
passent sans qu'aucun rôle ni mot de passe n'ait à être créé.

Le rôle applicatif reste nécessaire, mais **plus tard** : c'est n8n qui en
aura besoin pour se connecter. Voir ci-dessous.

### Après une installation en mode socket : donner la base au rôle

En mode `SOCKET=1`, `psql` tourne sous le compte `postgres`, qui se
retrouve **propriétaire de tout**. Le rôle avec lequel n8n se connectera
n'a alors aucun droit — il reçoit `permission denied for schema locatif`.

Une commande le corrige, après avoir créé le rôle :

```bash
sudo -u postgres psql -c "CREATE ROLE era LOGIN PASSWORD 'ÀChanger';"
./scripts/attribuer-role.sh verif_loc era
```

Le script transfère la base, le schéma, les huit tables, leurs séquences et
la fonction de purge. Il vérifie qu'il ne reste rien, et se relance sans
risque.

### Le rôle applicatif, pour n8n

Sur Debian et Ubuntu, PostgreSQL ne connaît au départ que le rôle
`postgres`, et l'authentification locale est en « peer » : le nom du compte
système doit correspondre au rôle. En root, `createdb` répond donc
`role "root" does not exist`.

Crée le rôle applicatif — **c'est aussi celui dont n8n aura besoin**, autant
le faire une bonne fois :

```bash
sudo -u postgres psql -c "CREATE ROLE era LOGIN PASSWORD 'À_CHANGER';"
sudo -u postgres createdb -O era verif_loc
```

Puis, dans le shell qui lancera la suite :

```bash
export PGHOST=127.0.0.1 PGUSER=era PGPASSWORD='À_CHANGER' PGDATABASE=verif_loc
psql -c '\conninfo'
```

`\conninfo` doit répondre « connected to database verif_loc as user era ».

**Garde ce mot de passe** : c'est celui de l'identifiant Postgres à saisir
dans n8n à l'étape 4.

### n8n en conteneur : l'accès à PostgreSQL

Si n8n tourne dans Docker — c'est le cas des installations Hostinger — il ne
joindra jamais `127.0.0.1` : cette adresse désigne le conteneur lui-même.

Deux choses doivent être vraies :

| | |
|---|---|
| PostgreSQL écoute sur la passerelle du pont | `listen_addresses` contient `172.18.0.1` |
| `pg_hba.conf` autorise ce réseau | une règle `host … 172.18.0.0/16` |

La seconde manque presque toujours, et n8n affiche alors « Couldn't
connect » — le refus a lieu avant l'examen du mot de passe. Un script s'en
charge :

```bash
ESSAI=1 ./scripts/ouvrir-acces-docker.sh verif_loc era   # montre sans écrire
./scripts/ouvrir-acces-docker.sh verif_loc era
```

Il détecte les ponts Docker de la machine, n'ajoute que ce qui manque —
cette base, ce rôle, ce réseau — sauvegarde `pg_hba.conf` avant d'y
toucher, et recharge sans couper le service.

L'identifiant Postgres à saisir dans n8n :

| Champ | Valeur |
|---|---|
| Host | `172.18.0.1` — la passerelle, pas `localhost` |
| Port | `5432` |
| Database | `verif_loc` |
| User | `era` |
| SSL | Disable |

### La voie courte

Un script enchaîne les étapes 1 à 3 et le contrôle, avec une vérification
après chaque geste. Idempotent : relancé, il ne recrée rien.

```bash
BASE=verif_loc ./scripts/installer-vps.sh --essai   # montre sans rien faire
BASE=verif_loc ./scripts/installer-vps.sh
```

Il s'arrête net si les tests ne passent pas — inutile d'installer un socle
cassé. `SANS_CRON=1` saute l'ajout à la crontab si tu préfères la gérer
toi-même.

Le détail de ce qu'il fait, pour le faire à la main :

### Le détail

Trois fichiers, **dans cet ordre**. Le second et le troisième dépendent du
premier.

```bash
psql -d era_loyers -f db/schema.sql
psql -d era_loyers -f db/002-file-sms.sql
psql -d era_loyers -f db/003-arbitrage.sql
```

Remplace `era_loyers` par le nom réel de ta base. Le schéma `locatif` est
créé s'il n'existe pas ; rien d'autre dans la base n'est touché.

**Vérification.** Sept tables doivent apparaître :

```sql
\dt locatif.*
```

```
 locatif | absences          | table
 locatif | candidats         | table
 locatif | creneaux_reserves | table
 locatif | file_sms          | table
 locatif | jours_feries      | table
 locatif | lots              | table
 locatif | purge_log         | table
 locatif | refus_log         | table
```

### Contrôle automatique

Sur une base **jetable**, un script vérifie d'un coup le schéma et les
requêtes des workflows :

```bash
createdb era_verif
node scripts/verifier-base.js --base era_verif
dropdb era_verif
```

Il applique les trois migrations **deux fois** (elles doivent être
rejouables), fait préparer les 21 requêtes des workflows par PostgreSQL
lui-même — ce qui valide syntaxe, noms de tables, de colonnes et types de
paramètres — puis vérifie que chaque champ écrit par les nodes correspond à
une vraie colonne. C'est ce dernier point qui attrape le mode d'échec des
nodes Postgres en « autoMapInputData » : une clé qui n'est pas une colonne
ne se voit qu'à l'exécution.

Sortie attendue :

```
OK    3 migrations, appliquées deux fois — rejouables
OK    21 requêtes de workflow préparées par PostgreSQL
OK    6 tables d'écriture, toutes les colonnes présentes
```

**Avant d'aller plus loin :** vérifie que la sauvegarde du VPS couvre bien
le schéma `locatif`. Une base perdue, ce sont les rendez-vous en cours et
les séquences SMS en vol. C'est le moment de le faire, pas après.

---

## Étape 2 — Les jours fériés

Le J+2 ouvré, la plage d'envoi et le compteur de blocage lisent tous cette
table. Sans elle, ils traitent les jours fériés comme des jours ouvrés.

```bash
./scripts/charger-jours-feries.sh | psql -d era_loyers    # sans Node
node scripts/charger-jours-feries.js | psql -d era_loyers # si Node est là
```

Le script interroge l'API Etalab (gratuite, sans clé) et produit du SQL.
Tu peux le lancer sans le tuyau pour voir ce qu'il va écrire.

La version `.sh` ne demande que `curl` et `python3`, présents sur toute
distribution : **la création de la base n'a besoin ni de Node ni de npm.**

**Vérification :**

```sql
SELECT count(*), min(jour), max(jour) FROM locatif.jours_feries;
```

Tu dois couvrir au moins l'année en cours et la suivante. À relancer une
fois par an — WF-6 t'alertera quand la table deviendra périmée.

---

## Étape 3 — La purge quotidienne

Elle tourne en cron **système**, pas dans n8n : un workflow qui ne tourne
pas est une purge qui n'a pas lieu, et personne ne s'en aperçoit avant le
contrôle.

```bash
crontab -e
```

Ajoute la ligne :

```
0 3 * * *  psql -d era_loyers -c "SELECT locatif.purger_candidats();"
```

**Vérification, le lendemain :**

```sql
SELECT * FROM locatif.purge_log ORDER BY horodatage DESC LIMIT 7;
```

Une ligne par nuit. C'est ce qui prouve que la purge tourne, en cas de
contrôle.

---

## Étape 4 — Les identifiants n8n

À créer **une seule fois**. n8n les proposera ensuite automatiquement dans
tous les workflows.

Dans n8n : **Credentials → Add credential**.

### Postgres

| Champ | Valeur |
|---|---|
| Host | `localhost` (ou l'IP du conteneur Postgres) |
| Database | `era_loyers` |
| User / Password | ceux de ta base |
| Port | `5432` |

Nomme-le `Postgres ERA`. Pas besoin de préciser le schéma : toutes les
requêtes nomment `locatif.` explicitement.

### Twilio

Account SID et Auth Token, depuis la console Twilio.

### Telegram

Il faut d'abord un bot :

1. Sur Telegram, écris à **@BotFather**
2. `/newbot`, choisis un nom et un identifiant
3. BotFather te donne un **token** — c'est lui qu'attend n8n

### Google Calendar (OAuth2) et Gmail (OAuth2)

Deux identifiants distincts, mais la même préparation :

1. [console.cloud.google.com](https://console.cloud.google.com) → nouveau projet
2. **APIs & Services → Library** : active *Google Calendar API* et *Gmail API*
3. **Credentials → Create credentials → OAuth client ID → Web application**
4. Dans n8n, ouvre le formulaire de l'identifiant : il affiche une **URL de
   redirection**. Copie-la dans le champ *Authorized redirect URIs* de Google.
5. Reporte le Client ID et le Client Secret dans n8n, puis clique
   **Connect my account**

### SMTP

Pour les mails de demande de pièces (WF-5). Serveur sortant de ta messagerie.

> **Point ouvert :** l'adresse dédiée au dépôt des pièces n'existe peut-être
> pas encore. C'est un préalable de ta checklist. Sans elle, WF-5 reste
> importable mais inutilisable.

---

## Étape 5 — Le chat Telegram

Il te faut l'identifiant de la conversation où le système t'écrira.

1. Cherche ton bot sur Telegram et envoie-lui n'importe quoi (`/start`)
2. Ouvre dans un navigateur :
   `https://api.telegram.org/bot<TON_TOKEN>/getUpdates`
3. Relève `message.chat.id` — un nombre, parfois négatif

Garde-le : c'est le `chat_id` de l'étape 7.

---

## Étape 6 — Importer les workflows

Deux voies. La première est plus rapide et supprime le relien manuel.

### Voie A — par l'API (recommandée)

Dans n8n : **Settings → API → Create an API key**. Puis, sur ta machine :

```bash
export N8N_URL=https://ton-n8n.fr
export N8N_API_KEY=...

node scripts/importer-workflows.js --essai   # montre sans rien écrire
node scripts/importer-workflows.js           # importe
```

La clé ne quitte pas ta machine : le script parle directement à ton n8n.

Il est **idempotent** : relancé, il met à jour les workflows existants au
lieu d'en créer des doublons. C'est ce qui permet de le rejouer après chaque
`npm run n8n:build`, sans repasser par l'interface.

Il **n'active rien** et **ne rattache aucun identifiant** : l'activation est
une décision, et l'API publique de n8n ne sait pas lister les identifiants
existants. Ces deux points restent à faire à la main, plus bas.

Il fait en revanche le relien de WF-7 vers WF-5, que l'import par fichier ne
sait pas faire — voir plus bas pourquoi.

### Voie B — par l'interface

**Workflows → Import from File**, un fichier à la fois.

**L'ordre compte** : WF-7 appelle WF-5, qui doit donc exister avant.

| Ordre | Fichier |
|---|---|
| 1 | `wf3-eligibilite.json` |
| 2 | `wf4-creneaux.json` |
| 3 | `wf5-demande-pieces.json` |
| 4 | `wf1-tri-boite-generale.json` |
| 5 | `wf2-sequence-demarrage.json` |
| 6 | `wf2bis-sequence-reponses.json` |
| 7 | `wf2ter-emission-sms.json` |
| 8 | `wf2quater-expiration-relance.json` |
| 9 | `wf5bis-recapitulatif-telegram.json` |
| 10 | `wf6-controle.json` |
| 11 | `wf8-arbitrages-en-attente.json` |
| 12 | `wf7-telegram-commandes.json` |

**N'active rien pour l'instant.** Les workflows importés restent inactifs
par défaut : c'est ce qu'on veut.

### Rattacher les identifiants

À l'import, les nodes Postgres, Twilio, Telegram, Google Agenda, Gmail et
SMTP affichent « Credentials not set ». Ouvre chaque node concerné et
sélectionne l'identifiant créé à l'étape 4. n8n mémorise ton choix et le
proposera par défaut ensuite.

### Un relien à faire à la main — voie B seulement

Dans **WF-7**, ouvre le node **« Lancer WF-5 »** et re-sélectionne
`ERA · WF-5 · Demande de pièces` dans la liste déroulante.

La raison : n8n référence un sous-workflow par son identifiant interne, qui
n'existe pas avant l'import. Le fichier porte le nom du workflow, ce qui
suffit à te dire lequel choisir, mais pas à établir le lien. C'est le seul
endroit du dispositif où ça se produit.

**La voie A le fait pour toi** : le script connaît l'identifiant de WF-5 au
moment où il envoie WF-7, et le substitue au nom.

---

## Étape 7 — Le node « Paramètres »

Chaque workflow commence par un node **Paramètres**. C'est le **seul** node
à modifier, et il contient les mêmes valeurs partout.

Ouvre-le, remplace les six valeurs :

```js
const PARAMETRES = {
  expediteur: '+33600000000',        // ton long code Twilio, format E.164
  chat_id: '000000000',              // relevé à l'étape 5
  agenda: 'primary',                 // ou l'identifiant de ton agenda
  mail_pieces: 'pieces@era-dupontromain.fr',
  ollama: 'http://127.0.0.1:11434/api/generate',
  modele: 'qwen2.5:3b-instruct-q4_K_M',
};
```

**À faire dans les douze workflows.** C'est fastidieux mais c'est la
contrepartie de workflows auto-porteurs : rien ne dépend d'une variable
d'environnement ni d'un volume monté.

Le plus simple : configure-le une fois, copie le node (Ctrl+C), puis
colle-le par-dessus dans chaque autre workflow.

---

## Étape 8 — Le webhook Twilio

1. Ouvre **WF-2 bis**, node **« Webhook Twilio »**
2. Copie l'**URL de production** (pas l'URL de test)
   — elle ressemble à `https://ton-n8n.fr/webhook/twilio/sms`
3. Console Twilio → **Phone Numbers → ton numéro**
4. Section *Messaging*, champ **« A MESSAGE COMES IN »** :
   colle l'URL, méthode **HTTP POST**
5. Enregistre

L'URL de production n'est active que si le workflow l'est. On y vient à
l'étape 11.

---

## Étape 9 — Ollama

Le modèle doit déjà être là :

```bash
ollama list | grep qwen2.5
```

S'il manque :

```bash
ollama pull qwen2.5:3b-instruct-q4_K_M
```

**Ne route jamais les données candidats vers un modèle en `:cloud`.** Le
suffixe signifie que l'inférence ne tourne pas sur le VPS : le texte part
chez l'hébergeur du modèle. Il faudrait alors le déclarer comme
sous-traitant. Un test du dépôt vérifie qu'aucun workflow ne pointe vers un
modèle `:cloud`.

Si tu gardes `mistral:latest` pour d'autres usages, fixe
`OLLAMA_KEEP_ALIVE=30s` pour qu'il libère la RAM au lieu de rester résident
cinq minutes après chaque appel — le VPS a 8 Go et porte déjà n8n et
Postgres.

---

## Étape 10 — Les essais, avant toute activation

Tout ce qui suit se fait **en exécution manuelle**, workflows inactifs.
Rien ne part chez personne.

### 10.1 — Le calcul d'éligibilité

Ouvre **WF-3**, node **« Dossiers d'exemple »**. Remplace les dix cas par
**vingt de tes dossiers passés**, dont tu connais l'issue. Puis
**Execute Workflow**.

Compare la colonne `verdict` à ce que tu avais décidé. Chaque écart est
soit un seuil mal calé, soit une question mal posée.

*C'est l'essai le plus rentable des trois. Tant qu'il n'est pas fait, le
taux de 37 % reste une hypothèse.*

### 10.2 — L'extraction des mails

Ouvre **WF-1**, déclencheur **« Tester l'extraction »**, node **« Mails de
test »**. Colle **trente mails réels** (objet + corps suffisent). Puis
**Execute Workflow**.

Lis le node **« Rapport d'extraction »** : une ligne par mail, avec la
référence lue, le lot trouvé, le nom, le mobile, et un verdict.

- Compare le nombre de lignes au nombre de mails collés : la différence,
  ce sont ceux écartés par le premier filtre. Un vrai mail de demande
  écarté à ce stade, c'est un mot-clé à ajouter.
- Un verdict `référence inconnue en base` sur un lot que tu sais disponible
  veut dire qu'il manque un `/lot`.

**Rien n'est écrit en base**, et le chemin emprunté est exactement celui de
la production : même filtre, même invite, même modèle.

### 10.3 — Les créneaux

Ouvre **WF-4**, node **« Lot à tester »**, mets la référence et les
coordonnées d'un lot réel. **Execute Workflow**.

Le résultat te donne les deux créneaux proposés **et le journal** : pourquoi
chaque autre demi-journée a été écartée (plafond atteint, hors rayon, ancre
non localisée). C'est là que tu vois si le seuil de 12 km te convient.

### 10.4 — Les lots

Active **WF-7** (c'est le seul à activer à ce stade — il n'envoie rien de
lui-même). Sur Telegram :

```
/lot 12345 Bompas T3 780 visale-ok
```

Vérifie en base que la commune a bien été géocodée :

```sql
SELECT reference, commune, latitude, longitude, accepte_visale
FROM locatif.lots WHERE statut = 'disponible';
```

Teste aussi une commune rurale et une commune en plusieurs mots
(« Le Soler »).

Saisis tous tes lots disponibles maintenant : sans eux, WF-1 ne peut
rattacher aucune demande.

---

## Étape 11 — Mise en service, en deux temps

### Phase 1 — le système collecte, rien ne sort

Active dans cet ordre :

| Workflow | Effet |
|---|---|
| WF-7 | commandes Telegram (déjà actif) |
| WF-6 | contrôle quotidien |
| WF-1 | trie la boîte, crée les fiches |
| WF-2 | met le premier message **en file** |
| WF-2 bis | traite les réponses entrantes |
| WF-2 quater | expiration et relance |
| WF-5 bis, WF-8 | récapitulatifs Telegram |

**Laisse WF-2 ter DÉSACTIVÉ.**

C'est l'interrupteur du dispositif : tout s'accumule dans `file_sms` et
**aucun SMS ne part**. Tu vois exactement ce que le système aurait envoyé :

```sql
SELECT cree_le, type_message, mobile, left(texte, 80)
FROM locatif.file_sms
WHERE envoye_le IS NULL
ORDER BY cree_le DESC LIMIT 20;
```

Laisse tourner quelques jours. Lis ce qui s'accumule. C'est la phase 1 de
ta checklist — « le système propose, tu valides » — sans avoir à modifier
quoi que ce soit.

### Phase 2 — l'ouverture

D'abord sur toi seul :

1. Vide la file : `DELETE FROM locatif.file_sms WHERE envoye_le IS NULL;`
2. Active **WF-2 ter**
3. Crée une fiche de test avec **ton propre numéro** :

```sql
INSERT INTO locatif.candidats (nom, mobile, email, ref_lot, source, statut)
VALUES ('TEST Romain', '+33XXXXXXXXX', 'toi@exemple.fr', '12345', 'test', 'nouveau');
```

Dans les cinq minutes tu reçois le message d'ouverture. Déroule toute la
séquence : réponds `1 3`, puis un montant, puis `0`, puis `A`.

À la fin, vérifie que l'événement est bien dans ton agenda, avec le préfixe
`VISITE —` et le bloc ImmoAgenda dans la description.

4. Recommence avec deux ou trois collègues
5. Vérifie que `STOP` désinscrit et que `CONSEILLER` te notifie sur Telegram

Puis ouvre en réel.

---

## Le quotidien, une fois en service

| Quand | Ce qui arrive |
|---|---|
| 8 h | WF-6 t'alerte **si** quelque chose cloche (purge arrêtée, file bloquée, fériés périmés). Silence = tout va bien |
| 9 h | WF-8 rappelle les arbitrages non clos, du plus ancien au plus récent |
| 18 h | WF-5 bis récapitule les nouveaux dossiers à arbitrer |
| Au fil de l'eau | une demande de rappel (`CONSEILLER`) arrive tout de suite |

Tes commandes :

```
/lot RÉF COMMUNE TYPE LOYER [visale-ok]   nouveau bien disponible
/loue RÉF                                  bien loué, sort de la liste
/traite ID                                 clôt un arbitrage
/pieces ID                                 demande de pièces au candidat retenu
/absence 2026-10-20 2026-10-27 [chat]      congés, suppléant facultatif
/retour                                    fin d'absence anticipée
/aide                                       rappel des commandes
```

`/traite` est la seule chose qui arrête les rappels de WF-8. Un dossier
qu'on oublie de clore reste bruyant — c'est voulu.

---

## Si quelque chose ne va pas

**Aucun SMS ne part.** Vérifie d'abord que WF-2 ter est actif. Puis :

```sql
SELECT id, type_message, tentatives, erreur, envoyer_apres
FROM locatif.file_sms WHERE envoye_le IS NULL ORDER BY cree_le;
```

`tentatives >= 5` : le message est abandonné, la colonne `erreur` dit
pourquoi. Rappelle-toi qu'en dehors de la plage lundi–vendredi 9 h–19 h,
rien ne part — c'est normal.

**Un candidat répond, rien ne se passe.** Le rapprochement se fait sur les
neuf derniers chiffres du numéro. Vérifie que la fiche existe et que son
statut est `nouveau` ou `en_cours` :

```sql
SELECT id, nom, mobile, etape_sms, statut, verdict
FROM locatif.candidats
WHERE right(regexp_replace(mobile, '\D', '', 'g'), 9) = '600000000';
```

Un SMS venu d'un numéro inconnu te remonte sur Telegram — il n'est jamais
perdu.

**Aucun créneau n'est proposé.** Lance WF-4 en manuel sur le même lot : le
journal dit pourquoi. Les causes fréquentes : lot sans coordonnées (le
`/lot` a échoué au géocodage), ou toutes les demi-journées hors rayon.

**Les rendez-vous ne s'écrivent pas dans l'agenda.** Vérifie l'identifiant
d'agenda dans le node Paramètres, et que l'identifiant Google est bien
connecté (le jeton OAuth peut expirer).

---

## Ce qui reste à décider avant l'ouverture réelle

Trois points que le code ne peut pas trancher :

1. **Le libellé du SMS 4a** doit être validé par le juridique ERA
2. **La page de mention d'information** doit exister à l'URL de la marque
   (variable `URL_MENTION_INFORMATION`, sinon la valeur par défaut)
3. **Le coût réel** : le message d'ouverture fait 9 segments à cause des
   accents. L'estimation du cahier des charges suppose des messages d'un
   segment. Compte les segments réels après le premier mois avant de
   t'engager sur un budget.
