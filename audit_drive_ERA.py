"""
╔══════════════════════════════════════════════════════════════════╗
║     AUDIT DOSSIER GOOGLE DRIVE — ERA PERPIGNAN                   ║
║     Compare le contenu réel à la checklist de référence          ║
╚══════════════════════════════════════════════════════════════════╝

PRÉREQUIS :
  pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client

AUTHENTIFICATION :
  Réutilise le credentials.json + token.json déjà créés pour
  create_drive_folders_ERA.py (même projet Google Cloud).

UTILISATION :
  python audit_drive_ERA.py --parent 1X-LCCEMGVz1lSepuToiKv0L4JKT8qhkK

  Options :
    --export rapport.txt    → sauvegarde le rapport dans un fichier
    --verbose               → liste aussi tous les fichiers trouvés
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
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

# Checklist de référence : ce qui DOIT être présent
# Format : nom_dossier : {"priorite": 1-3, "attendu": [mots-clés fichiers attendus], "min_fichiers": n}
CHECKLIST = {
    "01_logos": {
        "priorite": 1,
        "description": "Logos ERA officiels",
        "attendu": ["blanc", "rouge", "icone", "charte"],
        "min_fichiers": 3,
    },
    "02_habillages_reseaux": {
        "priorite": 1,
        "description": "Habillages par réseau social",
        "attendu": ["instagram", "facebook", "story", "linkedin"],
        "min_fichiers": 4,
    },
    "08_photo_agent": {
        "priorite": 1,
        "description": "Photo de Romain + agence",
        "attendu": ["romain", "profil", "agence"],
        "min_fichiers": 1,
    },
    "03_location": {
        "priorite": 2,
        "description": "Visuels ERA location",
        "attendu": ["estime", "loue", "chrono"],
        "min_fichiers": 1,
    },
    "04_gestion": {
        "priorite": 2,
        "description": "Visuels ERA gestion",
        "attendu": ["serenite", "gere"],
        "min_fichiers": 1,
    },
    "05_notoriete": {
        "priorite": 2,
        "description": "Visuels notoriété",
        "attendu": ["avis", "google", "diagnostic", "proprietaire"],
        "min_fichiers": 1,
    },
    "06_saisonnier": {
        "priorite": 3,
        "description": "Visuels saisonniers",
        "attendu": ["ete", "noel", "rentree"],
        "min_fichiers": 0,
    },
    "07_recrutement": {
        "priorite": 3,
        "description": "Visuels recrutement / Petit-déjeuner Carrière",
        "attendu": ["carriere", "talent", "dating"],
        "min_fichiers": 0,
    },
    "09_biens_photos": {
        "priorite": 3,
        "description": "Photos biens scrappées (rempli automatiquement)",
        "attendu": [],
        "min_fichiers": 0,
    },
    "10_publications_generees": {
        "priorite": 3,
        "description": "Publications générées (rempli automatiquement)",
        "attendu": [],
        "min_fichiers": 0,
    },
}

PRIORITE_LABEL = {1: "🔴 INDISPENSABLE", 2: "🟠 IMPORTANT", 3: "🟢 OPTIONNEL"}


# ─── AUTHENTIFICATION ──────────────────────────────────────────────────────────
def get_drive_service():
    creds = None
    if os.path.exists("token.json"):
        creds = Credentials.from_authorized_user_file("token.json", SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists("credentials.json"):
                print("❌ credentials.json introuvable. Récupérez-le depuis Google Cloud Console.")
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
            creds = flow.run_local_server(port=0)
        with open("token.json", "w") as token:
            token.write(creds.to_json())
    return build("drive", "v3", credentials=creds)


# ─── LISTING ───────────────────────────────────────────────────────────────────
def list_children(service, parent_id):
    """Liste les enfants directs d'un dossier (dossiers + fichiers)."""
    items = []
    page_token = None
    while True:
        query = f"'{parent_id}' in parents and trashed=false"
        response = service.files().list(
            q=query,
            fields="nextPageToken, files(id, name, mimeType)",
            pageToken=page_token,
        ).execute()
        items.extend(response.get("files", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            break
    return items


def is_folder(item):
    return item["mimeType"] == "application/vnd.google-apps.folder"


# ─── AUDIT ───────────────────────────────────────────────────────────────────
def audit(service, parent_id, verbose=False):
    report_lines = []

    def out(line=""):
        print(line)
        report_lines.append(line)

    out("\n" + "═" * 64)
    out("  AUDIT DU DOSSIER ERA_Visuels_Automatisation")
    out("═" * 64)

    # Lister les dossiers présents
    top_items = list_children(service, parent_id)
    present_folders = {it["name"]: it["id"] for it in top_items if is_folder(it)}

    out(f"\n📂 {len(present_folders)} dossiers trouvés à la racine\n")

    # Compteurs
    manquants_critiques = []
    manquants_importants = []
    vides = []
    ok = []

    # Vérifier chaque entrée de la checklist
    for folder_name, spec in sorted(CHECKLIST.items(), key=lambda x: x[1]["priorite"]):
        prio = PRIORITE_LABEL[spec["priorite"]]

        if folder_name not in present_folders:
            out(f"{prio}  ❌ DOSSIER MANQUANT : {folder_name}/")
            out(f"           └─ {spec['description']}")
            if spec["priorite"] == 1:
                manquants_critiques.append(folder_name)
            elif spec["priorite"] == 2:
                manquants_importants.append(folder_name)
            continue

        # Le dossier existe → compter les fichiers (récursif sur 1 niveau)
        folder_id = present_folders[folder_name]
        children = list_children(service, folder_id)

        # Compter les fichiers réels (hors README et sous-dossiers vides)
        all_files = []
        for child in children:
            if is_folder(child):
                sub_files = [f for f in list_children(service, child["id"]) if not is_folder(f)]
                all_files.extend(sub_files)
            elif "README" not in child["name"]:
                all_files.append(child)

        nb_files = len(all_files)
        min_req = spec["min_fichiers"]

        if nb_files == 0 and min_req > 0:
            out(f"{prio}  ⚠️  VIDE : {folder_name}/ (0 fichier, min requis : {min_req})")
            out(f"           └─ {spec['description']}")
            vides.append(folder_name)
        elif nb_files < min_req:
            out(f"{prio}  ⚠️  INCOMPLET : {folder_name}/ ({nb_files}/{min_req} fichiers)")
            vides.append(folder_name)
        else:
            status = f"✅ OK : {folder_name}/ ({nb_files} fichier{'s' if nb_files > 1 else ''})"
            out(f"{prio}  {status}")
            ok.append(folder_name)

        # Mode verbose : lister les fichiers
        if verbose and all_files:
            for f in all_files[:10]:
                out(f"           • {f['name']}")
            if len(all_files) > 10:
                out(f"           • ... et {len(all_files) - 10} autres")

    # ─── SYNTHÈSE ───
    out("\n" + "═" * 64)
    out("  SYNTHÈSE")
    out("═" * 64)

    if manquants_critiques:
        out(f"\n🔴 BLOQUANT — {len(manquants_critiques)} dossier(s) indispensable(s) manquant(s) :")
        for m in manquants_critiques:
            out(f"   • {m}/ — {CHECKLIST[m]['description']}")
        out("   → Le workflow ne peut PAS démarrer sans ces éléments.")

    if vides:
        out(f"\n⚠️  À REMPLIR — {len(vides)} dossier(s) vide(s) ou incomplet(s) :")
        for v in vides:
            out(f"   • {v}/ — {CHECKLIST[v]['description']}")

    if manquants_importants:
        out(f"\n🟠 RECOMMANDÉ — {len(manquants_importants)} dossier(s) important(s) manquant(s) :")
        for m in manquants_importants:
            out(f"   • {m}/")

    if ok:
        out(f"\n✅ PRÊT — {len(ok)} dossier(s) correctement rempli(s) :")
        out(f"   {', '.join(ok)}")

    # Verdict global
    out("\n" + "─" * 64)
    if not manquants_critiques and not [v for v in vides if CHECKLIST[v]["priorite"] == 1]:
        out("  🎉 VERDICT : Les éléments indispensables sont présents.")
        out("     Le workflow peut démarrer.")
    else:
        out("  ⏳ VERDICT : Éléments indispensables manquants.")
        out("     Compléter les dossiers 🔴 avant de lancer le workflow.")
    out("─" * 64 + "\n")

    return report_lines


# ─── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Audit du dossier Drive ERA")
    parser.add_argument("--parent", default="1X-LCCEMGVz1lSepuToiKv0L4JKT8qhkK")
    parser.add_argument("--export", help="Sauvegarde le rapport dans un fichier")
    parser.add_argument("--verbose", action="store_true", help="Liste les fichiers trouvés")
    args = parser.parse_args()

    try:
        service = get_drive_service()
    except Exception as e:
        print(f"❌ Erreur authentification : {e}")
        sys.exit(1)

    try:
        report = audit(service, args.parent, verbose=args.verbose)
    except HttpError as e:
        print(f"❌ Erreur d'accès au dossier : {e}")
        print("   Vérifiez que le compte authentifié a bien accès au dossier partagé.")
        sys.exit(1)

    if args.export:
        with open(args.export, "w", encoding="utf-8") as f:
            f.write("\n".join(report))
        print(f"📄 Rapport sauvegardé : {args.export}")


if __name__ == "__main__":
    main()
