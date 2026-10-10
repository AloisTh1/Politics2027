"""Compare le calcul de la législation en vigueur du simulateur avec OpenFisca-France.

Usage (environnement .venv-openfisca, ignoré par git) :
    .venv-openfisca/Scripts/python.exe tools/check_openfisca.py            # tableau Markdown sur la sortie standard
    .venv-openfisca/Scripts/python.exe tools/check_openfisca.py --resume   # une ligne par cas

Chaque cas est calculé deux fois : par site_src/static/js/simulateur.js (via Node) et par OpenFisca-France,
sur le mois de référence 2026-10 (impôt : année 2026). Aucun seuil de réussite n'est caché : les écarts
sont affichés tels quels, avec la variable OpenFisca utilisée. Les prestations que le simulateur ne modélise
pas (complément familial, allocation de soutien familial, PAJE) sont mises à zéro côté OpenFisca pour que la
comparaison porte sur le même périmètre.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from openfisca_core.simulation_builder import SimulationBuilder
from openfisca_france import FranceTaxBenefitSystem

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sim_data import load  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PERIODE = "2026-10"
MOIS = [f"{annee}-{mois:02d}" for annee in (2024, 2025, 2026) for mois in range(1, 13)]
AJD = (2026, 10, 10)

# Un cas : adulte principal et éventuel conjoint (statut, revenu brut mensuel), enfants (âges), logement.
# statut : salarie_prive | fonctionnaire | retraite | demandeur_emploi | etudiant | sans_activite
CAS = [
    {"nom": "seul_sans_revenu", "p": ("sans_activite", 0, 35), "enfants": []},
    {"nom": "seul_mi_temps", "p": ("salarie_prive", 933.51, 35), "enfants": []},
    {"nom": "seul_smic", "p": ("salarie_prive", 1867.02, 35), "enfants": []},
    {"nom": "seul_2500", "p": ("salarie_prive", 2500, 35), "enfants": []},
    {"nom": "seul_4005", "p": ("salarie_prive", 4005, 35), "enfants": []},
    {"nom": "seul_5000", "p": ("salarie_prive", 5000, 35), "enfants": []},
    {"nom": "seul_9000", "p": ("salarie_prive", 9000, 35), "enfants": []},
    {"nom": "couple_un_smic", "p": ("salarie_prive", 1867.02, 35), "c": ("sans_activite", 0, 35), "enfants": []},
    {"nom": "couple_un_enfant", "p": ("salarie_prive", 1867.02, 35), "c": ("sans_activite", 0, 35), "enfants": [8]},
    {"nom": "couple_deux_enfants", "p": ("salarie_prive", 1867.02, 35), "c": ("sans_activite", 0, 35), "enfants": [8, 12]},
    {"nom": "couple_trois_enfants", "p": ("salarie_prive", 3000, 40), "c": ("sans_activite", 0, 40), "enfants": [5, 9, 16]},
    {"nom": "couple_deux_salaires_deux_enfants", "p": ("salarie_prive", 3200, 38), "c": ("salarie_prive", 2600, 37), "enfants": [4, 9]},
    {"nom": "couple_deux_salaires_aises", "p": ("salarie_prive", 7000, 45), "c": ("salarie_prive", 5500, 44), "enfants": [11, 15]},
    {"nom": "parent_seul_un_enfant", "p": ("salarie_prive", 1867.02, 35), "enfants": [7]},
    {"nom": "parent_seul_deux_enfants", "p": ("salarie_prive", 2200, 35), "enfants": [7, 13]},
    {"nom": "parent_seul_enfant_2_ans_sans_revenu", "p": ("sans_activite", 0, 30), "enfants": [2]},
    {"nom": "parent_seul_enfant_2_ans_smic", "p": ("salarie_prive", 1867.02, 30), "enfants": [2]},
    {"nom": "locataire_seul_modeste", "p": ("salarie_prive", 1300, 30), "enfants": [], "loyer": 450, "zone": 2},
    {"nom": "locataire_couple_deux_enfants", "p": ("salarie_prive", 1867.02, 34), "c": ("sans_activite", 0, 34), "enfants": [6, 10], "loyer": 700, "zone": 2},
    {"nom": "locataire_parent_seul_zone1", "p": ("salarie_prive", 1500, 32), "enfants": [4], "loyer": 800, "zone": 1},
    {"nom": "fonctionnaire_seul", "p": ("fonctionnaire", 2800, 40), "enfants": []},
    {"nom": "demandeur_emploi_seul", "p": ("demandeur_emploi", 1400, 45), "enfants": []},
    {"nom": "retraite_seul_pension_moyenne", "p": ("retraite", 1500, 70), "enfants": []},
    {"nom": "retraite_seul_petite_pension_aspa", "p": ("retraite", 600, 70), "enfants": []},
    {"nom": "retraite_couple", "p": ("retraite", 2200, 68), "c": ("retraite", 1100, 66), "enfants": []},
    {"nom": "etudiant_job", "p": ("etudiant", 1300, 21), "enfants": []},
    {"nom": "etudiant_locataire", "p": ("etudiant", 700, 21), "enfants": [], "loyer": 400, "zone": 2},
    {"nom": "demandeur_emploi_au_dessus_du_smic", "p": ("demandeur_emploi", 2600, 50), "enfants": []},
]


def construire(cas, systeme, rfr_n2=None):
    """Entités OpenFisca d'un cas : revenus constants de 2024 à 2026, prestations non modélisées mises à zéro.

    rfr_n2 : revenu fiscal de référence 2024 imposé à OpenFisca pour les retraités et les chômeurs (la CSG de leurs
    revenus de remplacement en dépend). OpenFisca le calcule sinon par une récurrence sur N-2 qui donne un résultat
    dépendant de l'ordre des calculs ; on lui impose donc l'estimation du simulateur.
    """
    individus, parents = {}, []
    declarants = []

    def adulte(cle, statut, brut, age):
        valeur = {"date_naissance": {"ETERNITY": f"{AJD[0] - age}-01-15"}}
        mensuel = {m: brut for m in MOIS}
        if statut == "salarie_prive":
            valeur["salaire_de_base"] = mensuel
        elif statut == "fonctionnaire":
            valeur["categorie_salarie"] = {m: "public_titulaire_etat" for m in MOIS}
            valeur["traitement_indiciaire_brut"] = mensuel
            for primes in ("primes_fonction_publique", "indemnite_residence", "supplement_familial_traitement",
                           "nouvelle_bonification_indiciaire"):
                valeur[primes] = {m: 0 for m in MOIS}
        elif statut == "retraite":
            valeur["retraite_brute"] = mensuel
            valeur["activite"] = {m: "retraite" for m in MOIS}
        elif statut == "demandeur_emploi":
            valeur["chomage_brut"] = mensuel
            valeur["activite"] = {m: "chomeur" for m in MOIS}
        elif statut == "etudiant":
            valeur["salaire_de_base"] = mensuel
            valeur["activite"] = {m: "etudiant" for m in MOIS}
        individus[cle] = valeur
        parents.append(cle)
        declarants.append(cle)

    adulte("p1", *cas["p"])
    if "c" in cas:
        adulte("p2", *cas["c"])
    enfants = []
    for i, age in enumerate(cas["enfants"]):
        cle = f"e{i}"
        individus[cle] = {"date_naissance": {"ETERNITY": f"{AJD[0] - age}-03-20"}}
        enfants.append(cle)
    zeros = {m: 0 for m in MOIS}
    menage = {"personne_de_reference": ["p1"], "conjoint": ["p2"] if "c" in cas else [], "enfants": enfants}
    if cas.get("loyer"):
        menage["statut_occupation_logement"] = {m: "locataire_vide" for m in MOIS}
        menage["loyer"] = {m: cas["loyer"] for m in MOIS}
        menage["zone_apl"] = {m: f"zone_{cas.get('zone', 2)}" for m in MOIS}
    entree = {
        "individus": individus,
        "familles": {"f1": {"parents": parents, "enfants": enfants, "asf": dict(zeros), "cf": dict(zeros),
                             "paje_base": dict(zeros)}},
        "foyers_fiscaux": {"ff1": {"declarants": declarants, "personnes_a_charge": enfants,
                                    **({"rfr": {"2024": rfr_n2, "2025": rfr_n2}} if rfr_n2 is not None else {})}},
        "menages": {"m1": menage},
    }
    return SimulationBuilder().build_from_entities(systeme, entree)


def valeur(sim, nom, periode=PERIODE):
    try:
        return round(float(sim.calculate(nom, periode)[0]), 2)
    except Exception as erreur:  # variable absente ou non calculable
        return f"indisponible ({type(erreur).__name__})"


def somme_individus(sim, nom, nb):
    try:
        return round(float(sum(sim.calculate(nom, PERIODE)[:nb])), 2)
    except Exception as erreur:
        return f"indisponible ({type(erreur).__name__})"


def reference(cas, systeme, rfr_n2=None):
    sim = construire(cas, systeme, rfr_n2)
    nb = 2 if "c" in cas else 1
    nets = 0.0
    for variable in ("salaire_net", "chomage_net", "retraite_nette"):
        v = somme_individus(sim, variable, nb)
        nets += v if isinstance(v, float) else 0.0
    ars = valeur(sim, "ars", "2026")
    sortie = {
        "revenus_nets": round(nets, 2),
        "impot_annuel": valeur(sim, "ip_net", "2026"),
        "rsa": valeur(sim, "rsa"),
        "prime_activite": valeur(sim, "ppa_nette_crds"),
        "allocations_familiales": valeur(sim, "af_nettes_crds"),
        # OpenFisca donne l'ARS avant CRDS ; le barème de la CAF (et le simulateur) l'affiche après CRDS (0,5 %).
        "ars": round(ars / 12 * 0.995, 2) if isinstance(ars, float) else ars,
        "apl": valeur(sim, "aide_logement"),
        "aspa": valeur(sim, "aspa"),
    }
    return sortie


def situation_js(cas):
    statut, brut, age = cas["p"]
    s = {"statut": statut, "type_revenu": "brut", "revenu": brut, "age": age, "couple": "c" in cas,
         "enfants": cas["enfants"], "logement": "locataire",
         "loyer": cas.get("loyer", 0), "zone_apl": cas.get("zone", 2), "heures_hebdo": 35}
    if statut == "sans_activite":  # l'adulte principal sans activité est saisi comme demandeur d'emploi à zéro
        s.update(statut="demandeur_emploi", revenu=0)
    if "c" in cas:
        cs, cb, ca = cas["c"]
        s["conjoint"] = {"statut": cs, "age": ca, "revenu": cb, "type_revenu": "brut"}
    return s


def calcul_js(cas_liste):
    donnees = load()
    programme = """
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const m = await import(pathToFileURL(process.argv[1] + '/site_src/static/js/simulateur.js').href);
const entree = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(entree.situations.map(s => m.calculer(s, entree.data).actuel)));
"""
    resultat = subprocess.run(
        ["node", "--input-type=module", "-e", programme, str(ROOT)], cwd=ROOT, text=True, capture_output=True,
        input=json.dumps({"situations": [situation_js(c) for c in cas_liste], "data": donnees}, default=str), check=True,
        encoding="utf-8")
    return json.loads(resultat.stdout)


def champs_js(a):
    p = a["prestations"]
    return {
        "revenus_nets": a["revenus_nets"], "impot_annuel": a["detail"]["impot_annuel"], "rsa": p["rsa"],
        "prime_activite": p["prime_activite"], "allocations_familiales": p["allocations_familiales"],
        "ars": p["ars"], "apl": p["apl"], "aspa": p["aspa"],
    }


def disponible(valeurs):
    """Revenu disponible mensuel au périmètre du simulateur, à partir des champs ci-dessus."""
    total = 0.0
    for cle, v in valeurs.items():
        if not isinstance(v, (int, float)):
            return None
        total += -v / 12 if cle == "impot_annuel" else v
    return round(total, 2)


def main():
    resume = "--resume" in sys.argv
    systeme = FranceTaxBenefitSystem()
    nous = calcul_js(CAS)
    lignes = []
    resumes = []
    for cas, a in zip(CAS, nous):
        ours = champs_js(a)
        remplacement = any(cas.get(k, ("",))[0] in {"retraite", "demandeur_emploi"} for k in ("p", "c"))
        ref = reference(cas, systeme, a["detail"]["revenu_imposable_annuel"] if remplacement else None)
        ecart_cas = {}
        for champ in ours:
            r = ref[champ]
            ecart = round(ours[champ] - r, 2) if isinstance(r, float) else None
            ecart_cas[champ] = ecart
            lignes.append((cas["nom"], champ, ours[champ], r, ecart))
        d_nous, d_ref = disponible(ours), disponible(ref)
        ecart_total = round(d_nous - d_ref, 2) if d_nous is not None and d_ref is not None else None
        resumes.append((cas["nom"], d_nous, d_ref, ecart_total, max((abs(e) for e in ecart_cas.values() if e is not None), default=0)))
    if not resume:
        print("cas | variable | simulateur | OpenFisca | écart")
        print("--- | --- | ---: | ---: | ---:")
        for nom, champ, n, r, e in lignes:
            print(f"{nom} | {champ} | {n} | {r} | {'' if e is None else e}")
        print()
    print("cas | revenu disponible simulateur (€/mois) | OpenFisca (€/mois) | écart (€/mois) | plus grand écart de poste")
    print("--- | ---: | ---: | ---: | ---:")
    for nom, n, r, e, m in resumes:
        print(f"{nom} | {n} | {r} | {e} | {m}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as erreur:
        print(erreur.stderr, file=sys.stderr)
        raise
