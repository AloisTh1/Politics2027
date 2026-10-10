"""Ordre logique et repères (chapitre, section) des pages de l'édition 2025 de L'Avenir en commun."""
import json
import re
from pathlib import Path

CORPUS = Path(__file__).resolve().parent.parent / "data" / "corpus" / "lfi-aec-2025.json"
PARTS = {
    "introduction": (0, "Introduction"),
    "faire-la-revolution-citoyenne": (1, "Partie 1"),
    "l-harmonie-des-etres-humains-entre-eux": (5, "Partie 2"),
    "l-harmonie-des-etres-humains-avec-la-nature": (12, "Partie 3"),
    "ordonner-le-monde": (16, "Partie 4"),
}
# pages servies sous une URL de redirection : (chapitre, section)
REDIRECTS = {"/programme2025/s3": (1, 3), "chapitre1-3/s4": (1, 4), "chapitre1-3/s5": (1, 5)}


def locate(url: str):
    path = url.split("melenchon2027.fr")[1].rstrip("/")
    for key, (ch, sec) in REDIRECTS.items():
        if path.endswith(key):
            return ch, sec
    m = re.search(r"/chapitre(\d+)(?:/s(\d+))?$", path)
    if m:
        return int(m.group(1)), int(m.group(2) or 0)
    for slug, (ch, _) in PARTS.items():
        if path.endswith(slug):
            return ch - 0.5 if slug != "introduction" else -1, 0
    return -2, 0  # sommaire


def ordered_pages():
    doc = json.loads(CORPUS.read_text("utf-8"))
    pages = doc["pages"]
    return sorted(pages, key=lambda p: locate(p["url"]))


def label(url: str) -> str:
    ch, sec = locate(url)
    if ch == -2:
        return "Sommaire"
    if ch == -1:
        return "Introduction"
    if ch != int(ch):
        return "Ouverture de partie"
    return f"ch. {int(ch)}" + (f", § {sec}" if sec else "")
