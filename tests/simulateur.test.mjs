// Tests du moteur site_src/static/js/simulateur.js (Node >= 18, sans dépendance).
//   SIM_DATA=chemin/simulateur.json node --test tests/simulateur.test.mjs
// Le JSON vient de `python tools/sim_data.py` ; à défaut, de la dernière construction (public/static/data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const racine = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const moteur = await import(pathToFileURL(resolve(racine, 'site_src/static/js/simulateur.js')).href);
const donnees = JSON.parse(readFileSync(process.env.SIM_DATA || resolve(racine, 'public/static/data/simulateur.json'), 'utf8'));
const { calculer, netDepuisBrut, brutDepuisNet, impotAnnuel, estimerAidesLogement } = moteur;

const base = (extra = {}) => ({
  statut: 'salarie_prive', type_revenu: 'net', revenu: 1477.93, age: 35, couple: false, enfants: [],
  logement: 'locataire', loyer: 0, ...extra,
});
const proche = (a, b, tolerance = 0.011, message) => assert.ok(Math.abs(a - b) <= tolerance, message || `${a} diffère de ${b}`);
const mesure = (resultat, parti, id) => resultat[parti].mesures.find(m => m.id === id);

/* ---------------------------------------------------------------- barème : calculs vérifiés à la main */

test('SMIC : 1 867,02 € brut donnent 1 477,93 € net (valeur indicative de Service-Public)', () => {
  proche(netDepuisBrut(1867.02, 'salarie_prive', donnees.bareme), 1477.93);
  proche(brutDepuisNet(1477.93, 'salarie_prive', donnees.bareme), 1867.02, 0.02);
});

test('impôt sur le revenu : barème, quotient familial, plafonnement et décote', () => {
  const b = donnees.bareme;
  // 40 000 € pour une part : 11 % de 17 979 + 30 % de 10 421 = 5 104,0
  assert.equal(impotAnnuel(40000, { couple: false, enfants: 0 }, b), 5104);
  // couple, 2 enfants (3 parts), 60 000 € : 3 x 924 = 2 772 ; plafond non atteint ; décote couple 1 483 - 45,25 % x 2 772 = 228,8
  assert.equal(impotAnnuel(60000, { couple: true, enfants: 2 }, b), 2543);
  // parent isolé, 1 enfant (2 parts), 40 000 € : 2 x 924 = 1 848 ; plafond 5 104 - 4 262 = 842 ; décote 897 - 45,25 % x 1 848 = 60,8
  assert.equal(impotAnnuel(40000, { couple: false, enfants: 1, parent_isole: true }, b), 1787);
  // sous le premier seuil : aucun impôt ; sous 61 € : non recouvré
  assert.equal(impotAnnuel(11600, { couple: false, enfants: 0 }, b), 0);
  assert.equal(impotAnnuel(12000, { couple: false, enfants: 0 }, b), 0);
});

test('prime d’activité d’un célibataire au SMIC : 229,72 € après CRDS', () => {
  const r = calculer(base(), donnees);
  proche(r.actuel.prestations.prime_activite, 229.72);
  assert.equal(r.actuel.impot_revenu, 0);
  proche(r.actuel.revenu_disponible, 1477.93 + 229.72);
});

test('RSA : personne seule sans revenu, parent isolé avec un enfant de moins de 3 ans', () => {
  const seul = calculer(base({ statut: 'demandeur_emploi', revenu: 0 }), donnees);
  proche(seul.actuel.prestations.rsa, 651.69);
  assert.equal(seul.actuel.prestations.prime_activite, 0);
  const parent = calculer(base({ statut: 'demandeur_emploi', revenu: 0, enfants: [2] }), donnees);
  proche(parent.actuel.prestations.rsa, 1115.80);
});

test('allocations familiales : deux enfants, ressources moyennes, et majoration d’âge', () => {
  const r = calculer(base({ couple: true, conjoint: { statut: 'sans_activite', age: 35, revenu: 0 }, enfants: [8, 12], revenu: 1477.93 }), donnees);
  proche(r.actuel.prestations.allocations_familiales, 152.25);
  const grand = calculer(base({ couple: true, conjoint: { statut: 'sans_activite', age: 35, revenu: 0 }, enfants: [5, 9, 16], revenu: 2374.79 }), donnees);
  proche(grand.actuel.prestations.allocations_familiales, 347.32 + 76.13);
});

