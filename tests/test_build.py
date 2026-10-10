"""Tests de construction et des renvois locaux de la sortie statique."""
from __future__ import annotations

import shutil
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

from build import ROOT, build


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.ids = set()
        self.base = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.add(attrs["id"])
        if tag == "base":
            self.base = attrs.get("href", "")
        if tag in {"a", "link", "script"}:
            href = attrs.get("href") or attrs.get("src")
            if href:
                self.links.append(href)


class BuildTests(unittest.TestCase):
    def test_current_data_and_local_links(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "public"
            result = build(ROOT, output)
            self.assertGreater(result["measures"], 0)
            self.assertTrue((output / "static/data/simulateur.json").is_file())
            parsed = {}
            for page in output.rglob("*.html"):
                parser = Links()
                parser.feed(page.read_text(encoding="utf-8"))
                parsed[page] = parser
            errors = []
            for page, parser in parsed.items():
                for href in parser.links:
                    url = urlsplit(href)
                    if url.scheme or url.netloc or href.startswith(("mailto:", "tel:")):
                        continue
                    target = (page.parent / parser.base / unquote(url.path)).resolve() if url.path else page
                    if target.is_dir():
                        target /= "index.html"
                    if not target.is_file():
                        errors.append(f"{page.relative_to(output)} → {href} (fichier absent)")
                    elif url.fragment and target.suffix == ".html" and unquote(url.fragment) not in parsed[target].ids:
                        errors.append(f"{page.relative_to(output)} → {href} (ancre absente)")
            self.assertFalse(errors, "\n".join(errors[:30]))

    def test_unknown_reference_strict_and_lax(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("content/pages", "data/programmes/rn", "data/programmes/lfi", "data/corpus", "site_src/templates", "site_src/static"):
                (root / name).mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / "tests/fixtures/unknown-reference.md", root / "content/pages/accueil.md")
            (root / "sources").mkdir()
            (root / "sources/manifest.json").write_text("{}", encoding="utf-8")
            for template in (ROOT / "site_src/templates").glob("*.html"):
                shutil.copy2(template, root / "site_src/templates" / template.name)
            with self.assertRaisesRegex(ValueError, "Lien interne inconnu.*INCONNU"):
                build(root, root / "public")
            self.assertEqual(build(root, root / "public", lax=True)["warnings"], 1)


if __name__ == "__main__":
    unittest.main()
