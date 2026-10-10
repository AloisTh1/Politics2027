/**
 * Simulateur d'impact personnel — moteur de calcul sans dépendance.
 *
 * Toutes les valeurs monétaires sont mensuelles, en euros, sauf mention « annuel ».
 * Les données (barème 2026, mesures, hypothèses) viennent du JSON produit par tools/sim_data.py.
 *
 * API publique :
 *   chargerDonnees(url)                      -> Promise<donnees>
 *   valeursParDefaut(donnees)                -> options par défaut (hypothèses réglables)
 *   netDepuisBrut(brut, statut, bareme, o)   -> net mensuel
 *   brutDepuisNet(net, statut, bareme, o)    -> brut mensuel
 *   impotAnnuel(imposable, foyer, bareme)    -> impôt sur le revenu annuel (euros entiers)
 *   estimerAidesLogement(...)                -> aide au logement mensuelle (formule simplifiée)
 *   calculer(situation, donnees, options)    -> résultat (actuel, rn, lfi, non chiffrables…)
 */

export const VERSION = 1;

const arrondi = (x, n = 2) => { const k = 10 ** n; return Math.round((x + Number.EPSILON) * k) / k; };
const positif = x => Math.max(0, Number(x) || 0);
const borne = (x, a, b) => Math.min(b, Math.max(a, x));
const somme = (liste, f = x => x) => liste.reduce((s, x) => s + f(x), 0);
const copie = x => JSON.parse(JSON.stringify(x));

export const STATUTS = ['salarie_prive', 'fonctionnaire', 'independant', 'demandeur_emploi', 'retraite', 'etudiant'];
export const STATUTS_CONJOINT = [...STATUTS, 'sans_activite'];
const LIBELLES_PRESTATIONS = {
  allocations_familiales: 'Allocations familiales', ars: 'Allocation de rentrée scolaire (lissée)',
  apl: 'Aide au logement', rsa: 'RSA', prime_activite: "Prime d'activité", aspa: 'ASPA (minimum vieillesse)',
};
const PRODUITS = ['electricite', 'gaz', 'fioul', 'carburant'];

export async function chargerDonnees(url) {
  const reponse = await fetch(url);
  if (!reponse.ok) throw new Error(`Données du simulateur indisponibles : ${reponse.status}`);
  return reponse.json();
}

export function valeursParDefaut(donnees) {
  const valeurs = {};
  for (const [cle, h] of Object.entries(donnees?.hypotheses || {})) valeurs[cle] = h.defaut;
  return valeurs;
}

function resoudreOptions(donnees, options = {}) {
  const defs = donnees.hypotheses || {};
  const valeurs = { ...valeursParDefaut(donnees) };
  for (const [cle, v] of Object.entries(options || {})) {
    const h = defs[cle];
    if (!h) continue;
    if (h.type === 'choix') {
      if (!h.choix.some(c => c[0] === v)) throw new Error(`Hypothèse « ${h.libelle} » : valeur inconnue`);
      valeurs[cle] = v;
    } else if (h.type === 'booleen') {
      valeurs[cle] = Boolean(v);
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < h.min - 1e-9 || n > h.max + 1e-9) throw new Error(`Hypothèse « ${h.libelle} » hors bornes (${h.min} à ${h.max})`);
      valeurs[cle] = n;
    }
  }
  return valeurs;
}

/* ------------------------------------------------------------------ salaires, pensions, allocations */

function classeRetraite(nom, r) {
  const classes = {
    exonere: { csg: 0, ded: 0, crds: 0, casa: 0 },
    reduit: { csg: r.csg_taux_reduit, ded: r.csg_deductible_reduit, crds: r.crds, casa: 0 },
    median: { csg: r.csg_taux_median, ded: r.csg_deductible_median, crds: r.crds, casa: r.casa },
    plein: { csg: r.csg_taux_plein, ded: r.csg_deductible_plein, crds: r.crds, casa: r.casa },
  };
  if (!classes[nom]) throw new Error('Taux de CSG retraite inconnu');
  return classes[nom];
}

function classeSelonRfr(rfr, parts, r) {
  const demi = Math.max(0, (parts - 1) * 2);
  if (rfr <= r.seuil_rfr_zero + demi * r.demi_part_rfr_zero) return 'exonere';
  if (rfr <= r.seuil_rfr_reduit + demi * r.demi_part_rfr_reduit) return 'reduit';
  if (rfr <= r.seuil_rfr_median + demi * r.demi_part_rfr_median) return 'median';
  return 'plein';
}

/** Assiette de la CSG et de la CRDS : 98,25 % du brut jusqu'à 4 plafonds, 100 % au-delà. */
function assietteCsgSalaire(brut, g, plafondSS) {
  return Math.min(brut, 4 * plafondSS) * g.assiette_csg + Math.max(0, brut - 4 * plafondSS);
}

function cotisationsSalaire(brut, p, plafondSS) {
  const t1 = Math.min(brut, plafondSS);
  const t2 = Math.max(0, Math.min(brut, 8 * plafondSS) - plafondSS);
  const vieillesse = t1 * p.vieillesse_plafonnee + brut * p.vieillesse_deplafonnee;
  const complementaire = t1 * (p.agirc_arrco_t1 + p.ceg_t1) + t2 * (p.agirc_arrco_t2 + p.ceg_t2);
  const cet = brut > p.cet_seuil ? Math.min(brut, 8 * plafondSS) * p.cet : 0;
  return { cotisations: vieillesse + complementaire + cet, assietteCsg: assietteCsgSalaire(brut, p, plafondSS) };
}

/**
 * CSG et CRDS sur l'allocation chômage : taux plein sur 98,25 %, sans que le net puisse passer sous le SMIC brut mensuel.
 * Retourne le total retenu et la part de CSG déductible du revenu imposable.
 */
