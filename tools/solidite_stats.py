"""Comptages reproductibles pour la grille de solidité.

Exécution : .venv/Scripts/python.exe tools/solidite_stats.py
Les trois indicateurs sont des repérages lexicaux, pas une validation des mesures.
Une mesure est comptée une seule fois par indicateur, même si plusieurs motifs concordent.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
CENTRAL = {
    "rn": "rn/rn-programme-2024.yaml",
    "lfi": "lfi/lfi-aec-2025.yaml",
}

# « Paramètre numérique » : nombre autre qu'une année seule. Un chiffre dans
# un titre ou une justification n'est pas compté : seuls text et detail le sont.
NUMBER = re.compile(r"(?<![\w])\d[\d\s.,]*(?:%|€|euros?\b|ans?\b|mois\b|jours?\b|heures?\b|produits?\b|postes?\b|places?\b|trimestres?\b|milliards?\b|millions?\b|e\b)?", re.I)
YEAR = re.compile(r"\b20(?:2[4-9]|3\d)\b")
TIME = re.compile(r"\b(?:dès|avant|après|d'ici|en\s+\d+\s+ans|à\s+partir\s+de|première\s+année|premiers?\s+mois)\b", re.I)
VEHICLE = re.compile(r"\b(?:loi|lois|décret|décrets|ordonnance|ordonnances|circulaire|circulaires|référendum|constituante|révision constitutionnelle|projet de loi|proposition de loi)\b", re.I)


def load(path: Path) -> list[dict]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))["measures"]


def text_of(measure: dict) -> str:
    return " ".join(str(measure.get(k, "")) for k in ("text", "detail"))


def numeric(text: str) -> bool:
    return any(not YEAR.fullmatch(match.group().strip()) for match in NUMBER.finditer(text))


def count(measures: list[dict]) -> dict:
    result = {
        "total": len(measures),
        "parametre_numerique": sum(numeric(text_of(m)) for m in measures),
        "repere_temporel": sum(bool(YEAR.search(text_of(m)) or TIME.search(text_of(m))) for m in measures),
        "vehicule_juridique_explicite": sum(bool(VEHICLE.search(text_of(m))) for m in measures),
        "detail_editorial": sum(bool(m.get("detail")) for m in measures),
        "montant_structure": sum("montant" in m for m in measures),
    }
    result["parts_pct"] = {
        key: round(100 * value / result["total"], 1)
        for key, value in result.items()
        if key != "total"
    }
    return result


def main() -> None:
    result = {party: count(load(ROOT / "data/programmes" / path)) for party, path in CENTRAL.items()}
    result["rn_contre_budget_2026"] = count(load(ROOT / "data/programmes/rn/rn-contre-budget-2026.yaml"))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
