/** Calcul indicatif mensuel en euros ; données issues de tools/sim_data.py. */

const arrondi = x => Math.round((x + Number.EPSILON) * 100) / 100;
const positif = x => Math.max(0, Number(x) || 0);

export async function chargerDonnees(url) {
  const reponse = await fetch(url);
  if (!reponse.ok) throw new Error(`Données du simulateur indisponibles : ${reponse.status}`);
  return reponse.json();
}

export function netDepuisBrut(brut, statut, bareme, options = {}) {
  brut = positif(brut);
  const c = bareme.cotisations;
  if (statut === 'independant') {
    const taux = c.micro_entrepreneur[options.activite_micro || 'services_bic'];
    if (taux === undefined) throw new Error('Activité micro-entrepreneur inconnue');
    return arrondi(brut * (1 - taux));
  }
  if (statut === 'retraite') {
    const r = c.retraite;
    const taux = options.taux_csg_retraite ?? r.csg_taux_plein;
    if (![0, r.csg_taux_reduit, r.csg_taux_median, r.csg_taux_plein].includes(taux)) {
      throw new Error('Taux CSG retraite inconnu');
    }
    return arrondi(brut * (1 - taux - (taux ? r.crds : 0) - (taux === r.csg_taux_plein || taux === r.csg_taux_median ? r.casa : 0)));
  }
  if (statut === 'fonctionnaire') {
    const f = c.fonctionnaire;
    const tauxPrimes = Math.min(1, Math.max(0, Number(options.part_primes) || 0));
    const indiciaire = brut * (1 - tauxPrimes);
    const rafp = Math.min(brut * tauxPrimes, indiciaire * 0.2) * f.rafp_primes;
    return arrondi(brut - indiciaire * f.pension_civile - rafp - brut * f.assiette_csg * (f.csg_deductible + f.csg_non_deductible + f.crds));
  }
  if (statut !== 'salarie_prive') return arrondi(brut);
  const p = c.prive, plafond = c.plafond_mensuel_securite_sociale;
  const t1 = Math.min(brut, plafond), t2 = Math.max(0, Math.min(brut - plafond, 7 * plafond));
  const vieillesse = t1 * p.vieillesse_plafonnee + brut * p.vieillesse_deplafonnee;
  const complementaire = t1 * (p.agirc_arrco_t1 + p.ceg_t1) + t2 * (p.agirc_arrco_t2 + p.ceg_t2);
  const cet = brut > p.cet_seuil ? Math.min(brut, 8 * plafond) * p.cet : 0;
  const assietteCsg = Math.min(brut, 4 * plafond) * p.assiette_csg + Math.max(0, brut - 4 * plafond);
  return arrondi(brut - vieillesse - complementaire - cet - assietteCsg * (p.csg_deductible + p.csg_non_deductible + p.crds));
}

function parts(couple, enfants) {
  return (couple ? 2 : 1) + enfants.reduce((s, _, i) => s + (i < 2 ? 0.5 : 1), 0);
}

function impotBareme(revenu, partsFiscal, b) {
  const q = revenu / partsFiscal, t = b.tranches;
  let montant = 0;
  for (let i = 0; i < t.length; i++) {
    const haut = i + 1 < t.length ? t[i + 1].seuil : Infinity;
    montant += Math.max(0, Math.min(q, haut) - t[i].seuil) * t[i].taux;
  }
  return montant * partsFiscal;
}

export function impotAnnuel(revenuImposable, couple, enfants, bareme, partsForcees = null) {
  const b = bareme.impot_revenu, base = couple ? 2 : 1;
  const p = partsForcees ?? parts(couple, enfants);
  const brut = impotBareme(positif(revenuImposable), p, b);
  const plafond = impotBareme(positif(revenuImposable), base, b) - (p - base) * 2 * b.plafond_demi_part;
  const apresPlafond = Math.max(brut, plafond);
  const d = b.decote;
  const decote = Math.max(0, (couple ? d.couple : d.seul) - d.coefficient * apresPlafond);
  return arrondi(Math.max(0, apresPlafond - decote));
}

function eligiblesEnfants(s) {
  return (s.enfants || []).filter(age => Number.isInteger(age) && age >= 0 && age < 20);
}

function rsaForfait(couple, n, b) {
  if (couple) return n === 0 ? b.couple_sans_enfant : n === 1 ? b.deux_personnes_a_charge : b.couple_deux_enfants + Math.max(0, n - 2) * b.enfant_supplementaire;
  return n === 0 ? b.base : n === 1 ? b.seul_un_enfant : b.deux_personnes_a_charge + Math.max(0, n - 2) * b.enfant_supplementaire;
}

