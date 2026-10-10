"""Tests du simulateur : validation des données (Python) et moteur de calcul (Node, tests/simulateur.test.mjs)."""
from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from tools import sim_data

ROOT = Path(__file__).resolve().parents[1]


class DonneesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.donnees = sim_data.load(ROOT)

    def test_chaque_parti_a_des_mesures_chiffrables_et_non_chiffrables(self):
        for parti in ("rn", "lfi"):
            mesures = [m for m in self.donnees["mesures"] if m["parti"] == parti]
            self.assertTrue(any(m["statut"] == "chiffrable" for m in mesures), parti)
            self.assertTrue(any(m["statut"] == "parametres-manquants" for m in mesures), parti)

    def test_citations_pages_et_urls_retrouvees(self):
        for m in self.donnees["mesures"]:
            self.assertGreater(m["source"]["page"], 0, m["id"])
            self.assertTrue(m["source"]["url"].startswith("http"), m["id"])
            for autre in m["autres_sources"]:
                self.assertTrue(autre["url"].startswith("http"), autre["id"])

    def test_aucun_texte_corrompu(self):
        for m in self.donnees["mesures"]:
            for champ in ("libelle", "manque", "condition_non_saisie"):
                self.assertNotIn("?", m.get(champ) or "", f"{m['id']} {champ}")
                self.assertNotIn("�", m.get(champ) or "", f"{m['id']} {champ}")

    def test_mesures_chiffrables_completes(self):
        for m in self.donnees["mesures"]:
            if m["statut"] != "chiffrable":
                continue
            self.assertIn(m["action"], sim_data.ACTIONS)
            self.assertEqual(set(m["parametres"]), set(m["parametres_sources"]), m["id"])
            self.assertTrue(m["hypotheses_fixes"], f"{m['id']} : hypothèses fixes à afficher")
            for cle in m["hypotheses"]:
                self.assertIn(cle, self.donnees["hypotheses"])

    def test_chaque_groupe_du_bareme_a_une_source(self):
        sim_data.valider_bareme(self.donnees["bareme"])
        mauvais = copy.deepcopy(self.donnees["bareme"])
        del mauvais["prestations"]["rsa"]["url"]
        with self.assertRaisesRegex(ValueError, "sans URL"):
            sim_data.valider_bareme(mauvais)

    def test_citation_inventee_refusee(self):
        references = sim_data.corpus(ROOT)
        donnees = {"hypotheses": {}, "mesures": [{
            "id": "RN24-087", "parti": "rn", "libelle": "x", "statut": "parametres-manquants", "manque": "x",
            "source": {"citation": "Supprimer tous les impôts pour tout le monde"}}]}
        with self.assertRaisesRegex(ValueError, "Citation non retrouvée"):
            sim_data.valider_mesures(donnees, references)
        donnees["mesures"][0]["source"] = {"citation": "Supprimer l'impôt sur le revenu des jeunes de moins de 30 ans"}
        donnees["mesures"][0]["parti"] = "lfi"
        with self.assertRaisesRegex(ValueError, "parti différent"):
            sim_data.valider_mesures(donnees, references)

    def test_mesure_chiffrable_sans_parametre_refusee(self):
        references = sim_data.corpus(ROOT)
        donnees = {"hypotheses": {}, "mesures": [{
            "id": "RN24-087", "parti": "rn", "libelle": "x", "statut": "chiffrable", "action": "ir_jeune", "nature": "revenu",
            "source": {"citation": "Supprimer l'impôt sur le revenu des jeunes de moins de 30 ans"}}]}
        with self.assertRaisesRegex(ValueError, "sans paramètres"):
            sim_data.valider_mesures(donnees, references)


@unittest.skipUnless(shutil.which("node"), "Node.js absent : tests du moteur JavaScript ignorés")
class MoteurJavaScriptTests(unittest.TestCase):
    def test_suite_node(self):
        with tempfile.TemporaryDirectory() as dossier:
            fichier = Path(dossier) / "simulateur.json"
            fichier.write_text(json.dumps(sim_data.load(ROOT), ensure_ascii=False, default=str), encoding="utf-8")
            resultat = subprocess.run(
                ["node", "--test", "tests/simulateur.test.mjs"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                env={**os.environ, "SIM_DATA": str(fichier)})
        self.assertEqual(resultat.returncode, 0, resultat.stdout[-4000:] + resultat.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