function retenuesChomage(brut, ch, smicBrut) {
  const theorique = brut * ch.assiette_csg * (ch.csg_deductible + ch.csg_non_deductible + ch.crds);
  const total = Math.min(theorique, Math.max(0, brut - smicBrut));
  const partDeductible = theorique > 0 ? ch.csg_deductible / (ch.csg_deductible + ch.csg_non_deductible + ch.crds) : 0;
  return { total, deductible: total * partDeductible };
}

/** Net mensuel depuis le brut mensuel (brut = chiffre d'affaires pour un micro-entrepreneur). */
export function netDepuisBrut(brut, statut, bareme, options = {}) {
  brut = positif(brut);
  const c = bareme.cotisations;
  if (statut === 'independant') {
    const taux = c.micro_entrepreneur[options.activite_micro || 'services_bic'];
    if (taux === undefined) throw new Error('Activité de micro-entrepreneur inconnue');
    return arrondi(brut * (1 - taux));
  }
  if (statut === 'retraite') {
    const k = classeRetraite(options.csg_retraite_classe || 'plein', c.retraite);
    return arrondi(brut * (1 - k.csg - k.crds - k.casa));
  }
  if (statut === 'demandeur_emploi') return arrondi(brut - retenuesChomage(brut, c.chomage, bareme.smic.mensuel_brut).total);
  if (statut === 'sans_activite') return 0;
  if (statut === 'fonctionnaire') {
    const f = c.fonctionnaire;
    const primes = borne(Number(options.part_primes_fonctionnaire) || 0, 0, 1);
    const indiciaire = brut * (1 - primes);
    const rafp = Math.min(brut * primes, indiciaire * f.rafp_plafond_part_traitement) * f.rafp_primes;
    const assiette = assietteCsgSalaire(brut, f, c.plafond_mensuel_securite_sociale);
    return arrondi(brut - indiciaire * f.pension_civile - rafp - assiette * (f.csg_deductible + f.csg_non_deductible + f.crds));
  }
  const p = c.prive;
  const { cotisations, assietteCsg } = cotisationsSalaire(brut, p, c.plafond_mensuel_securite_sociale);
  return arrondi(brut - cotisations - assietteCsg * (p.csg_deductible + p.csg_non_deductible + p.crds));
}

/** Brut mensuel depuis le net mensuel (recherche par dichotomie sur netDepuisBrut). */
export function brutDepuisNet(net, statut, bareme, options = {}) {
  net = positif(net);
  if (net === 0) return 0;
  let bas = net, haut = net * 3 + 100;
  for (let i = 0; i < 50; i++) {
    const milieu = (bas + haut) / 2;
    if (netDepuisBrut(milieu, statut, bareme, options) < net) bas = milieu; else haut = milieu;
  }
  return (bas + haut) / 2;
}

/**
 * Revenu imposable annuel avant abattement forfaitaire, par catégorie, d'après le brut et le net mensuels.
 * categorie : 'salaire' (abattement de 10 % par personne), 'pension' (abattement de 10 % commun au foyer),
 * 'micro' (déjà net de l'abattement du régime).
 */
function revenuImposable(statut, brut, net, bareme, options) {
  const c = bareme.cotisations;
  if (statut === 'independant') {
    const abattement = c.micro_entrepreneur['abattement_' + (options.activite_micro || 'services_bic')];
    return { categorie: 'micro', montant: 12 * brut * (1 - abattement) };
  }
  if (statut === 'retraite') {
    const k = classeRetraite(options.csg_retraite_classe || 'plein', c.retraite);
    return { categorie: 'pension', montant: 12 * brut * (1 - k.ded) };
  }
  if (statut === 'demandeur_emploi') {
    return { categorie: 'salaire', montant: 12 * (brut - retenuesChomage(brut, c.chomage, bareme.smic.mensuel_brut).deductible) };
  }
  if (statut === 'sans_activite') return { categorie: 'salaire', montant: 0 };
  const g = statut === 'fonctionnaire' ? c.fonctionnaire : c.prive;
  const assiette = assietteCsgSalaire(brut, g, c.plafond_mensuel_securite_sociale);
  return { categorie: 'salaire', montant: 12 * (net + assiette * (g.csg_non_deductible + g.crds)) };
}

/* ------------------------------------------------------------------------------ impôt sur le revenu */

function nombreDeParts(foyer) {
  const base = foyer.couple ? 2 : 1;
  let enfants = 0;
  for (let i = 0; i < foyer.enfants; i++) enfants += i === 1 && foyer.part_deuxieme_enfant ? 1 : (i < 2 ? 0.5 : 1);
  const isole = !foyer.couple && foyer.enfants > 0 && foyer.parent_isole ? 0.5 : 0;
  return { base, parts: base + enfants + isole, isole: isole > 0 };
}

function impotBareme(revenu, parts, b) {
  const q = revenu / parts, t = b.tranches;
  let montant = 0;
  for (let i = 0; i < t.length; i++) {
    const haut = i + 1 < t.length ? t[i + 1].seuil : Infinity;
    montant += Math.max(0, Math.min(q, haut) - t[i].seuil) * t[i].taux;
  }
  return montant * parts;
}

/**
 * Impôt sur le revenu annuel d'un foyer (euros entiers).
 * foyer : { couple, enfants (nombre), parent_isole, part_deuxieme_enfant }
 */
export function impotAnnuel(imposable, foyer, bareme) {
  const b = bareme.impot_revenu;
  const revenu = positif(imposable);
  const { base, parts, isole } = nombreDeParts(foyer);
  const brut = impotBareme(revenu, parts, b);
  const sansQuotient = impotBareme(revenu, base, b);
  const demiParts = (parts - base) * 2;
  const premieres = Math.min((parts - 1) * 2, 2);
  const plafondAvantage = isole
    ? b.plafond_parent_isole * premieres / 2 + b.plafond_demi_part * (demiParts - premieres)
    : b.plafond_demi_part * demiParts;
  const apresPlafond = Math.max(brut, sansQuotient - plafondAvantage);
  const decote = Math.max(0, (foyer.couple ? b.decote.couple : b.decote.seul) - b.decote.coefficient * apresPlafond);
  const net = Math.max(0, apresPlafond - decote);
  return net < b.seuil_recouvrement ? 0 : Math.round(net);
}