test('aide au logement estimée : plausible et nulle pour un revenu élevé', () => {
  const b = donnees.bareme;
  const modeste = estimerAidesLogement({ loyer: 450, zone: 2, couple: false, enfants: 0, ressourcesAnnuelles: 11600 }, b);
  assert.ok(modeste > 100 && modeste < 125, `aide ${modeste}`);
  assert.equal(estimerAidesLogement({ loyer: 450, zone: 2, couple: false, enfants: 0, ressourcesAnnuelles: 30000 }, b), 0);
  assert.equal(estimerAidesLogement({ loyer: 0, zone: 2, couple: false, enfants: 0, ressourcesAnnuelles: 0 }, b), 0);
});

test('ASPA : retraité seul de 72 ans à 800 € net', () => {
  const r = calculer({ statut: 'retraite', type_revenu: 'net', revenu: 800, age: 72, couple: false, enfants: [], logement: 'proprietaire' }, donnees);
  proche(r.actuel.prestations.aspa, 1043.59 - 800);
  proche(r.actuel.revenu_disponible, 1043.59);
});

/* ---------------------------------------------------------------- mesures */

test('TVA sur l’énergie : effet proportionnel à la dépense et à la répercussion', () => {
  const s = base({ carburant_mensuel: 100 });
  const plein = calculer(s, donnees);
  proche(mesure(plein, 'rn', 'RNEU-14').variation_mensuelle, 100 * (1 - 1.055 / 1.2));
  const moitie = calculer(s, donnees, { repercussion_tva: 0.5 });
  proche(mesure(moitie, 'rn', 'RNEU-14').variation_mensuelle, 50 * (1 - 1.055 / 1.2));
  const nul = calculer(s, donnees, { repercussion_tva: 0 });
  assert.equal(mesure(nul, 'rn', 'RNEU-14').variation_mensuelle, 0);
  assert.equal(mesure(plein, 'rn', 'RNEU-14').nature, 'prix');
});

test('électricité −30 % et TVA : effets isolés et écart d’interaction', () => {
  const r = calculer(base({ electricite_mensuelle: 100 }), donnees);
  proche(mesure(r, 'rn', 'RNENT-01').variation_mensuelle, 30);
  proche(mesure(r, 'rn', 'RNEU-14').variation_mensuelle, 100 * (1 - 1.055 / 1.2));
  const total = 100 * (1 - 0.7 * 1.055 / 1.2);
  proche(r.rn.ecart_prix, total);
  proche(r.rn.interactions, total - 30 - 100 * (1 - 1.055 / 1.2));
  const haut = calculer(base({ electricite_mensuelle: 100 }), donnees, { baisse_electricite: 0.4 });
  proche(mesure(haut, 'rn', 'RNENT-01').variation_mensuelle, 40);
  assert.throws(() => calculer(base(), donnees, { baisse_electricite: 0.5 }), /hors bornes/);
});

test('part fiscale dès le deuxième enfant : gain égal à la baisse d’impôt', () => {
  const s = base({ type_revenu: 'net', revenu: 4200, couple: true, conjoint: { statut: 'salarie_prive', age: 38, revenu: 3500 }, enfants: [5, 9], age: 38 });
  const r = calculer(s, donnees);
  const m = mesure(r, 'rn', 'RNFAM-02');
  assert.ok(m.variation_mensuelle > 0 && m.variation_mensuelle <= 1807 / 12 + 0.01, `gain ${m.variation_mensuelle}`);
  assert.ok(Math.abs(m.effets.impot_revenu - m.variation_mensuelle) < 0.011);
  // sans deuxième enfant : mesure écartée et non chiffrée
  const un = calculer({ ...s, enfants: [5] }, donnees);
  assert.equal(mesure(un, 'rn', 'RNFAM-02'), undefined);
});

