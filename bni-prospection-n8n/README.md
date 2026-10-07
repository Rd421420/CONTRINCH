# Prospection visiteurs BNI — workflow n8n

Chaque **jeudi à 9h**, le workflow cherche sur Google Maps des TPE et micro-entrepreneurs
autour de Perpignan (10 km), pour les métiers **non représentés** dans le groupe.
Il récupère le site, l'email, le téléphone et le représentant légal, dédoublonne,
rédige un email d'invitation personnalisé avec Claude, l'envoie par SMTP
et consigne tout dans un Google Sheet.

```
Jeudi 9h ─► Config ─► Lire Prospects ─► Lire Métiers ─► Choisir les métiers ─┬─► Dater les métiers ─► MAJ date
                                                                             └─► Google Maps (Places API)
   ─► Filtrer candidats (distance, taille, doublons) ─► Site accueil ─► Mentions légales ─► Extraire email
   ─► Annuaire Entreprises (dirigeant, SIREN, effectif) ─► Sélection finale (TPE, max 10, réparti par métier)
   ─► Email trouvé ? ── oui ─► Préparer prompt ─► Claude ─► Préparer l'email ─► Envoi SMTP ─► Suivi Google Sheet
                     └─ non ─► ligne « A_APPELER » ───────────────────────────────────────► Suivi Google Sheet
```

## 1. Google Sheet

Créez un Google Sheet avec deux onglets, en reprenant exactement les en-têtes des fichiers modèles :

| Onglet | Modèle | Rôle |
|---|---|---|
| `Metiers` | `modele_onglet_Metiers.csv` | Un métier par ligne. `statut` = `A_RECHERCHER` ou `DANS_LE_GROUPE`. `requete_maps` = les mots tapés dans Google Maps (facultatif). `derniere_recherche` est rempli automatiquement. |
| `Prospects` | `modele_onglet_Prospects.csv` | Historique. Sert aussi au dédoublonnage : une entreprise déjà présente n'est jamais recontactée. Vous remplissez `reponse`, `venu_reunion` et `commentaire`. |

Quand un métier rejoint le groupe, passez son statut à `DANS_LE_GROUPE` : il ne sera plus recherché.
Les métiers tournent : à chaque exécution, les 5 métiers les moins récemment recherchés sont traités.

Statuts dans `Prospects` : `ENVOYE`, `A_APPELER` (pas d'email trouvé, mais un téléphone),
`ERREUR_ENVOI`, `TEST`. Mettez `NE_PLUS_CONTACTER` si quelqu'un répond STOP.

## 2. Identifiants à créer dans n8n

| Identifiant n8n | Type | Utilisé par |
|---|---|---|
| Google Sheets | *Google Sheets OAuth2* | Les 4 nœuds Google Sheets |
| Google Places | *Header Auth* — Name : `X-Goog-Api-Key`, Value : votre clé | Google Maps (Places API) |
| Anthropic | *Header Auth* — Name : `x-api-key`, Value : votre clé Claude | Claude - rédiger l'email |
| SMTP | *SMTP* (serveur, port, identifiant, mot de passe de votre boîte) | Envoyer l'email (SMTP) |

- **Clé Google Places** : console.cloud.google.com → créer un projet → activer **Places API (New)** →
  Identifiants → Clé API (restreignez-la à Places API). Un compte de facturation est obligatoire ;
  à ce volume (environ 20 recherches par mois), on reste en principe dans le quota gratuit mensuel. Vérifiez-le dans la console.
- **Clé Claude** : console.anthropic.com → API Keys. Comptez quelques centimes par email.
- **SMTP Gmail** : `smtp.gmail.com`, port 465, SSL, avec un *mot de passe d'application*
  (myaccount.google.com → Sécurité → Validation en 2 étapes → Mots de passe des applications).

## 3. Installation

1. n8n → *Workflows* → *Import from File* → `workflow_bni_prospection.json`.
2. Ouvrez chaque nœud marqué en rouge et sélectionnez l'identifiant correspondant.
3. Ouvrez le nœud **Config** et remplissez l'ID du Google Sheet, votre nom, votre activité, votre téléphone, votre email et l'adresse de test.
4. Laissez `mode_test: true`, puis cliquez sur **Lancement manuel (test)**. Tous les emails arrivent
   dans *votre* boîte, avec le vrai destinataire dans l'objet. Les lignes sont notées `TEST` et
   n'empêchent pas un vrai envoi plus tard.
5. Si le résultat vous convient, passez `mode_test: false` et **activez** le workflow.

## 4. Réglages utiles (nœud Config)

| Paramètre | Défaut | Effet |
|---|---|---|
| `max_emails_par_semaine` | 10 | Emails envoyés au maximum par exécution, répartis équitablement entre métiers |
| `max_metiers_par_semaine` | 5 | Nombre de métiers recherchés à chaque fois |
| `candidats_par_metier` | 4 | Entreprises analysées par métier |
| `rayon_km` | 10 | Rayon autour du centre de Perpignan |
| `max_avis_google` | 150 | Écarte les structures très visibles (chaînes, grosses entreprises) |
| `tranches_effectif_ok` | 0 à 9 salariés | Filtre TPE, à partir des données INSEE |

## 5. Limites à connaître

- **Email** : il est cherché sur la page d'accueil et sur `/mentions-legales`. Beaucoup de TPE n'affichent
  qu'un formulaire de contact : elles passent alors en `A_APPELER`, avec le téléphone, pour un appel direct.
- **Dirigeant** : il vient de l'API publique *Recherche d'entreprises*, avec une recherche par nom et code postal.
  Si le nom sur Google Maps diffère du nom légal, la correspondance peut échouer (champ vide) ou être
  fausse. Vérifiez la colonne `siren` en cas de doute.
- **RGPD** : la prospection B2B par email est autorisée si le message concerne l'activité professionnelle
  du destinataire. L'expéditeur doit être identifié et un moyen simple de refuser doit être proposé.
  Ces deux mentions sont ajoutées automatiquement à chaque email.