/* ------------------------------------------------------------------------------ prestations */

function enfantsAF(ages) { return ages.filter(a => a < 20); }

/** Allocations familiales : { base, majoration } (montants après CRDS, comme dans le barème de la CAF). */
function allocationsFamiliales(ages, ressourcesAnnuelles, p) {
  const a = p.allocations_familiales, enfants = enfantsAF(ages);
  const n = enfants.length;
  if (n < 2) return { base: 0, majoration: 0 };
  const plafonds = a.plafond_2.map(v => v + (n - 2) * a.plafond_par_enfant_supplementaire);
  const rang = ressourcesAnnuelles <= plafonds[0] ? 0 : ressourcesAnnuelles <= plafonds[1] ? 1 : 2;
  const base = n === 2 ? a.enfants_2[rang] : a.enfants_3[rang] + (n - 3) * a.enfant_supplementaire[rang];
  let majoration = 0;
  [...enfants].sort((x, y) => y - x).forEach((age, i) => {
    if (n === 2 && i === 0) return; // l'aîné d'une famille de deux enfants n'ouvre pas de majoration
    if (age >= a.majoration_age_min) majoration += a.majoration_age[rang];
  });
  return { base, majoration };
}

function allocationRentree(ages, ressourcesAnnuelles, p) {
  const a = p.ars, n = ages.filter(x => x < 21).length;
  if (!n) return 0;
  const plafond = n <= a.plafonds.length ? a.plafonds[n - 1] : a.plafonds[a.plafonds.length - 1] + (n - a.plafonds.length) * a.plafond_par_enfant_supplementaire;
  if (ressourcesAnnuelles > plafond) return 0;
  let total = 0;
  for (const age of ages) {
    if (age >= 6 && age <= 10) total += a.montants.age_6_10;
    else if (age >= 11 && age <= 14) total += a.montants.age_11_14;
    else if (age >= 15 && age <= 18) total += a.montants.age_15_18;
  }
  return total / 12;
}

function plafondLoyerLocatif(zone, couple, n, p) {
  const z = p.apl.plafonds_loyer['zone_' + zone];
  if (n > 0) return z.un_enfant + Math.max(0, n - 1) * z.enfant_supplementaire;
  return couple ? z.couple : z.seul;
}

/**
 * Aide au logement mensuelle, secteur locatif, formule simplifiée (voir data/simulateur/NOTES.md).
 * ressourcesAnnuelles : revenu net imposable annuel du foyer.
 */
export function estimerAidesLogement({ loyer, zone, couple, enfants, ressourcesAnnuelles }, bareme) {
  const a = bareme.prestations.apl;
  loyer = positif(loyer);
  if (!loyer) return 0;
  const n = enfants;
  const plafond = plafondLoyerLocatif(zone, couple, n, bareme.prestations);
  const L = Math.min(loyer, plafond);
  const C = a.forfait_charges.base + n * a.forfait_charges.par_enfant;
  const P0 = Math.max(a.participation_minimale.taux * (L + C), a.participation_minimale.forfait);
  const r0 = n === 0 ? (couple ? a.r0.couple : a.r0.seul)
    : n <= a.r0.enfants.length ? a.r0.enfants[n - 1] : a.r0.enfants[a.r0.enfants.length - 1] + (n - a.r0.enfants.length) * a.r0.enfant_supplementaire;
  const tf = n === 0 ? (couple ? a.taux_famille.couple : a.taux_famille.seul)
    : n <= a.taux_famille.enfants.length ? a.taux_famille.enfants[n - 1]
      : a.taux_famille.enfants[a.taux_famille.enfants.length - 1] + (n - a.taux_famille.enfants.length) * a.taux_famille.enfant_supplementaire;
  const reference = plafondLoyerLocatif(2, couple, n, bareme.prestations);
  const rl = Math.round(L / reference * 10000) / 10000;
  const t = a.taux_loyer;
  const tl = rl >= t.seuil_2 ? t.taux_3 * (rl - t.seuil_2) + t.taux_2 * (t.seuil_2 - t.seuil_1) : Math.max(0, t.taux_2 * (rl - t.seuil_1));
  const participation = P0 + (tf + Math.round(tl * 1e5) / 1e5) * Math.max(0, ressourcesAnnuelles - r0);
  const [debutDegressivite, suppression] = a.degressivite['zone_' + zone];
  const seuilD = plafond * debutDegressivite, seuilS = plafond * suppression;
  const coefficient = loyer <= seuilD ? 1 : loyer <= seuilS ? 1 - (loyer - seuilD) / (seuilS - seuilD) : 0;
  const avantSeuil = Math.max(0, L + C - participation);
  if (avantSeuil < a.seuil_versement) return 0;
  const brute = Math.max(0, avantSeuil * coefficient - a.minoration_forfaitaire);
  return arrondi(brute * (1 - bareme.prestations.crds_prestations));
}

function forfaitRsa(couple, n, majore, r) {
  if (majore) return r.base * (r.majoration_isolement_base + r.majoration_isolement_par_enfant * n);
  if (couple) return n === 0 ? r.couple_sans_enfant : n === 1 ? r.deux_personnes_a_charge : r.couple_deux_enfants + (n - 2) * r.enfant_supplementaire;
  return n === 0 ? r.base : n === 1 ? r.seul_un_enfant : r.deux_personnes_a_charge + (n - 1 - 1) * r.enfant_supplementaire;
}

function forfaitPrimeActivite(couple, n, majore, pa, rsa) {
  if (majore) return pa.base * (rsa.majoration_isolement_base + rsa.majoration_isolement_par_enfant * n);
  let taux = 1 + (couple || n > 0 ? pa.majoration_adulte_ou_enfant_1 : 0);
  const aTaux2 = couple ? Math.min(n, 2) : (n >= 2 ? 1 : 0);
  taux += aTaux2 * pa.majoration_enfant_2 + Math.max(0, n - 2) * pa.majoration_enfant_supplementaire;
  return pa.base * taux;
}

