"""Génère le site statique Au crible 2027 dans public/."""
from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote

import markdown
import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape

from tools.sim_data import ecrire_json, load as load_simulator


ROOT = Path(__file__).resolve().parent
LINK = re.compile(r"\[\[([^\]]+)\]\]")
PARTIES = {"rn": "Rassemblement national", "lfi": "La France insoumise"}
KIND_PAGES = {"vote": "votes.html", "eval": "evaluations.html", "decl": "declarations.html", "contra": "contradictions.html"}


def read_yaml(path: Path, default=None):
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as stream:
        return yaml.safe_load(stream) or default


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def source_url(manifest: dict, doc: str, page=None, page_data=None) -> str:
    if page_data and page_data.get("url"):
        return str(page_data["url"])
    files = manifest.get(doc, {}).get("files", [])
    if not files:
        return ""
    file = files[0]
    url = file.get("url") or file.get("final_url") or ""
    if page and (file.get("content_type") == "application/pdf" or url.lower().split("?")[0].endswith(".pdf")):
        return f"{url}#page={page}"
    return url


def prepare(root: Path, lax: bool):
    manifest = read_json(root / "sources/manifest.json", {})
    corpus = {p.stem: read_json(p, {}) for p in (root / "data/corpus").glob("*.json")}
    docs = {party: [] for party in PARTIES}
    measures = {}
    themes = defaultdict(lambda: {"rn": [], "lfi": []})
    for party in PARTIES:
        for path in sorted((root / "data/programmes" / party).glob("*.yaml")):
            raw = read_yaml(path, {})
            doc_id = raw.get("doc", path.stem)
            pages = []
            for entry in raw.get("pages", []):
                page = dict(entry)
                page["measures"] = []
                page["source_url"] = source_url(manifest, doc_id, page.get("n"), page)
                pages.append(page)
            page_map = {p["n"]: p for p in pages}
            for measure in raw.get("measures", []):
                item = dict(measure)
                ident = str(item["id"])
                if ident in measures:
                    raise ValueError(f"Identifiant de mesure en double : {ident} ({path})")
                page = page_map.get(item.get("page"))
                if page is None:
                    raise ValueError(f"Page absente pour {ident} dans {path}")
                item.update(party=party, doc=doc_id, source_url=page["source_url"], href=f"programme-{party}.html#{quote(ident)}")
                page["measures"].append(item)
                measures[ident] = item
                for theme in item.get("themes", []):
                    themes[str(theme)][party].append(item)
            title = corpus.get(doc_id, {}).get("title") or doc_id.replace("-", " ")
            docs[party].append({"id": doc_id, "title": title, "pages": pages, "source_url": source_url(manifest, doc_id), "count": sum(len(p["measures"]) for p in pages)})

    collections = {
        "vote": read_yaml(root / "research/votes.yaml", []) or [],
        "eval": read_yaml(root / "research/evaluations.yaml", []) or [],
        "decl": read_yaml(root / "research/declarations.yaml", []) or [],
        "contra": read_yaml(root / "content/contradictions.yaml", []) or [],
    }
    entries = {}
    for kind, values in collections.items():
        if not isinstance(values, list):
            raise ValueError(f"{kind} : une liste est attendue")
        entries[kind] = {str(v["id"]): v for v in values}
        if len(entries[kind]) != len(values):
            raise ValueError(f"{kind} : identifiant d'entrée en double")
    warnings = []

    def expand(text, origin="texte"):
        def replace(match):
            ident = match.group(1)
            if ":" in ident:
                kind, key = ident.split(":", 1)
                target = entries.get(kind, {}).get(key)
                if target is not None:
                    label = target.get("titre") or target.get("sujet") or target.get("id") or key
                    return f'<a href="{KIND_PAGES[kind]}#{quote(key)}" title="{html.escape(str(label), quote=True)}">{html.escape(key)}</a>'
            else:
                target = measures.get(ident)
                if target is not None:
                    tip = html.escape(str(target.get("text", "")), quote=True)
                    return f'<a href="{target["href"]}" title="{tip}">{html.escape(ident)}</a>'
            message = f"Lien interne inconnu [[{ident}]] dans {origin}"
            if not lax:
                raise ValueError(message)
            warnings.append(message)
            return html.escape(match.group(0))
        return LINK.sub(replace, str(text or ""))

    def render_markdown(text, origin="texte"):
        return markdown.markdown(expand(text, origin), extensions=["extra", "sane_lists"])

    for kind, values in collections.items():
        for value in values:
            for ident in value.get("mesures", []) or []:
                if ident not in measures:
                    message = f"Mesure inconnue {ident} dans {kind}:{value['id']}"
                    if not lax:
                        raise ValueError(message)
                    warnings.append(message)

    return manifest, docs, measures, themes, collections, warnings, render_markdown