test('exonération d’IR avant 30 ans : jamais plus que l’impôt versé', () => {
  const s = base({ revenu: 4000, age: 25, enfants: [] });
  const r = calculer(s, donnees);
  const m = mesure(r, 'rn', 'RN24-087');
  proche(m.variation_mensuelle, r.actuel.impot_revenu);
  assert.ok(r.actuel.impot_revenu > 0);
  const vieux = calculer({ ...s, age: 30 }, donnees);
  assert.equal(mesure(vieux, 'rn', 'RN24-087'), undefined);
  assert.ok(vieux.rn.ecartees.some(x => x.id === 'RN24-087'));
  // un revenu déjà non imposable ne crée pas de crédit d'impôt
  const modeste = calculer(base({ age: 22 }), donnees);
  assert.equal(mesure(modeste, 'rn', 'RN24-087').variation_mensuelle, 0);
});

test('l’exonération d’IR ne change pas les ressources retenues pour les prestations', () => {
  const s = base({ revenu: 3000, age: 25, enfants: [4, 8], couple: false, loyer: 700 });
  const r = calculer(s, donnees);
  const m = mesure(r, 'rn', 'RN24-087');
  assert.deepEqual(m.effets.prestations, Object.fromEntries(Object.keys(m.effets.prestations).map(k => [k, 0])));
});

test('complément de revenu des étudiants : 20 % plafonné à 200 €, 30 % plafonné à 300 € pour un boursier', () => {
  const etu = base({ statut: 'etudiant', age: 21, revenu: 600, heures_hebdo: 10 });
  proche(mesure(calculer(etu, donnees), 'rn', 'RNJEU-06').variation_mensuelle, 120);
  proche(mesure(calculer({ ...etu, revenu: 1500 }, donnees), 'rn', 'RNJEU-06').variation_mensuelle, 200);
  proche(mesure(calculer({ ...etu, boursier: true, revenu: 700 }, donnees), 'rn', 'RNJEU-06').variation_mensuelle, 210);
  proche(mesure(calculer({ ...etu, boursier: true, revenu: 1500 }, donnees), 'rn', 'RNJEU-06').variation_mensuelle, 300);
});

test('SMIC à 1 600 € net : prorata du temps de travail, effets sur l’impôt et les prestations compris', () => {
  const r = calculer(base({ revenu: 1500 }), donnees);
  const m = mesure(r, 'lfi', 'LFI-08.04-01');
  proche(m.effets.revenus_nets, 100);
  assert.ok(m.variation_mensuelle > 0 && m.variation_mensuelle < 100, 'la prime d’activité diminue');
  proche(m.effets.prestations.prime_activite + m.effets.revenus_nets + m.effets.impot_revenu, m.variation_mensuelle, 0.03);
  const mi = calculer(base({ revenu: 900, heures_hebdo: 20 }), donnees);
  proche(mesure(mi, 'lfi', 'LFI-08.04-01').effets.revenus_nets, 1600 * 20 / 35 - 900);
  const deja = calculer(base({ revenu: 1700 }), donnees);
  assert.equal(mesure(deja, 'lfi', 'LFI-08.04-01'), undefined);
  const inconnu = calculer(base({ statut: 'etudiant', age: 21, revenu: 600 }), donnees);
  assert.ok(inconnu.non_chiffrables.lfi.some(x => x.id === 'LFI-08.04-01'), 'heures non saisies : mesure non chiffrable');
});

test('point d’indice des fonctionnaires : +10 % du brut, hors primes', () => {
  const s = base({ statut: 'fonctionnaire', type_revenu: 'brut', revenu: 3000 });
  const r = calculer(s, donnees);
  const m = mesure(r, 'lfi', 'LFI-09.01-04');
  proche(m.effets.revenus_nets, netDepuisBrut(3300, 'fonctionnaire', donnees.bareme) - netDepuisBrut(3000, 'fonctionnaire', donnees.bareme));
  const primes = calculer(s, donnees, { part_primes_fonctionnaire: 0.5 });
  assert.ok(mesure(primes, 'lfi', 'LFI-09.01-04').effets.revenus_nets < m.effets.revenus_nets);
  assert.equal(mesure(calculer(base(), donnees), 'lfi', 'LFI-09.01-04'), undefined);
});