function forfaitLogementPrimeActivite(couple, n, pa) {
  const personnes = 1 + (couple ? 1 : 0) + n;
  const taux = 1 + (personnes >= 2 ? pa.majoration_adulte_ou_enfant_1 : 0) + (personnes >= 3 ? pa.majoration_enfant_2 : 0);
  return pa.base * taux * pa.forfait_logement_taux[Math.min(personnes, 3) - 1];
}

/* ------------------------------------------------------------------------------ construction du foyer */

function normaliser(situation, bareme, hypotheses) {
  const s = situation || {};
  if (!STATUTS.includes(s.statut)) throw new Error('Statut inconnu');
  const montant = (champ, v) => {
    if (v === undefined || v === null || v === '') return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Montant invalide : ${champ}`);
    return n;
  };
  const age = Number(s.age);
  if (!Number.isInteger(age) || age < 16 || age > 120) throw new Error('Âge invalide');
  const enfants = (s.enfants || []).map(Number);
  if (enfants.some(a => !Number.isInteger(a) || a < 0 || a > 24)) throw new Error("Âge d'enfant invalide : indiquer des âges entiers de 0 à 24 ans");
  const couple = Boolean(s.couple);
  const conjointBrut = couple ? (s.conjoint || {}) : {};
  const statutConjoint = couple ? (conjointBrut.statut || 'sans_activite') : null;
  if (couple && !STATUTS_CONJOINT.includes(statutConjoint)) throw new Error('Statut du conjoint inconnu');
  const ageConjoint = couple ? Number(conjointBrut.age ?? age) : null;
  if (couple && (!Number.isInteger(ageConjoint) || ageConjoint < 16 || ageConjoint > 120)) throw new Error('Âge du conjoint invalide');
  const temps = (valeur, statut) => {
    if (valeur === undefined || valeur === null || valeur === '') return ['salarie_prive', 'fonctionnaire'].includes(statut) ? 35 : null;
    const h = Number(valeur);
    if (!Number.isFinite(h) || h <= 0 || h > 60) throw new Error('Temps de travail invalide (0 à 60 heures par semaine)');
    return h;
  };
  const logement = s.logement || 'locataire';
  if (!['locataire', 'proprietaire', 'gratuit'].includes(logement)) throw new Error('Logement inconnu');
  const zone = Number(s.zone_apl || 2);
  if (![1, 2, 3].includes(zone)) throw new Error('Zone de logement inconnue');
  const chauffage = s.chauffage || 'autre';
  if (!['electricite', 'gaz', 'fioul', 'autre'].includes(chauffage)) throw new Error('Mode de chauffage inconnu');
  const apl = s.apl_actuelle === undefined || s.apl_actuelle === null || s.apl_actuelle === '' ? null : montant('apl_actuelle', s.apl_actuelle);
  const personne = (statut, agePersonne, revenu, typeRevenu, extra) => {
    if (!['net', 'brut'].includes(typeRevenu)) throw new Error('Type de revenu inconnu (net ou brut)');
    return { statut, age: agePersonne, revenu, type: typeRevenu, boursier: Boolean(extra.boursier), exonere_ir: false, heures: extra.heures };
  };
  const personnes = [personne(s.statut, age, montant('revenu', s.revenu), s.type_revenu || 'net', { boursier: s.boursier, heures: temps(s.heures_hebdo, s.statut) })];
  if (couple) {
    personnes.push(personne(statutConjoint, ageConjoint, montant('revenu du conjoint', conjointBrut.revenu ?? s.revenu_conjoint), conjointBrut.type_revenu || 'net',
      { boursier: conjointBrut.boursier, heures: temps(conjointBrut.heures_hebdo, statutConjoint) }));
  }
  return {
    personnes, couple, enfants, logement, zone, chauffage, apl_saisie: apl, loyer: montant('loyer', s.loyer),
    depenses: {
      electricite: montant('électricité', s.electricite_mensuelle), gaz: montant('gaz', s.gaz_mensuel),
      fioul: montant('fioul', s.fioul_mensuel), carburant: montant('carburant', s.carburant_mensuel),
    },
    hypotheses, drapeaux: { part_deuxieme_enfant: false, apl_facteur: 1, plancher_disponible: null, aspa_seul: null, complement_etudiant: false, cvec: false },
    prix: { tva: null, electricite: null },
  };
}

/** Détermine net, brut et revenu imposable de chaque adulte ; choisit la classe de CSG des retraités. */
function revenusDesPersonnes(etat, bareme) {
  const h = etat.hypotheses;
  const base = { activite_micro: h.activite_micro, part_primes_fonctionnaire: h.part_primes_fonctionnaire };
  const demandee = h.csg_retraite;
  const classes = demandee === 'auto' ? ['exonere', 'reduit', 'median', 'plein'] : [demandee];
  const retraite = bareme.cotisations.retraite;
  const nEnfants = etat.enfants.length;
  const partsFiscales = nombreDeParts({ couple: etat.couple, enfants: nEnfants, parent_isole: h.parent_isole, part_deuxieme_enfant: etat.drapeaux.part_deuxieme_enfant }).parts;

  const calcul = (classe) => {
    const opts = { ...base, csg_retraite_classe: classe };
    return etat.personnes.map(p => {
      const brut = p.type === 'brut' ? p.revenu : brutDepuisNet(p.revenu, p.statut, bareme, opts);
      const net = p.type === 'net' ? p.revenu : netDepuisBrut(p.revenu, p.statut, bareme, opts);
      const imp = revenuImposable(p.statut, brut, net, bareme, opts);
      return { ...p, brut, net, categorie: imp.categorie, imposable_brut: imp.montant, classe_csg: p.statut === 'retraite' ? classe : null };
    });
  };
  const rfrDe = (personnes, avecExonerations = false) => {
    const ab = bareme.impot_revenu;
    let salaires = 0, pensions = 0, micro = 0;
    for (const p of personnes) {
      if (avecExonerations && p.exonere_ir) continue;
      if (p.categorie === 'salaire') salaires += Math.max(0, p.imposable_brut - borne(ab.abattement_salaires.taux * p.imposable_brut, ab.abattement_salaires.minimum, ab.abattement_salaires.maximum));
      else if (p.categorie === 'pension') pensions += p.imposable_brut;
      else micro += p.imposable_brut;
    }
    pensions = Math.max(0, pensions - borne(ab.abattement_pensions.taux * pensions, ab.abattement_pensions.minimum, ab.abattement_pensions.maximum));
    return salaires + pensions + micro;
  };

  let choisi = null;
  for (const classe of classes) {
    const personnes = calcul(classe);
    if (!personnes.some(p => p.statut === 'retraite') || demandee !== 'auto') { choisi = personnes; break; }
    if (classeSelonRfr(rfrDe(personnes), partsFiscales, retraite) === classe) { choisi = personnes; break; }
  }
  if (!choisi) choisi = calcul('plein');
  // `rfr` : revenu net imposable du foyer avant exonérations de mesures ; `imposable` : après exonérations.
  return { personnes: choisi, rfr: rfrDe(choisi), imposable: rfrDe(choisi, true) };
}

/** Évalue la situation (après d'éventuelles modifications de l'état) et retourne les montants mensuels. */
function evaluer(etat, donnees) {
  const bareme = donnees.bareme, b = bareme.impot_revenu, prest = bareme.prestations;
  const h = etat.hypotheses;
  const { personnes, rfr: revenuNetImposable, imposable: revenuImposable } = revenusDesPersonnes(etat, bareme);
  const [principal] = personnes;
  const nEnfants = etat.enfants.length;
  const couple = etat.couple;

  // Impôt sur le revenu
  const foyer = { couple, enfants: nEnfants, parent_isole: h.parent_isole, part_deuxieme_enfant: etat.drapeaux.part_deuxieme_enfant };
  const impotAn = impotAnnuel(revenuImposable, foyer, bareme);
  const parts = nombreDeParts(foyer).parts;
  const impot = impotAn / 12;

  // Ressources mensuelles pour les prestations
  const activite = personnes.map(p => {
    if (p.statut === 'salarie_prive' || p.statut === 'fonctionnaire' || p.statut === 'etudiant') return p.net;
    if (p.statut === 'independant') return p.imposable_brut / 12;
    return 0;
  });
  const hors = personnes.map((p, i) => (p.statut === 'demandeur_emploi' || p.statut === 'retraite') ? p.net : 0);
  const revenusNets = somme(personnes, p => p.net);
  const ressourcesCaf = revenuNetImposable; // proxy du revenu net catégoriel N-2, avant exonération d'impôt

  const af = allocationsFamiliales(etat.enfants, ressourcesCaf, prest);
  const afNet = af.base + af.majoration;
  // Les ressources de la prime d'activité et du RSA comptent les allocations familiales de base, avant CRDS.
  const afBrute = af.base / (1 - prest.crds_prestations);
  const ars = allocationRentree(etat.enfants, ressourcesCaf, prest);

  // Aide au logement
  let apl = 0, aplSource = 'aucune';
  const pac = etat.enfants.filter(a => a < 21).length;
  if (etat.logement === 'locataire') {
    if (etat.apl_saisie !== null) { apl = etat.apl_saisie; aplSource = 'saisie'; }
    else if (etat.loyer > 0) {
      const a = prest.apl;
      // Étudiant de moins de 28 ans : forfait de ressources ; sinon revenu imposable arrondi à la centaine supérieure.
      const ressourcesApl = principal.statut === 'etudiant' && principal.age < a.etudiant_age_max
        ? Math.max(0, a.etudiant_forfait_ressources - (principal.boursier ? a.etudiant_minoration_boursier : 0))
        : revenuNetImposable;
      apl = estimerAidesLogement({ loyer: etat.loyer, zone: etat.zone, couple, enfants: pac, ressourcesAnnuelles: Math.ceil(Math.round(ressourcesApl * 100) / 100 / 100) * 100 }, bareme);
      aplSource = 'estimee';
    }
    apl = arrondi(apl * etat.drapeaux.apl_facteur);
  }

  const enfantsACharge = etat.enfants.filter(a => a < 25).length;
  const taille = 1 + (couple ? 1 : 0) + enfantsACharge;
  const logeSansLoyer = etat.logement === 'proprietaire' || etat.logement === 'gratuit';
  const majore = !couple && etat.enfants.some(a => a < 3) && h.parent_isole;

  // RSA
  const ressourcesRsa = somme(activite) + somme(hors) + afBrute;
  const age65 = principal.age >= prest.aspa.age_general;
  let rsa = 0;
  const peutRsa = !age65 && principal.statut !== 'etudiant' && (principal.age >= prest.rsa.age_minimum_sans_enfant || enfantsACharge > 0);
  if (peutRsa) {
    const forfaitL = prest.rsa.forfait_logement[Math.min(taille, 3)];
    const fl = logeSansLoyer ? forfaitL : (apl > 0 ? Math.min(apl, forfaitL) : 0);
    rsa = Math.max(0, forfaitRsa(couple, enfantsACharge, majore, prest.rsa) - ressourcesRsa - fl);
  }

  // Prime d'activité
  let prime = 0;
  const pa = prest.prime_activite, smic = bareme.smic;
  const plancherApprenant = pa.apprenant_heures * smic.horaire_brut * pa.apprenant_part_smic;
  const eligiblePrime = personnes.some((p, i) => {
    if (p.age < 18) return false;
    return p.statut === 'etudiant' ? activite[i] > plancherApprenant : activite[i] > 0;
  });
  if (eligiblePrime) {
    const forfait = forfaitPrimeActivite(couple, enfantsACharge, majore, pa, prest.rsa);
    const flBrut = forfaitLogementPrimeActivite(couple, enfantsACharge, pa);
    const aideFl = apl > 0 ? Math.min(apl, flBrut) : 0;
    const fl = Math.max(aideFl, logeSansLoyer ? flBrut : 0);
    const maxBonification = arrondi(pa.bonification_max_part_base * pa.base);
    const seuilBas = pa.bonification_seuil_bas_heures_smic * smic.horaire_brut;
    const seuilHaut = pa.bonification_seuil_haut_heures_smic * smic.horaire_brut;
    const bonification = somme(activite, v => borne(maxBonification * (v - seuilBas) / (seuilHaut - seuilBas), 0, maxBonification));
    const ressources = somme(activite) + somme(hors) + afBrute;
    const brute = Math.max(0, forfait + bonification + pa.part_revenus_activite * somme(activite) - Math.max(ressources + fl, forfait));
    prime = brute >= pa.seuil_versement ? brute * (1 - prest.crds_prestations) : 0;
  }

  // ASPA
  let aspa = 0;
  if (age65) {
    const plafondSeul = etat.drapeaux.aspa_seul ?? prest.aspa.seul;
    const deuxEligibles = couple && personnes.every(p => p.age >= prest.aspa.age_general);
    const plafond = deuxEligibles ? Math.max(prest.aspa.couple, plafondSeul) : plafondSeul;
    aspa = Math.max(0, plafond - (somme(activite) + somme(hors)));
  }

  const prestations = {
    allocations_familiales: arrondi(afNet), ars: arrondi(ars), apl: arrondi(apl), rsa: arrondi(rsa),
    prime_activite: arrondi(prime), aspa: arrondi(aspa),
  };

  // Transferts propres aux mesures
  let transferts = 0;
  const detailTransferts = [];
  if (etat.drapeaux.complement_etudiant) {
    const m = etat.drapeaux.complement_etudiant;
    personnes.forEach((p, i) => {
      if (p.statut !== 'etudiant' || activite[i] <= 0) return;
      const montantTransfert = p.boursier ? Math.min(m.taux_boursier * activite[i], m.plafond_mensuel_boursier) : Math.min(m.taux * activite[i], m.plafond_mensuel);
      transferts += montantTransfert;
      detailTransferts.push({ cle: 'complement_etudiant', montant: montantTransfert });
    });
  }
  if (etat.drapeaux.cvec) {
    for (const p of personnes) if (p.statut === 'etudiant' && !p.boursier) { transferts += etat.drapeaux.cvec / 12; detailTransferts.push({ cle: 'cvec', montant: etat.drapeaux.cvec / 12 }); }
  }

  const totalPrestations = somme(Object.values(prestations));
  let disponible = revenusNets - impot + totalPrestations + transferts;
  let planchers = 0;
  if (etat.drapeaux.plancher_disponible !== null && disponible < etat.drapeaux.plancher_disponible) {
    planchers = etat.drapeaux.plancher_disponible - disponible;
    disponible = etat.drapeaux.plancher_disponible;
  }
  return {
    revenus_nets: arrondi(revenusNets), impot_revenu: arrondi(impot), prestations, transferts: arrondi(transferts + planchers),
    revenu_disponible: arrondi(disponible),
    detail: {
      impot_annuel: impotAn, parts, revenu_imposable_annuel: arrondi(revenuImposable, 0), apl_source: aplSource,
      majoration_isolement: majore,
      personnes: personnes.map((p, i) => ({ statut: p.statut, age: p.age, net: arrondi(p.net), brut: arrondi(p.brut), activite: arrondi(activite[i]), classe_csg: p.classe_csg })),
    },
  };
}

/* ------------------------------------------------------------------------------ prix (TVA, électricité) */

function economieSurPrix(etat, bareme) {
  const d = etat.depenses, resultat = { total: 0, par_produit: {} };
  for (const k of PRODUITS) resultat.par_produit[k] = 0;
  const tauxActuel = bareme.tva.energie_usage;
  for (const k of PRODUITS) {
    let facteur = 1;
    if (etat.prix.tva && etat.prix.tva.produits.includes(k)) {
      const ecart = 1 - (1 + etat.prix.tva.taux_cible) / (1 + tauxActuel[k]);
      facteur *= 1 - etat.prix.tva.repercussion * ecart;
    }
    if (k === 'electricite' && etat.prix.electricite) facteur *= 1 - etat.prix.electricite.baisse * etat.prix.electricite.part;
    const economie = d[k] * (1 - facteur);
    resultat.par_produit[k] = arrondi(economie);
    resultat.total += economie;
  }
  resultat.total = arrondi(resultat.total);
  return resultat;
}

/* ------------------------------------------------------------------------------ mesures */

function concerne(m, contexte) {
  const jetons = m.concerne && m.concerne.length ? m.concerne : ['tous'];
  const { etat, actuel } = contexte;
  return jetons.some(j => {
    if (j === 'tous') return true;
    if (STATUTS_CONJOINT.includes(j)) return etat.personnes.some(p => p.statut === j);
    if (j === 'famille') return etat.enfants.length > 0;
    if (j === 'couple') return etat.couple;
    if (j === 'locataire') return etat.logement === 'locataire';
    if (j === 'proprietaire') return etat.logement === 'proprietaire';
    if (['electricite', 'gaz', 'fioul'].includes(j)) return etat.chauffage === j;
    if (j === 'jeune') return etat.personnes.some(p => p.age < 30);
    if (j === 'minima_sociaux') return actuel.prestations.rsa > 0 || actuel.prestations.aspa > 0;
    return false;
  });
}

/**
 * Applique une mesure chiffrable à l'état. Retourne { etat, raison } : `raison` est renseignée quand la mesure
 * ne s'applique pas ou ne peut pas être calculée avec les entrées fournies.
 */
function appliquer(m, etatBase, donnees, hyp) {
  const etat = copie(etatBase);
  const p = m.parametres;
  const bareme = donnees.bareme;
  const refus = (raison, calculable = true) => ({ etat: null, raison, calculable });
  switch (m.action) {
    case 'tva_energie': {
      const depense = somme(p.produits, k => etat.depenses[k]);
      if (depense <= 0) return refus('Aucune dépense d’électricité, de gaz, de fioul ou de carburant saisie.', false);
      etat.prix.tva = { taux_cible: p.taux_cible, produits: p.produits, repercussion: hyp.repercussion_tva };
      return { etat };
    }
    case 'prix_electricite': {
      if (etat.depenses.electricite <= 0) return refus('Aucune dépense d’électricité saisie.', false);
      etat.prix.electricite = { baisse: hyp.baisse_electricite, part: hyp.part_facture_electricite };
      return { etat };
    }
    case 'part_deuxieme_enfant': {
      if (etat.enfants.length < 2) return refus('Moins de deux enfants à charge.');
      etat.drapeaux.part_deuxieme_enfant = true;
      return { etat };
    }
    case 'ir_jeune': {
      const jeunes = etat.personnes.filter(x => x.age < p.age_strictement_inferieur);
      if (!jeunes.length) return refus('Aucun adulte du foyer n’a moins de 30 ans.');
      jeunes.forEach(x => { x.exonere_ir = true; });
      return { etat };
    }
    case 'complement_etudiant': {
      if (!etat.personnes.some(x => x.statut === 'etudiant')) return refus('Aucun étudiant dans le foyer.');
      etat.drapeaux.complement_etudiant = { taux: p.taux, plafond_mensuel: p.plafond_mensuel, taux_boursier: p.taux_boursier, plafond_mensuel_boursier: p.plafond_mensuel_boursier };
      return { etat };
    }
    case 'smic_net': {
      let touche = false, heuresManquantes = false;
      for (const x of etat.personnes) {
        if (!['salarie_prive', 'fonctionnaire', 'etudiant'].includes(x.statut)) continue;
        if (!x.heures) { heuresManquantes = true; continue; }
        const cible = p.mensuel_net_35h * x.heures / 35;
        const optionsPersonne = { activite_micro: hyp.activite_micro, part_primes_fonctionnaire: hyp.part_primes_fonctionnaire };
        const netActuel = x.type === 'net' ? x.revenu : netDepuisBrut(x.revenu, x.statut, bareme, optionsPersonne);
        if (netActuel > 0 && netActuel < cible) { x.revenu = cible; x.type = 'net'; touche = true; }
      }
      if (!touche && heuresManquantes) return refus('Temps de travail hebdomadaire non saisi : impossible de rapporter le SMIC à votre durée de travail.', false);
      if (!touche) return refus('Votre salaire net dépasse déjà 1 600 € rapportés à votre temps de travail, ou vous n’êtes pas salarié.');
      return { etat };
    }
    case 'point_indice': {
      let touche = false;
      for (const x of etat.personnes) {
        if (x.statut !== 'fonctionnaire' || x.revenu <= 0) continue;
        const optionsPersonne = { part_primes_fonctionnaire: hyp.part_primes_fonctionnaire };
        const brut = x.type === 'brut' ? x.revenu : brutDepuisNet(x.revenu, x.statut, bareme, optionsPersonne);
        x.revenu = brut * (1 + p.hausse * (1 - hyp.part_primes_fonctionnaire));
        x.type = 'brut';
        touche = true;
      }
      if (!touche) return refus('Aucun fonctionnaire dans le foyer.');
      return { etat };
    }
    case 'apl_hausse': {
      if (etat.logement !== 'locataire') return refus('Vous n’êtes pas locataire.');
      if (etat.apl_saisie === null && !(etat.loyer > 0)) return refus('Loyer et aide au logement non saisis : l’aide actuelle est inconnue.', false);
      etat.drapeaux.apl_facteur = 1 + p.hausse;
      return { etat };
    }
    case 'garantie_autonomie': {
      const x = etat.personnes[0];
      if (!['etudiant', 'demandeur_emploi'].includes(x.statut)) return refus('Mesure destinée aux jeunes étudiants ou sans emploi.');
      if (etat.couple || etat.enfants.length) return refus('Le seuil de 1 216 € est donné pour une personne seule sans enfant.');
      if (x.age > hyp.age_max_jeunes) return refus(`Vous avez plus de ${hyp.age_max_jeunes} ans (limite réglable).`);
      etat.drapeaux.plancher_disponible = p.seuil_personne_seule;
      return { etat };
    }
    case 'minimum_vieillesse': {
      const x = etat.personnes[0];
      if (x.age < bareme.prestations.aspa.age_general) return refus('Moins de 65 ans : pas de minimum vieillesse.');
      if (etat.couple) return refus('Le seuil de pauvreté d’un couple n’est pas donné dans le texte.', false);
      etat.drapeaux.aspa_seul = p.seuil_personne_seule;
      return { etat };
    }
    case 'supprimer_cvec': {
      if (!etat.personnes.some(x => x.statut === 'etudiant' && !x.boursier)) return refus('Aucun étudiant non boursier dans le foyer.');
      etat.drapeaux.cvec = bareme.etudiants.cvec;
      return { etat };
    }
    default:
      throw new Error(`Action de mesure inconnue : ${m.action}`);
  }
}

function composantes(a, b) {
  const prestations = {};
  for (const k of Object.keys(a.prestations)) prestations[k] = arrondi(b.prestations[k] - a.prestations[k]);
  return {
    revenus_nets: arrondi(b.revenus_nets - a.revenus_nets), impot_revenu: arrondi(-(b.impot_revenu - a.impot_revenu)),
    prestations, transferts: arrondi(b.transferts - a.transferts),
  };
}

function resumeSource(m) {
  return {
    id: m.id, doc: m.source.doc, page: m.source.page, url: m.source.url, citation: m.source.citation,
    autres: (m.autres_sources || []).map(s => ({ id: s.id, doc: s.doc, page: s.page, url: s.url, citation: s.citation })),
  };
}

function hypothesesDeMesure(m, valeurs, defs) {
  return (m.hypotheses || []).map(cle => ({ cle, libelle: defs[cle].libelle, valeur: valeurs[cle], defaut: defs[cle].defaut }));
}

function calculerParti(parti, donnees, etatBase, actuel, economieActuelle, valeurs, contexte) {
  const defs = donnees.hypotheses || {};
  const mesuresParti = donnees.mesures.filter(m => m.parti === parti);
  const retenues = [], ecartees = [], nonChiffrables = [];
  let etatCumule = copie(etatBase);
  for (const m of mesuresParti) {
    const pertinent = concerne(m, contexte);
    if (m.statut !== 'chiffrable') {
      if (pertinent) nonChiffrables.push({
        id: m.id, libelle: m.libelle, raison: m.manque, condition: m.condition_non_saisie || null,
        parametres: m.parametres || null, source: resumeSource(m),
      });
      continue;
    }
    if (!pertinent) { ecartees.push({ id: m.id, libelle: m.libelle, raison: 'Ne concerne pas votre situation.' }); continue; }
    const r = appliquer(m, etatBase, donnees, valeurs);
    if (!r.etat) {
      if (r.calculable === false) nonChiffrables.push({ id: m.id, libelle: m.libelle, raison: r.raison, condition: null, parametres: m.parametres, source: resumeSource(m) });
      else ecartees.push({ id: m.id, libelle: m.libelle, raison: r.raison });
      continue;
    }
    const seule = evaluer(r.etat, donnees);
    const prixSeul = economieSurPrix(r.etat, donnees.bareme);
    const variationRevenu = arrondi(seule.revenu_disponible - actuel.revenu_disponible);
    const variationPrix = arrondi(prixSeul.total - economieActuelle.total);
    retenues.push({
      id: m.id, libelle: m.libelle, nature: m.nature, variation_mensuelle: arrondi(variationRevenu + variationPrix),
      variation_revenu: variationRevenu, variation_prix: variationPrix,
      effets: composantes(actuel, seule), effets_prix: Object.fromEntries(PRODUITS.map(k => [k, arrondi(prixSeul.par_produit[k] - economieActuelle.par_produit[k])])),
      parametres: m.parametres, hypotheses: hypothesesDeMesure(m, valeurs, defs), hypotheses_fixes: m.hypotheses_fixes || [],
      note: m.note || null, source: resumeSource(m),
    });
    const suite = appliquer(m, etatCumule, donnees, valeurs);
    if (suite.etat) etatCumule = suite.etat;
  }
  const scenario = evaluer(etatCumule, donnees);
  const prixScenario = economieSurPrix(etatCumule, donnees.bareme);
  const ecartRevenu = arrondi(scenario.revenu_disponible - actuel.revenu_disponible);
  const ecartPrix = arrondi(prixScenario.total - economieActuelle.total);
  const sommeIsolee = arrondi(somme(retenues, x => x.variation_mensuelle));
  const interactions = arrondi(ecartRevenu + ecartPrix - sommeIsolee);
  return {
    revenu_disponible: arrondi(scenario.revenu_disponible + prixScenario.total - economieActuelle.total),
    revenu_disponible_hors_prix: scenario.revenu_disponible,
    ecart_actuel: arrondi(ecartRevenu + ecartPrix), ecart_revenu: ecartRevenu, ecart_prix: ecartPrix,
    interactions: Math.abs(interactions) >= 0.01 ? interactions : 0,
    prestations: scenario.prestations, impot_revenu: scenario.impot_revenu, revenus_nets: scenario.revenus_nets,
    mesures: retenues, non_chiffrables: nonChiffrables, ecartees,
  };
}

/* ------------------------------------------------------------------------------ point d'entrée */

/**
 * Calcule le revenu disponible actuel et sous chaque programme.
 * @param situation  entrées du ménage (voir tests/simulateur.test.mjs pour un exemple)
 * @param donnees    JSON de tools/sim_data.py
 * @param options    valeurs des hypothèses réglables (voir `donnees.hypotheses`)
 */
export function calculer(situation, donnees, options = {}) {
  if (!donnees?.bareme || !Array.isArray(donnees.mesures)) throw new Error('Données du simulateur invalides');
  const valeurs = resoudreOptions(donnees, options);
  const etat = normaliser(situation, donnees.bareme, valeurs);
  const actuel = evaluer(etat, donnees);
  const economieActuelle = economieSurPrix(etat, donnees.bareme);
  const contexte = { etat, actuel };
  const rn = calculerParti('rn', donnees, etat, actuel, economieActuelle, valeurs, contexte);
  const lfi = calculerParti('lfi', donnees, etat, actuel, economieActuelle, valeurs, contexte);

  const avertissements = [];
  const smicNet = donnees.bareme.smic.mensuel_net_indicatif;
  etat.personnes.forEach((p, i) => {
    if (p.heures && ['salarie_prive', 'fonctionnaire'].includes(p.statut) && p.revenu > 0 && (p.type === 'net' ? p.revenu : actuel.detail.personnes[i].net) < smicNet * p.heures / 35 * 0.98) {
      avertissements.push(`${i === 0 ? 'Votre' : 'Le'} salaire net semble inférieur au SMIC net rapporté à ${p.heures} heures par semaine : vérifiez le montant ou le temps de travail.`);
    }
  });
  if (etat.personnes[0].statut === 'retraite' && etat.personnes[0].age < 55) avertissements.push('Âge inhabituel pour un retraité : vérifiez la saisie.');
  if (etat.logement === 'locataire' && etat.apl_saisie === null && !(etat.loyer > 0)) avertissements.push("Loyer non saisi : aucune aide au logement n'est comptée.");

  return {
    version: VERSION,
    date_reference: donnees.date_reference || donnees.bareme.date_reference,
    actuel: { ...actuel, depenses: etat.depenses },
    rn, lfi,
    non_chiffrables: { rn: rn.non_chiffrables, lfi: lfi.non_chiffrables },
    hypotheses: {
      valeurs,
      reglables: Object.entries(donnees.hypotheses || {}).map(([cle, h]) => ({ cle, libelle: h.libelle, valeur: valeurs[cle], defaut: h.defaut })),
      generales: donnees.hypotheses_generales || [],
    },
    avertissements,
    libelles_prestations: LIBELLES_PRESTATIONS,
  };
}