function prestations(s, b, net, conjoint, options) {
  const enfants = eligiblesEnfants(s), n = enfants.length, p = b.prestations;
  const ressources = net + conjoint, annuel = ressources * 12;
  let af = 0;
  if (n >= 2) {
    const a = p.allocations_familiales;
    const seuil = a.plafond_2.map(v => v + (n - 2) * a.plafond_par_enfant_supplementaire);
    const rang = annuel <= seuil[0] ? 0 : annuel <= seuil[1] ? 1 : 2;
    af = (n === 2 ? a.enfants_2[rang] : a.enfants_3[rang] + (n - 3) * a.enfant_supplementaire[rang]);
  }
  let ars = 0;
  const a = p.ars, plafond = a.plafonds[Math.min(Math.max(n - 1, 0), a.plafonds.length - 1)];
  if (n && annuel <= plafond) for (const age of enfants) {
    if (age >= 6 && age <= 10) ars += a.montants.age_6_10;
    else if (age >= 11 && age <= 14) ars += a.montants.age_11_14;
    else if (age >= 15 && age <= 18) ars += a.montants.age_15_18;
  }
  ars /= 12;
  const apl = s.logement === 'locataire' ? positif(s.apl_actuelle) : 0;
  const taille = 1 + (s.couple ? 1 : 0) + n;
  const forfaitLogement = apl > 0 || s.logement === 'proprietaire' ? p.rsa.forfait_logement[Math.min(taille, 3)] : 0;
  let rsa = 0;
  if (s.statut !== 'etudiant' && s.statut !== 'retraite' && (s.age ?? 0) >= 25) {
    rsa = Math.max(0, rsaForfait(!!s.couple, n, p.rsa) - ressources - af - forfaitLogement);
  }
  let prime = 0;
  if (['salarie_prive', 'fonctionnaire', 'independant', 'etudiant'].includes(s.statut) && net > 0 && (s.age ?? 0) >= 18) {
    const pr = p.prime_activite;
    const forfait = pr.base * ((s.couple ? 1.5 : 1) + (n ? (s.couple ? 0.3 : 0.5) : 0) + (n >= 2 ? 0.3 : 0) + Math.max(0, n - 2) * 0.4);
    const seuilEtudiant = b.smic.mensuel_net_indicatif * 0.55;
    if (s.statut !== 'etudiant' || net >= seuilEtudiant) {
      // La bonification exacte varie avec le salaire net social ; pente explicite mais indicative.
      const max = pr.base * pr.bonification_max_part_base;
      const bonification = Math.min(max, Math.max(0, (net - 0.5 * b.smic.mensuel_net_indicatif) / (0.65 * b.smic.mensuel_net_indicatif) * max));
      prime = Math.max(0, forfait + pr.part_revenus_activite * net + bonification - ressources - af - forfaitLogement);
      if (prime < 15) prime = 0;
    }
  }
  let aspa = 0;
  if (s.statut === 'retraite' && (s.age ?? 0) >= p.aspa.age_general) {
    aspa = Math.max(0, (s.couple ? p.aspa.couple : p.aspa.seul) - ressources);
  }
  return {allocations_familiales: arrondi(af), ars_mensualisee: arrondi(ars), apl: arrondi(apl), rsa: arrondi(rsa), prime_activite: arrondi(prime), aspa: arrondi(aspa)};
}

function concerne(m, s) {
  const c = m.concerne || ['tous'];
  if (c.includes('tous') || c.includes(s.statut)) return true;
  if (c.includes('famille') && eligiblesEnfants(s).length) return true;
  if (c.includes('couple') && s.couple) return true;
  if (c.includes('locataire') && s.logement === 'locataire') return true;
  if (c.includes('electricite') && s.chauffage === 'electricite') return true;
  if (c.includes('rsa') && s.age >= 25 && positif(s.revenu) < 1000) return true;
  return false;
}

function brutPourNet(net, statut, b, options) {
  if (net <= 0) return 0;
  let bas = net, haut = net * 2.5 + 100;
  for (let i = 0; i < 35; i++) {
    const milieu = (bas + haut) / 2;
    if (netDepuisBrut(milieu, statut, b, options) < net) bas = milieu;
    else haut = milieu;
  }
  return (bas + haut) / 2;
}

function imposableMensuel(net, brut, statut, b, options) {
  if (statut === 'independant') {
    const activite = options.activite_micro || 'services_bic';
    const abattement = activite === 'vente' ? 0.71 : activite === 'liberal_bnc' || activite === 'cipav' ? 0.34 : 0.50;
    return brut * (1 - abattement);
  }
  if (statut === 'salarie_prive' || statut === 'fonctionnaire') {
    const c = b.cotisations[statut === 'salarie_prive' ? 'prive' : 'fonctionnaire'];
    const plafond = 4 * b.cotisations.plafond_mensuel_securite_sociale;
    const assiette = Math.min(brut, plafond) * c.assiette_csg + Math.max(0, brut - plafond);
    return (net + assiette * (c.csg_non_deductible + c.crds)) * (1 - b.impot_revenu.abattement_salaires);
  }
  return net * (1 - b.impot_revenu.abattement_salaires);
}

