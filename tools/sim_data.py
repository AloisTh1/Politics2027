"""Valide les YAML du simulateur et produit le JSON lu par site_src/static/js/simulateur.js.

Usage :
    .venv/Scripts/python tools/sim_data.py > simulateur.json   # JSON sur la sortie standard
    .venv/Scripts/python tools/sim_data.py --check            # validation seule

La validation échoue si :
- un groupe du barème n'a pas d'URL de source, de statut ou de date de vérification ;
- une mesure n'existe pas dans data/programmes, appartient à l'autre parti ou à une autre page ;
- une citation n'est pas retrouvée mot pour mot dans le texte de la mesure citée ;
- une hypothèse, une action ou un statut est inconnu.
`build.py` appelle `load()` : le site ne se construit donc pas avec des données invalides.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
STATUTS_MESURE = {"chiffrable", "parametres-manquants"}
STATUTS_BAREME = {"officiel", "openfisca", "derniere-valeur", "simplifie"}
NATURES = {"revenu", "prix"}
ACTIONS = {
    "tva_energie", "prix_electricite", "part_deuxieme_enfant", "ir_jeune", "complement_etudiant",
    "smic_net", "point_indice", "apl_hausse", "garantie_autonomie", "minimum_vieillesse", "supprimer_cvec",
}
TYPES_HYPOTHESE = {"pourcentage", "nombre", "choix", "booleen"}
# Groupes du barème qui doivent porter leur source : chemin dans bareme-2026.yaml.
GROUPES_SOURCES = [
    "smic", "cotisations.prive", "cotisations.fonctionnaire", "cotisations.micro_entrepreneur",
    "cotisations.retraite", "cotisations.chomage", "impot_revenu", "prestations.rsa",
    "prestations.prime_activite", "prestations.allocations_familiales", "prestations.ars",
    "prestations.apl", "prestations.aspa", "tva", "etudiants", "seuil_pauvrete", "consommation_deciles",
]


def _lire(path: Path):
    with path.open(encoding="utf-8") as flux:
        return yaml.safe_load(flux)


def _espaces(texte: str) -> str:
    return re.sub(r"\s+", " ", str(texte)).strip()


def _url_document(manifest: dict, doc: str, page: int | None, page_data: dict | None) -> str:
    if page_data and page_data.get("url"):
        return str(page_data["url"])
    fichiers = manifest.get(doc, {}).get("files", [])
    if not fichiers:
        return ""
    fichier = fichiers[0]
    url = fichier.get("url") or fichier.get("final_url") or ""
    if page and (fichier.get("content_type") == "application/pdf" or url.lower().split("?")[0].endswith(".pdf")):
        return f"{url}#page={page}"
    return url


def corpus(root: Path = ROOT) -> dict:
    """Mesures des programmes : identifiant -> {parti, doc, page, text, url}."""
    manifest = {}
    chemin_manifest = root / "sources" / "manifest.json"
    if chemin_manifest.exists():
        manifest = json.loads(chemin_manifest.read_text(encoding="utf-8"))
    mesures = {}
    for parti in ("rn", "lfi"):
        for fichier in sorted((root / "data" / "programmes" / parti).glob("*.yaml")):
            brut = _lire(fichier) or {}
            doc = brut.get("doc", fichier.stem)
            pages = {p.get("n"): p for p in brut.get("pages", [])}
            for mesure in brut.get("measures", []):
                page = mesure.get("page")
                mesures[str(mesure["id"])] = {
                    "parti": parti, "doc": doc, "page": page, "text": _espaces(mesure.get("text", "")),
                    "url": _url_document(manifest, doc, page, pages.get(page)),
                }
    return mesures


def _groupe(bareme: dict, chemin: str):
    noeud = bareme
    for cle in chemin.split("."):
        if not isinstance(noeud, dict) or cle not in noeud:
            raise ValueError(f"Barème : groupe absent « {chemin} »")
        noeud = noeud[cle]
    return noeud


def valider_bareme(bareme: dict) -> None:
    for chemin in GROUPES_SOURCES:
        groupe = _groupe(bareme, chemin)
        if not str(groupe.get("url", "")).startswith("http"):
            raise ValueError(f"Barème : « {chemin} » sans URL de source")
        if groupe.get("statut") not in STATUTS_BAREME:
            raise ValueError(f"Barème : « {chemin} » statut invalide ({groupe.get('statut')})")
        if not groupe.get("verifie_le"):
            raise ValueError(f"Barème : « {chemin} » sans date de vérification")


def _verifier_source(parti: str, identifiant: str, citation: str, references: dict, page_attendue=None) -> dict:
    reference = references.get(identifiant)
    if reference is None:
        raise ValueError(f"Mesure absente du corpus : {identifiant}")
    if reference["parti"] != parti:
        raise ValueError(f"Mesure {identifiant} : parti différent ({reference['parti']})")
    if page_attendue is not None and page_attendue != reference["page"]:
        raise ValueError(f"Mesure {identifiant} : page {page_attendue} au lieu de {reference['page']}")
    if not citation or _espaces(citation) not in reference["text"]:
        raise ValueError(f"Citation non retrouvée dans {identifiant} : « {citation} »")
    return {"id": identifiant, "doc": reference["doc"], "page": reference["page"], "url": reference["url"],
            "citation": _espaces(citation)}


def valider_mesures(donnees: dict, references: dict) -> list:
    hypotheses = donnees.get("hypotheses") or {}
    for cle, h in hypotheses.items():
        if h.get("type") not in TYPES_HYPOTHESE:
            raise ValueError(f"Hypothèse {cle} : type invalide")
        if not h.get("libelle") or "defaut" not in h:
            raise ValueError(f"Hypothèse {cle} : libellé et valeur par défaut requis")
        if h["type"] in {"pourcentage", "nombre"} and not h["min"] <= h["defaut"] <= h["max"]:
            raise ValueError(f"Hypothèse {cle} : valeur par défaut hors bornes")
        if h["type"] == "choix" and h["defaut"] not in [c[0] for c in h["choix"]]:
            raise ValueError(f"Hypothèse {cle} : valeur par défaut hors choix")
    principaux = [str(m["id"]) for m in donnees["mesures"]]
    if len(principaux) != len(set(principaux)):
        raise ValueError("Identifiant de mesure répété")
    resultat = []
    for m in donnees["mesures"]:
        identifiant = str(m["id"])
        if m.get("statut") not in STATUTS_MESURE:
            raise ValueError(f"Statut invalide : {identifiant}")
        if m.get("parti") not in {"rn", "lfi"}:
            raise ValueError(f"Parti invalide : {identifiant}")
        source = _verifier_source(m["parti"], identifiant, m.get("source", {}).get("citation", ""), references,
                                  m.get("source", {}).get("page"))
        autres = []
        for extra in m.get("autres_sources", []) or []:
            if str(extra["id"]) in principaux and not extra.get("renvoi"):
                raise ValueError(f"{identifiant} : {extra['id']} figure aussi comme mesure à part (doublon compté deux fois)")
            autres.append(_verifier_source(m["parti"], str(extra["id"]), extra.get("citation", ""), references))
        if m["statut"] == "chiffrable":
            if m.get("action") not in ACTIONS:
                raise ValueError(f"Action inconnue : {identifiant}")
            if m.get("nature") not in NATURES:
                raise ValueError(f"Nature invalide : {identifiant}")
            if not m.get("parametres"):
                raise ValueError(f"Mesure chiffrable sans paramètres : {identifiant}")
            ids_sources = {identifiant} | {a["id"] for a in autres}
            for nom, origine in (m.get("parametres_sources") or {}).items():
                if nom not in m["parametres"] or origine not in ids_sources:
                    raise ValueError(f"{identifiant} : provenance du paramètre {nom} inconnue")
            manquants = set(m["parametres"]) - set(m.get("parametres_sources") or {})
            if manquants:
                raise ValueError(f"{identifiant} : paramètres sans provenance {sorted(manquants)}")
            for cle in m.get("hypotheses") or []:
                if cle not in hypotheses:
                    raise ValueError(f"{identifiant} : hypothèse inconnue {cle}")
        elif not m.get("manque"):
            raise ValueError(f"Mesure sans motif de non-chiffrage : {identifiant}")
        sortie = {k: v for k, v in m.items() if k not in {"source", "autres_sources"}}
        sortie["id"] = identifiant
        sortie["source"] = source
        sortie["autres_sources"] = autres
        resultat.append(sortie)
    return resultat


def load(root: Path = ROOT) -> dict:
    """Charge, valide et assemble les données du simulateur."""
    dossier = root / "data" / "simulateur"
    bareme = _lire(dossier / "bareme-2026.yaml")
    donnees = _lire(dossier / "mesures.yaml")
    valider_bareme(bareme)
    mesures = valider_mesures(donnees, corpus(root))
    return {
        "version": 1,
        "date_reference": str(bareme.get("date_reference")),
        "bareme": bareme,
        "hypotheses": donnees.get("hypotheses") or {},
        "hypotheses_generales": donnees.get("hypotheses_generales") or [],
        "mesures": mesures,
    }


def ecrire_json(donnees: dict, cible) -> None:
    json.dump(donnees, cible, ensure_ascii=False, separators=(",", ":"), default=str)
    cible.write("\n")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        resultat = load()
    except ValueError as erreur:
        sys.exit(f"Données du simulateur invalides : {erreur}")
    if "--check" in sys.argv:
        total = len(resultat["mesures"])
        chiffrables = sum(1 for m in resultat["mesures"] if m["statut"] == "chiffrable")
        print(f"OK : {total} mesures dont {chiffrables} chiffrables")
    else:
        ecrire_json(resultat, sys.stdout)
