"""
╔══════════════════════════════════════════════════════════════════╗
║     CRÉATION STRUCTURE DOSSIERS GOOGLE DRIVE — ERA PERPIGNAN     ║
║     À exécuter via Claude Code une seule fois                    ║
╚══════════════════════════════════════════════════════════════════╝

PRÉREQUIS :
  pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client

AUTHENTIFICATION :
  1. Aller sur https://console.cloud.google.com
  2. Créer un projet → Activer "Google Drive API"
  3. Créer des identifiants OAuth 2.0 (type : Application de bureau)
  4. Télécharger le fichier credentials.json dans le même dossier que ce script

UTILISATION :
  python create_drive_folders_ERA.py --parent 1X-LCCEMGVz1lSepuToiKv0L4JKT8qhkK
"""

import os
import sys
import argparse
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# ─── CONFIGURATION ────────────────────────────────────────────────────────────
SCOPES = ["https://www.googleapis.com/auth/drive"]

# Structure complète des dossiers à créer
# Format : (nom_dossier, [sous_dossiers])
FOLDER_STRUCTURE = [
    ("01_logos", [
        "horizontal_fond_blanc",
        "horizontal_fond_rouge",
        "icone_carre",
        "charte_graphique",
    ]),
    ("02_habillages_reseaux", [
        "instagram_post_1x1",
        "instagram_story_9x16",
        "facebook_post",
        "facebook_cover",
        "linkedin",
        "tiktok_9x16",
        "gmb",
    ]),
    ("03_location", [
        "bien_estime_tampon",
        "bien_estime_bien_loue",
        "estimation_chrono",
    ]),
    ("04_gestion", [
        "louez_en_toute_serenite",
        "bien_gere_tampon",
    ]),
    ("05_notoriete", [
        "avis_google",
        "diagnostics",
        "nous_proprietaires",
        "100_connecte",
    ]),
    ("06_saisonnier", [
        "ete",
        "rentree",
        "noel",
        "halloween",
        "saint_valentin",
        "paques",
        "fete_des_meres",
        "fete_des_peres",
    ]),
    ("07_recrutement", [
        "petit_dejeuner_carriere",
        "futurs_talents",
        "job_dating",
    ]),
    ("08_photo_agent", [
        "profil_romain_dupont",
        "photos_agence",
        "photos_terrain",
    ]),
    ("09_biens_photos", [
        "location_en_cours",
        "vente_en_cours",
        "archives",
    ]),
    ("10_publications_generees", [
        "a_valider",
        "valides",
        "publies",
        "archives",
    ]),
]

# ─── AUTHENTIFICATION ──────────────────────────────────────────────────────────
def get_drive_service():
    """Authentification Google Drive et retour du service."""
    creds = None
    token_path = "token.json"
    creds_path = "credentials.json"

    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(creds_path):
                print("❌ Fichier credentials.json introuvable.")
                print("   → Téléchargez-le depuis Google Cloud Console.")
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(creds_path, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(token_path, "w") as token:
            token.write(creds.to_json())

    return build("drive", "v3", credentials=creds)


# ─── CRÉATION DE DOSSIER ───────────────────────────────────────────────────────
def create_folder(service, name: str, parent_id: str) -> str:
    """Crée un dossier dans Drive et retourne son ID."""
    # Vérifier si le dossier existe déjà
    query = (
        f"name='{name}' and "
        f"'{parent_id}' in parents and "
        f"mimeType='application/vnd.google-apps.folder' and "
        f"trashed=false"
    )
    results = service.files().list(q=query, fields="files(id, name)").execute()
    existing = results.get("files", [])

    if existing:
        folder_id = existing[0]["id"]
        print(f"  ⏭  Existe déjà : {name} (id: {folder_id[:20]}...)")
        return folder_id

    # Créer le dossier
    metadata = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }
    folder = service.files().create(body=metadata, fields="id").execute()
    folder_id = folder.get("id")
    print(f"  ✅ Créé : {name} (id: {folder_id[:20]}...)")
    return folder_id