test('APL +10 % : sur le montant saisi, ou estimé à partir du loyer', () => {
  const r = calculer(base({ revenu: 900, apl_actuelle: 200 }), donnees);
  const m = mesure(r, 'lfi', 'LFI-09.01-05');
  proche(m.variation_mensuelle, 20, 0.5);
  const sans = calculer(base({ logement: 'locataire', loyer: 0 }), donnees);
  assert.ok(sans.non_chiffrables.lfi.some(x => x.id === 'LFI-09.01-05'));
  assert.equal(calculer(base({ logement: 'proprietaire' }), donnees).lfi.mesures.some(x => x.id === 'LFI-09.01-05'), false);
});

test('garantie d’autonomie et minimum vieillesse à 1 216 €', () => {
  const jeune = calculer(base({ statut: 'etudiant', age: 20, revenu: 0, logement: 'gratuit', heures_hebdo: 5 }), donnees);
  assert.equal(jeune.lfi.revenu_disponible, 1216);
  proche(mesure(jeune, 'lfi', 'LFI-10.03-01').variation_mensuelle, 1216 - jeune.actuel.revenu_disponible);
  const trop = calculer(base({ statut: 'etudiant', age: 27, revenu: 0, logement: 'gratuit' }), donnees);
  assert.equal(mesure(trop, 'lfi', 'LFI-10.03-01'), undefined);
  const permis = calculer(base({ statut: 'etudiant', age: 27, revenu: 0, logement: 'gratuit' }), donnees, { age_max_jeunes: 28 });
  assert.equal(permis.lfi.revenu_disponible, 1216);
  const retraite = calculer({ statut: 'retraite', type_revenu: 'net', revenu: 800, age: 72, couple: false, enfants: [], logement: 'proprietaire' }, donnees);
  proche(mesure(retraite, 'lfi', 'LFI-08.08-02').variation_mensuelle, 1216 - 1043.59);
  const couple = calculer({ statut: 'retraite', type_revenu: 'net', revenu: 800, age: 72, couple: true, conjoint: { statut: 'retraite', age: 70, revenu: 500 }, enfants: [], logement: 'proprietaire' }, donnees);
  assert.ok(couple.non_chiffrables.lfi.some(x => x.id === 'LFI-08.08-02'));
});

test('CVEC : supprimée pour un étudiant non boursier, déjà nulle pour un boursier', () => {
  const s = base({ statut: 'etudiant', age: 20, revenu: 500, heures_hebdo: 8 });
  proche(mesure(calculer(s, donnees), 'lfi', 'LFI-05.06-03').variation_mensuelle, 105 / 12);
  assert.equal(mesure(calculer({ ...s, boursier: true }, donnees), 'lfi', 'LFI-05.06-03'), undefined);
});

/* ---------------------------------------------------------------- structure du résultat, neutralité, erreurs */

test('les deux programmes ont la même structure de résultat et les mêmes règles', () => {
  const r = calculer(base({ revenu: 2500, enfants: [6], electricite_mensuelle: 90, carburant_mensuel: 120, logement: 'locataire', loyer: 700 }), donnees);
  assert.deepEqual(Object.keys(r.rn).sort(), Object.keys(r.lfi).sort());
  for (const p of ['rn', 'lfi']) {
    assert.ok(Array.isArray(r[p].mesures) && Array.isArray(r[p].non_chiffrables));
    const somme = r[p].mesures.reduce((s, m) => s + m.variation_mensuelle, 0);
    proche(r[p].ecart_actuel, somme + r[p].interactions, 0.03);
    proche(r[p].revenu_disponible, r.actuel.revenu_disponible + r[p].ecart_actuel, 0.03);
    for (const m of r[p].mesures) assert.ok(m.source.page > 0 && m.source.url.startsWith('http') && m.source.citation.length > 5);
  }
});

test('les mesures non chiffrables pertinentes sont listées avec leur motif', () => {
  const r = calculer({ statut: 'retraite', type_revenu: 'net', revenu: 1500, age: 70, couple: false, enfants: [], logement: 'proprietaire' }, donnees);
  const ids = r.non_chiffrables.rn.map(x => x.id);
  assert.ok(ids.includes('RN24-058'), 'réforme des retraites');
  assert.ok(r.non_chiffrables.lfi.some(x => x.id === 'LFI-08.08-01'));
  for (const parti of ['rn', 'lfi']) for (const x of r.non_chiffrables[parti]) assert.ok(x.raison && x.source.page > 0, `${x.id} sans motif`);
  const famille = calculer(base({ enfants: [3, 7] }), donnees);
  assert.ok(famille.non_chiffrables.rn.some(x => x.id === 'RN24-008' || x.id === 'RN24-026'));
});