function situationBase(s, b, options = {}) {
  const type = s.type_revenu || 'net';
  const net = type === 'brut' ? netDepuisBrut(s.revenu, s.statut, b, options) : positif(s.revenu);
  const brut = type === 'brut' ? positif(s.revenu) : brutPourNet(net, s.statut, b, options);
  const conjoint = positif(s.revenu_conjoint);
  const enfants = eligiblesEnfants(s);
  const brutConjoint = brutPourNet(conjoint, options.statut_conjoint || 'salarie_prive', b, options);
  const imposable = (imposableMensuel(net, brut, s.statut, b, options) +
    imposableMensuel(conjoint, brutConjoint, options.statut_conjoint || 'salarie_prive', b, options)) * 12;
  const impot = impotAnnuel(imposable, !!s.couple, enfants, b) / 12;
  const aides = prestations(s, b, net, conjoint, options);
  const totalAides = Object.values(aides).reduce((a, v) => a + v, 0);
  return {revenus_nets: arrondi(net + conjoint), impot_revenu: arrondi(impot), prestations: aides,
    revenu_disponible: arrondi(net + conjoint - impot + totalAides), _net: net, _conjoint: conjoint, _imposable: imposable};
}

export function calculer(situation, donnees, options = {}) {
  if (!donnees?.bareme || !Array.isArray(donnees.mesures)) throw new Error('Données du simulateur invalides');
  if (!['salarie_prive', 'fonctionnaire', 'independant', 'demandeur_emploi', 'retraite', 'etudiant'].includes(situation.statut)) throw new Error('Statut inconnu');
  const b = donnees.bareme, actuel = situationBase(situation, b, options);
  const resultat = {actuel: {...actuel}, rn: null, lfi: null, hypotheses: [], non_chiffrables: {rn: [], lfi: []}};
  for (const parti of ['rn', 'lfi']) {
    let scenario = {...actuel}, mesures = [];
    for (const m of donnees.mesures.filter(x => x.parti === parti)) {
      if (!concerne(m, situation)) continue;
      if (m.statut !== 'chiffrable') { resultat.non_chiffrables[parti].push({id: m.id, libelle: m.libelle, raison: m.manque}); continue; }
      let delta = 0;
      if (m.action === 'tva_energie') {
        const depense = positif(situation.energie_mensuelle) + positif(situation.carburant_mensuel);
        const ancien = b.tva.energie_usage.electricite, nouveau = m.parametres.taux_cible;
        const repercussion = Math.min(1, Math.max(0, options.repercussion_tva ?? m.hypotheses.repercussion_prix.defaut));
        delta = depense * (1 - (1 + nouveau) / (1 + ancien)) * repercussion;
      } else if (m.action === 'part_deuxieme_enfant' && eligiblesEnfants(situation).length >= 2) {
        const e = eligiblesEnfants(situation);
        const nouveau = impotAnnuel(actuel._imposable, !!situation.couple, e, b, parts(!!situation.couple, e) + 0.5) / 12;
        delta = Math.max(0, scenario.impot_revenu - nouveau);
        scenario.impot_revenu = arrondi(scenario.impot_revenu - delta);
      } else if (m.action === 'ir_jeune' && situation.age < m.parametres.age_strictement_inferieur) {
        const e = eligiblesEnfants(situation);
        const brutConjoint = brutPourNet(actuel._conjoint, options.statut_conjoint || 'salarie_prive', b, options);
        const revenuConjoint = imposableMensuel(actuel._conjoint, brutConjoint, options.statut_conjoint || 'salarie_prive', b, options) * 12;
        const nouveau = impotAnnuel(revenuConjoint, !!situation.couple, e, b) / 12;
        delta = Math.max(0, scenario.impot_revenu - nouveau);
        scenario.impot_revenu = arrondi(scenario.impot_revenu - delta);
      } else if (m.action === 'smic_net') {
        const cible = m.parametres.mensuel_net_35h * (positif(situation.temps_travail_heures) || 35) / 35;
        const nouveauNet = Math.max(actuel._net, cible);
        if (nouveauNet > actuel._net) {
          const entree = {...situation, revenu: nouveauNet, type_revenu: 'net'};
          const nouveau = situationBase(entree, b, options);
          delta = nouveau.revenu_disponible - actuel.revenu_disponible;
          scenario = {...nouveau};
        }
      } else if (m.action === 'apl_hausse') {
        if (positif(situation.apl_actuelle) === 0) { resultat.non_chiffrables[parti].push({id: m.id, libelle: m.libelle, raison: 'APL actuelle non renseignée'}); continue; }
        delta = positif(situation.apl_actuelle) * m.parametres.hausse;
      }
      if (delta) {
        delta = arrondi(delta);
        mesures.push({id: m.id, libelle: m.libelle, variation_mensuelle: delta, hypothese: m.hypotheses || null});
        if (m.action !== 'smic_net') scenario.revenu_disponible = arrondi(scenario.revenu_disponible + delta);
      }
    }
    resultat[parti] = {revenu_disponible: scenario.revenu_disponible, ecart_actuel: arrondi(scenario.revenu_disponible - actuel.revenu_disponible), mesures};
  }
  delete resultat.actuel._net; delete resultat.actuel._conjoint; delete resultat.actuel._imposable;
  resultat.hypotheses = ['Revenu et composition du foyer constants sur douze mois', 'APL actuelle saisie, sinon exclue', 'Prime d’activité et RSA simplifiés', 'Taux de répercussion de TVA réglable'];
  return resultat;
}