# ─── CRÉATION DU FICHIER README ───────────────────────────────────────────────
def create_readme(service, parent_id: str, folder_name: str, description: str):
    """Crée un fichier README Google Docs dans le dossier."""
    readme_descriptions = {
        "01_logos": "Logos ERA officiels. Utiliser la version fond blanc pour les fonds clairs, fond rouge pour les fonds sombres.",
        "02_habillages_reseaux": "Templates et habillages par réseau social. Respecter les dimensions indiquées dans le nom du sous-dossier.",
        "03_location": "Visuels ERA dédiés aux biens à la location. Téléchargés depuis TeamERA > LOCATION.",
        "04_gestion": "Visuels ERA pour la gestion locative. Téléchargés depuis TeamERA > GESTION.",
        "05_notoriete": "Visuels de notoriété ERA. Téléchargés depuis TeamERA > NOTORIETE.",
        "06_saisonnier": "Visuels saisonniers ERA par période. Téléchargés depuis TeamERA > SAISONNIER.",
        "07_recrutement": "Visuels pour le recrutement et le Petit-déjeuner Carrière.",
        "08_photo_agent": "Photos de Romain Dupont et de l'agence. Format minimum 400x400px, fond neutre.",
        "09_biens_photos": "Photos des biens scrappées depuis le site ERA. Organisation par statut.",
        "10_publications_generees": "Publications générées par Claude Code en attente de validation ou archivées.",
    }

    content = f"# {folder_name}\n\n{readme_descriptions.get(folder_name, description)}\n\n---\nGénéré automatiquement par ERA Social Media Automation"

    file_metadata = {
        "name": "README — LIRE EN PREMIER",
        "mimeType": "application/vnd.google-apps.document",
        "parents": [parent_id],
    }
    from googleapiclient.http import MediaInMemoryUpload
    media = MediaInMemoryUpload(
        content.encode("utf-8"),
        mimetype="text/plain",
        resumable=False,
    )
    service.files().create(
        body=file_metadata,
        media_body=media,
        fields="id",
    ).execute()


# ─── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Crée la structure Drive ERA Perpignan")
    parser.add_argument(
        "--parent",
        default="1X-LCCEMGVz1lSepuToiKv0L4JKT8qhkK",
        help="ID du dossier parent Google Drive",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Affiche la structure sans créer les dossiers",
    )
    args = parser.parse_args()

    parent_id = args.parent

    if args.dry_run:
        print("\n📋 STRUCTURE QUI SERA CRÉÉE (dry-run) :\n")
        for folder, subfolders in FOLDER_STRUCTURE:
            print(f"  📁 {folder}/")
            for sub in subfolders:
                print(f"      📂 {sub}/")
        print(f"\nTotal : {len(FOLDER_STRUCTURE)} dossiers principaux, "
              f"{sum(len(s) for _, s in FOLDER_STRUCTURE)} sous-dossiers")
        return

    print("\n🚀 CRÉATION DE LA STRUCTURE DRIVE — ERA PERPIGNAN\n")
    print(f"Dossier parent ID : {parent_id}\n")

    try:
        service = get_drive_service()
    except Exception as e:
        print(f"❌ Erreur authentification : {e}")
        sys.exit(1)

    created = {"folders": 0, "subfolders": 0}
    folder_ids = {}

    for folder_name, subfolders in FOLDER_STRUCTURE:
        print(f"\n📁 {folder_name}")
        try:
            folder_id = create_folder(service, folder_name, parent_id)
            folder_ids[folder_name] = folder_id
            created["folders"] += 1

            # Créer les sous-dossiers
            for subfolder_name in subfolders:
                try:
                    sub_id = create_folder(service, subfolder_name, folder_id)
                    created["subfolders"] += 1
                except HttpError as e:
                    print(f"  ⚠️  Erreur sous-dossier {subfolder_name} : {e}")

        except HttpError as e:
            print(f"⚠️  Erreur dossier {folder_name} : {e}")

    # Résumé final
    print("\n" + "═" * 60)
    print(f"✅ TERMINÉ — {created['folders']} dossiers, {created['subfolders']} sous-dossiers créés")
    print("\n📌 IDs des dossiers principaux (à copier dans settings.json) :\n")
    for name, fid in folder_ids.items():
        print(f"  \"{name}\": \"{fid}\"")

    print("\n📂 Ouvrir le Drive : https://drive.google.com/drive/folders/" + parent_id)
    print("═" * 60)


if __name__ == "__main__":
    main()