test('toutes les mesures chiffrables ont une action calculable', () => {
  const riche = { statut: 'etudiant', type_revenu: 'net', revenu: 800, age: 22, heures_hebdo: 12, couple: false, enfants: [], logement: 'locataire', loyer: 500, electricite_mensuelle: 80, carburant_mensuel: 80 };
  const situations = [
    riche,
    base({ statut: 'fonctionnaire', type_revenu: 'brut', revenu: 2400, age: 27, couple: true, conjoint: { statut: 'salarie_prive', age: 28, revenu: 1700 }, enfants: [3, 6], loyer: 800, electricite_mensuelle: 80 }),
    { statut: 'retraite', type_revenu: 'net', revenu: 700, age: 70, couple: false, enfants: [], logement: 'proprietaire' },
    base({ revenu: 1300, loyer: 450, apl_actuelle: 110 }),
  ];
  const vus = new Set();
  for (const s of situations) {
    const r = calculer(s, donnees);
    for (const p of ['rn', 'lfi']) for (const m of r[p].mesures) { assert.ok(Number.isFinite(m.variation_mensuelle)); vus.add(m.id); }
  }
  const chiffrables = donnees.mesures.filter(m => m.statut === 'chiffrable').map(m => m.id);
  for (const id of chiffrables) assert.ok(vus.has(id), `${id} jamais appliquée`);
});

test('entrées invalides : erreurs explicites', () => {
  assert.throws(() => calculer(base({ statut: 'astronaute' }), donnees), /Statut inconnu/);
  assert.throws(() => calculer(base({ revenu: -5 }), donnees), /Montant invalide/);
  assert.throws(() => calculer(base({ enfants: [30] }), donnees), /Âge d'enfant/);
  assert.throws(() => calculer(base({ age: 5 }), donnees), /Âge invalide/);
  assert.throws(() => calculer(base({ carburant_mensuel: 'x' }), donnees), /Montant invalide/);
  assert.throws(() => calculer(base({ heures_hebdo: 99 }), donnees), /Temps de travail/);
  assert.throws(() => calculer(base(), { bareme: {} }), /Données du simulateur invalides/);
});

test('retraité : la classe de CSG automatique suit le revenu', () => {
  const faible = calculer({ statut: 'retraite', type_revenu: 'brut', revenu: 900, age: 70, couple: false, enfants: [], logement: 'proprietaire' }, donnees);
  assert.equal(faible.actuel.detail.personnes[0].classe_csg, 'exonere');
  const eleve = calculer({ statut: 'retraite', type_revenu: 'brut', revenu: 3000, age: 70, couple: false, enfants: [], logement: 'proprietaire' }, donnees);
  assert.equal(eleve.actuel.detail.personnes[0].classe_csg, 'plein');
  proche(eleve.actuel.revenus_nets, 3000 * (1 - 0.083 - 0.005 - 0.003));
  const force = calculer({ statut: 'retraite', type_revenu: 'brut', revenu: 900, age: 70, couple: false, enfants: [], logement: 'proprietaire' }, donnees, { csg_retraite: 'plein' });
  proche(force.actuel.revenus_nets, 900 * (1 - 0.091));
});

test('micro-entrepreneur : cotisations et abattement selon l’activité', () => {
  const s = { statut: 'independant', type_revenu: 'brut', revenu: 2000, age: 40, couple: false, enfants: [], logement: 'proprietaire' };
  proche(calculer(s, donnees).actuel.revenus_nets, 2000 * (1 - 0.212));
  proche(calculer(s, donnees, { activite_micro: 'vente' }).actuel.revenus_nets, 2000 * (1 - 0.123));
  assert.equal(calculer(s, donnees).actuel.detail.revenu_imposable_annuel, 12 * 2000 * 0.5);
});