def build(root: Path = ROOT, output: Path | None = None, lax: bool = False) -> dict:
    output = output or root / "public"
    manifest, docs, measures, themes, collections, warnings, md = prepare(root, lax)
    env = Environment(loader=FileSystemLoader(root / "site_src/templates"), autoescape=select_autoescape(["html"]), trim_blocks=True, lstrip_blocks=True)
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    shutil.copytree(root / "site_src/static", output / "static")
    # Données du simulateur : validées (citations, pages, sources du barème) puis écrites en JSON pour le navigateur.
    if (root / "data/simulateur/bareme-2026.yaml").exists() and (root / "data/simulateur/mesures.yaml").exists():
        target = output / "static/data/simulateur.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8") as stream:
            ecrire_json(load_simulator(root), stream)
    nav = [("index.html", "Accueil"), ("methode.html", "Méthode"), ("programme-rn.html", "RN"), ("programme-lfi.html", "LFI"), ("themes.html", "Thèmes"), ("analyses.html", "Analyses"), ("contradictions.html", "Contradictions"), ("solidite.html", "Solidité"), ("votes.html", "Votes"), ("evaluations.html", "Évaluations"), ("declarations.html", "Déclarations"), ("simulateur.html", "Simulateur"), ("sources.html", "Sources et outils")]

    def write(filename, template="page.html", **data):
        rendered = env.get_template(template).render(nav=nav, current=filename, **data)
        target = output / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(rendered, encoding="utf-8")

    for slug, title in (("accueil", "Accueil"), ("methode", "Méthode"), ("avertissements", "Avertissements")):
        path = root / "content/pages" / f"{slug}.md"
        write("index.html" if slug == "accueil" else f"{slug}.html", title=title, body=md(path.read_text(encoding="utf-8") if path.exists() else "En préparation.", str(path)), intro=slug == "accueil")

    all_themes = sorted(themes)
    for party in PARTIES:
        write(f"programme-{party}.html", "programme.html", title=f"Programme — {PARTIES[party]}", party=party, party_name=PARTIES[party], docs=docs[party], themes=all_themes)

    summaries = read_yaml(root / "content/themes.yaml", None)
    theme_rows = []
    if isinstance(summaries, list):
        for item in summaries:
            key = str(item.get("theme", ""))
            theme_rows.append({"id": key, "label": item.get("libelle") or key.replace("-", " ").capitalize(), "rn": md(item.get("rn", ""), f"themes:{key}:rn"), "lfi": md(item.get("lfi", ""), f"themes:{key}:lfi"), "fallback": False})
    else:
        for key in all_themes:
            theme_rows.append({"id": key, "label": key.replace("-", " ").capitalize(), "rn": themes[key]["rn"], "lfi": themes[key]["lfi"], "fallback": True})
    write("themes.html", "themes.html", title="Thèmes", rows=theme_rows, missing=not theme_rows)

    analyses = []
    for path in (root / "content/analyses").glob("*.md"):
        content = path.read_text(encoding="utf-8")
        front = {}
        if content.startswith("---\n"):
            _, head, content = content.split("---", 2)
            front = yaml.safe_load(head) or {}
        analyses.append({"slug": path.stem, "title": front.get("titre") or path.stem.replace("-", " ").capitalize(), "order": front.get("ordre", 999), "body": md(content, str(path))})
    analyses.sort(key=lambda a: (a["order"], a["title"]))
    write("analyses.html", "analyses.html", title="Analyses", analyses=analyses)
    for article in analyses:
        write(f"analyses/{article['slug']}.html", title=article["title"], body=article["body"], root_prefix="../")

    contradictions = []
    doc_pages = {doc["id"]: {p["n"]: p for p in doc["pages"]} for party_docs in docs.values() for doc in party_docs}
    for item in collections["contra"]:
        entry = dict(item)
        entry["explication_html"] = md(item.get("explication", ""), f"contra:{item['id']}")
        for side in ("a", "b"):
            citation = dict(item.get(side) or {})
            references = [key for key in ("doc", "vote", "decl") if citation.get(key)]
            if len(references) != 1 or (side == "a" and references != ["doc"]):
                raise ValueError(f"contra:{item['id']}:{side} : source doc, vote ou decl attendue")
            if "doc" in references:
                if citation.get("page") not in doc_pages.get(citation["doc"], {}):
                    raise ValueError(f"contra:{item['id']}:{side} : page de document inconnue")
                page_data = doc_pages[citation["doc"]][citation["page"]]
                citation["source_url"] = source_url(manifest, citation["doc"], citation["page"], page_data)
                citation["source_label"] = f"Page {citation['page']}"
            elif "vote" in references:
                vote = next((v for v in collections["vote"] if str(v["id"]) == str(citation["vote"])), None)
                if vote is None:
                    raise ValueError(f"contra:{item['id']}:{side} : vote inconnu")
                citation["source_url"] = vote["scrutin"]["url"]
                citation["source_label"] = f"Scrutin {vote['scrutin']['legislature']}/{vote['scrutin']['numero']}"
                citation["detail_url"] = f"votes.html#{quote(str(vote['id']))}"
            else:
                declaration = next((d for d in collections["decl"] if str(d["id"]) == str(citation["decl"])), None)
                if declaration is None:
                    raise ValueError(f"contra:{item['id']}:{side} : déclaration inconnue")
                citation["source_url"] = declaration["url"]
                citation["source_label"] = f"Déclaration du {declaration['date']}"
                citation["detail_url"] = f"declarations.html#{quote(str(declaration['id']))}"
            entry[side] = citation
        contradictions.append(entry)
    rank = {"majeure": 0, "importante": 1, "mineure": 2}
    contradictions.sort(key=lambda entry: rank.get(entry.get("gravite"), 3))
    write("contradictions.html", "contradictions.html", title="Contradictions", entries=contradictions)

    solidite = read_yaml(root / "content/solidite.yaml", {}) or {}
    criteria = solidite.get("criteres", [])
    notes = solidite.get("notes", {})
    for party in PARTIES:
        for key, value in (notes.get(party) or {}).items():
            if isinstance(value, dict):
                value["justification_html"] = md(value.get("justification", ""), f"solidite:{party}:{key}")
    write("solidite.html", "solidite.html", title="Solidité", criteria=criteria, notes=notes)

    for kind, filename, title in (("vote", "votes.html", "Votes"), ("eval", "evaluations.html", "Évaluations"), ("decl", "declarations.html", "Déclarations")):
        rows = []
        for item in collections[kind]:
            entry = dict(item)
            if kind == "vote":
                entry["coherence_html"] = {
                    party: md(detail.get("note", ""), f"vote:{item['id']}:coherence:{party}")
                    for party, detail in (item.get("coherence") or {}).items()
                }
            for field in ("note", "conclusions", "perimetre"):
                if field in entry:
                    value = entry[field]
                    entry[field + "_html"] = md("\n\n".join(value) if isinstance(value, list) else value, f"{kind}:{item['id']}:{field}")
            rows.append(entry)
        write(filename, "research.html", title=title, kind=kind, entries=rows, measures=measures)

    write("simulateur.html", "simulateur.html", title="Simulateur")
    tools_data = read_yaml(root / "content/outils.yaml", {}) or {}
    sources = []
    for doc_id, value in sorted(manifest.items()):
        sources.append({"id": doc_id, "retrieved_at": value.get("retrieved_at", ""), "files": value.get("files", [])})
    write("sources.html", "sources.html", title="Sources et outils", sources=sources, tools=tools_data.get("outils", []), exclusions=tools_data.get("exclusions", []))
    for warning in warnings:
        print(f"Avertissement : {warning}", file=sys.stderr)
    return {"pages": len(list(output.rglob("*.html"))), "measures": len(measures), "warnings": len(warnings)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lax", action="store_true", help="Avertir pour les liens [[...]] inconnus au lieu d'échouer")
    parser.add_argument("--output", type=Path, default=ROOT / "public")
    args = parser.parse_args()
    try:
        result = build(output=args.output, lax=args.lax)
    except (ValueError, yaml.YAMLError) as exc:
        parser.exit(1, f"Erreur de construction : {exc}\n")
    print(f"{result['pages']} pages, {result['measures']} mesures, {result['warnings']} avertissement(s) -> {args.output}")


if __name__ == "__main__":
    main()
