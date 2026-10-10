"""Découpe chaque document téléchargé en pages lisibles : data/corpus/<id>.json.

PDF  -> une entrée par page imprimée (texte brut, `pdftotext -layout` page par page).
HTML -> une entrée par page web, avec la suite ordonnée des blocs (titres, paragraphes,
        éléments de liste) du contenu principal, sans menus ni pieds de page.

    python -m pipeline.extract [--only ID ...]
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

from bs4 import BeautifulSoup

from pipeline.fetch import MANIFEST, ROOT, load_sources

CORPUS = ROOT / "data" / "corpus"
BLOCK_TAGS = {"h1", "h2", "h3", "h4", "h5", "p", "li", "blockquote"}
WS = re.compile(r"\s+")


def pdf_pages(path: Path) -> list[dict]:
    info = subprocess.run(["pdfinfo", str(path)], capture_output=True, text=True, check=True).stdout
    count = int(re.search(r"^Pages:\s+(\d+)", info, re.M).group(1))
    pages = []
    for n in range(1, count + 1):
        text = subprocess.run(
            ["pdftotext", "-layout", "-f", str(n), "-l", str(n), str(path), "-"],
            capture_output=True, text=True, check=True,
        ).stdout
        pages.append({"n": n, "text": text.rstrip(), "chars": len(text.strip())})
    return pages


def main_node(soup: BeautifulSoup):
    for tag in soup(["script", "style", "noscript", "form", "nav", "header", "footer", "aside", "svg"]):
        tag.decompose()
    for selector in ("article", "main", ".entry-content", "#content", "body"):
        node = soup.select_one(selector)
        if node and len(node.get_text(strip=True)) > 200:
            return node
    return soup


def html_blocks(path: Path) -> tuple[str, list[dict]]:
    soup = BeautifulSoup(path.read_bytes(), "html.parser")
    title = WS.sub(" ", soup.title.get_text()).strip() if soup.title else ""
    blocks, last = [], None
    for el in main_node(soup).find_all(BLOCK_TAGS):
        # un <li> qui contient lui-même des <p> serait compté deux fois
        if el.name == "p" and el.find_parent("li"):
            continue
        text = WS.sub(" ", el.get_text(" ")).strip()
        if not text or text == last:
            continue
        blocks.append({"type": el.name, "text": text})
        last = text
    return title, blocks


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text("utf-8"))
    CORPUS.mkdir(parents=True, exist_ok=True)
    for doc in load_sources():
        if args.only and doc["id"] not in args.only:
            continue
        entry = manifest.get(doc["id"])
        if not entry:
            continue
        pages = []
        for f in entry["files"]:
            if "path" not in f:
                continue
            path = ROOT / f["path"]
            if path.suffix.lower() == ".pdf":
                pages.extend(pdf_pages(path))
            else:
                title, blocks = html_blocks(path)
                pages.append({
                    "n": len(pages) + 1,
                    "url": f["final_url"],
                    "title": title,
                    "blocks": blocks,
                    "chars": sum(len(b["text"]) for b in blocks),
                })
        out = {
            "id": doc["id"],
            "party": doc["party"],
            "title": doc["title"],
            "retrieved_at": entry["retrieved_at"],
            "pages": pages,
        }
        (CORPUS / f"{doc['id']}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
        print(f"{doc['id']}: {len(pages)} pages, {sum(p['chars'] for p in pages):,} caractères")


if __name__ == "__main__":
    main()
