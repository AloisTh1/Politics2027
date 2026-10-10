// Interface du simulateur : formulaire -> moteur (simulateur.js) -> résultats.
// Les données du barème et des mesures sont chargées une fois depuis static/data/simulateur.json.
import { chargerDonnees, calculer, valeursParDefaut } from './simulateur.js';

const URL_DONNEES = 'static/data/simulateur.json';
const PARTIS = { rn: 'Rassemblement national', lfi: 'La France insoumise' };
const NOMS_PROGRAMMES = { rn: 'Programme du Rassemblement national', lfi: 'Programme de La France insoumise' };
const LIBELLES_REVENU = {
  salarie_prive: 'Salaire mensuel', fonctionnaire: 'Rémunération mensuelle, traitement et primes',
  independant: 'Chiffre d’affaires mensuel, micro-entreprise', demandeur_emploi: 'Allocation chômage mensuelle',
  retraite: 'Pension de retraite mensuelle', etudiant: 'Revenu mensuel d’activité, job étudiant', sans_activite: 'Revenu mensuel',
};
const NOMS_PRESTATIONS = {
  allocations_familiales: 'Allocations familiales', ars: 'Allocation de rentrée scolaire (lissée sur l’année)',
  apl: 'Aide au logement', rsa: 'RSA', prime_activite: 'Prime d’activité', aspa: 'ASPA (minimum vieillesse)',
};
const NOMS_PRODUITS = { electricite: 'électricité', gaz: 'gaz', fioul: 'fioul', carburant: 'carburant' };
const NOMS_PARAMETRES = {
  taux_cible: 'taux cible', produits: 'produits concernés', baisse: 'baisse', baisse_haute: 'borne haute citée',
  part_deuxieme_enfant: 'part fiscale du 2e enfant', part_actuelle: 'part actuelle du 2e enfant',
  age_strictement_inferieur: 'âge limite (strictement inférieur à)', taux: 'taux', plafond_mensuel: 'plafond mensuel (€)',
  taux_boursier: 'taux pour un boursier', plafond_mensuel_boursier: 'plafond mensuel pour un boursier (€)',
  mensuel_net_35h: 'SMIC net pour 35 heures (€)', hausse: 'hausse', seuil_personne_seule: 'seuil pour une personne seule (€)',
  suppression: 'suppression',
};

const euro0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const euro2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pourcent = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 });

const formatSigne = (x, format = euro2) => {
  if (Math.abs(x) < 0.005) return format.format(0);
  return (x > 0 ? '+' : '−') + format.format(Math.abs(x)).replace(/^−/, '');
};

function el(tag, options = {}, ...enfants) {
  const noeud = document.createElement(tag);
  const { text, className, attrs, dataset } = options;
  if (text !== undefined) noeud.textContent = text;
  if (className) noeud.className = className;
  for (const [cle, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) noeud.setAttribute(cle, v === true ? '' : v);
  for (const [cle, v] of Object.entries(dataset || {})) noeud.dataset[cle] = v;
  for (const e of enfants.flat()) if (e) noeud.append(e);
  return noeud;
}

const form = document.getElementById('simulateur-form');
const resultat = document.getElementById('simulateur-resultat');
const statut = document.getElementById('simulateur-statut');
const erreur = document.getElementById('simulateur-erreur');
const champsHypotheses = document.getElementById('sim-hypotheses-champs');
let donnees = null;
let derniereSituation = null;

/* ------------------------------------------------------------------ formulaire */

const champ = nom => form.elements[nom];
const texte = nom => champ(nom).value.trim();
const nombre = nom => (texte(nom) === '' ? undefined : Number(texte(nom).replace(',', '.')));

function visibleParStatut(noeud) {
  const groupe = noeud.closest('#sim-conjoint') ? champ('conjoint_statut').value : champ('statut').value;
  const liste = noeud.dataset.visiblePour;
  const cache = noeud.dataset.cachePour;
  if (liste && !liste.split(' ').includes(groupe)) return false;
  if (cache && cache.split(' ').includes(groupe)) return false;
  return true;
}

function majVisibilite() {
  document.getElementById('sim-conjoint').hidden = champ('couple').value !== 'oui';
  for (const noeud of form.querySelectorAll('[data-visible-pour],[data-cache-pour]')) noeud.hidden = !visibleParStatut(noeud);
  for (const noeud of form.querySelectorAll('[data-visible-logement]')) noeud.hidden = champ('logement').value !== noeud.dataset.visibleLogement;
  document.querySelector('[data-libelle-revenu]').textContent = `${LIBELLES_REVENU[champ('statut').value]} (€)`;
  document.querySelector('[data-libelle-revenu-conjoint]').textContent = `${LIBELLES_REVENU[champ('conjoint_statut').value]} (€)`;
  for (const [nomHeures, nomStatut] of [['heures_hebdo', 'statut'], ['conjoint_heures_hebdo', 'conjoint_statut']]) {
    const heures = champ(nomHeures), s = champ(nomStatut).value;
    if (heures.value === '' || heures.dataset.auto) {
      heures.value = ['salarie_prive', 'fonctionnaire'].includes(s) ? '35' : '';
      heures.dataset.auto = '1';
      heures.placeholder = s === 'etudiant' ? 'Par exemple : 10' : '';
    }
  }
}

function ageEnfants() {
  const brut = texte('enfants');
  if (!brut) return [];
  const ages = brut.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (ages.some(a => !Number.isInteger(a) || a < 0 || a > 24)) throw new Error('Indiquez les âges des enfants à charge par des nombres entiers de 0 à 24, séparés par des virgules.');
  return ages;
}

function lireSituation() {
  const couple = champ('couple').value === 'oui';
  const visible = nom => !champ(nom).closest('[hidden]');
  const situation = {
    statut: champ('statut').value, age: nombre('age'), revenu: nombre('revenu') ?? 0, type_revenu: champ('type_revenu').value,
    heures_hebdo: visible('heures_hebdo') ? nombre('heures_hebdo') : undefined, boursier: visible('boursier') && champ('boursier').checked,
    couple, enfants: ageEnfants(), logement: champ('logement').value, loyer: nombre('loyer') ?? 0, zone_apl: Number(champ('zone_apl').value),
    apl_actuelle: champ('logement').value === 'locataire' ? nombre('apl_actuelle') : undefined, chauffage: champ('chauffage').value,
    electricite_mensuelle: nombre('electricite_mensuelle') ?? 0, gaz_mensuel: nombre('gaz_mensuel') ?? 0,
    fioul_mensuel: nombre('fioul_mensuel') ?? 0, carburant_mensuel: nombre('carburant_mensuel') ?? 0,
  };
  if (couple) {
    const sc = champ('conjoint_statut').value;
    situation.conjoint = {
      statut: sc, age: nombre('conjoint_age') ?? situation.age, revenu: sc === 'sans_activite' ? 0 : (nombre('conjoint_revenu') ?? 0),
      type_revenu: champ('conjoint_type_revenu').value, heures_hebdo: visible('conjoint_heures_hebdo') ? nombre('conjoint_heures_hebdo') : undefined,
      boursier: visible('conjoint_boursier') && champ('conjoint_boursier').checked,
    };
  }
  return situation;
}

/* ------------------------------------------------------------------ hypothèses réglables */

function construireHypotheses() {
  champsHypotheses.replaceChildren();
  const groupes = [['Hypothèses de modélisation de la législation', e => e[1].modele], ['Hypothèses propres à une mesure', e => !e[1].modele]];
  for (const [titre, filtre] of groupes) {
    const entrees = Object.entries(donnees.hypotheses).filter(filtre);
    if (!entrees.length) continue;
    champsHypotheses.append(el('h3', { text: titre, className: 'sim-sous-titre' }));
    for (const [cle, h] of entrees) {
      const id = `hyp-${cle}`, aideId = `${id}-aide`;
      let controle;
      if (h.type === 'choix') {
        controle = el('select', { attrs: { id, name: `hyp_${cle}`, 'aria-describedby': aideId } },
          h.choix.map(([valeur, libelle]) => el('option', { text: libelle, attrs: { value: valeur, selected: valeur === h.defaut } })));
      } else if (h.type === 'booleen') {
        controle = el('input', { attrs: { id, name: `hyp_${cle}`, type: 'checkbox', checked: h.defaut, 'aria-describedby': aideId } });
      } else {
        const echelle = h.type === 'pourcentage' ? 100 : 1;
        controle = el('input', { attrs: {
          id, name: `hyp_${cle}`, type: 'number', min: h.min * echelle, max: h.max * echelle, step: (h.pas || 1) * echelle,
          value: Math.round(h.defaut * echelle * 1000) / 1000, inputmode: 'decimal', 'aria-describedby': aideId } });
      }
      controle.dataset.cle = cle;
      const unite = h.type === 'pourcentage' ? ' (%)' : (h.unite ? ` (${h.unite})` : '');
      const mesures = (h.mesures || []).length ? ` — mesure ${h.mesures.join(', ')}` : '';
      const bloc = el('div', { className: h.type === 'booleen' ? 'champ sim-check' : 'champ' });
      const etiquette = el('label', { attrs: { for: id }, text: `${h.libelle}${h.type === 'booleen' ? '' : unite}${mesures}` });
      if (h.type === 'booleen') bloc.append(controle, etiquette);
      else bloc.append(etiquette, controle);
      bloc.append(el('small', { text: h.aide || '', attrs: { id: aideId } }));
      champsHypotheses.append(bloc);
    }
  }
}

function lireOptions() {
  const options = {};
  for (const controle of champsHypotheses.querySelectorAll('[data-cle]')) {
    const h = donnees.hypotheses[controle.dataset.cle];
    if (h.type === 'booleen') options[controle.dataset.cle] = controle.checked;
    else if (h.type === 'choix') options[controle.dataset.cle] = controle.value;
    else {
      const valeur = Number(controle.value.replace(',', '.'));
      if (controle.value.trim() === '' || !Number.isFinite(valeur)) throw new Error(`Hypothèse « ${h.libelle} » : indiquez un nombre.`);
      options[controle.dataset.cle] = h.type === 'pourcentage' ? valeur / 100 : valeur;
    }
  }
  return options;
}

/* ------------------------------------------------------------------ rendu des résultats */

function lienMesure(parti, id) {
  return el('a', { text: id, attrs: { href: `programme-${parti}.html#${encodeURIComponent(id)}` } });
}

function lienSource(source, parti) {
  const sortie = el('span', { className: 'sim-source' });
  sortie.append(lienMesure(parti, source.id), ` : page ${source.page} de `, el('a', { text: 'la source', attrs: { href: source.url } }));
  if (source.citation) sortie.append(el('q', { text: source.citation }));
  return sortie;
}

function valeurParametre(valeur) {
  if (Array.isArray(valeur)) return valeur.map(v => NOMS_PRODUITS[v] || v).join(', ');
  if (typeof valeur === 'boolean') return valeur ? 'oui' : 'non';
  if (typeof valeur === 'number' && valeur > 0 && valeur < 1.0001) return pourcent.format(valeur);
  if (typeof valeur === 'number') return new Intl.NumberFormat('fr-FR').format(valeur);
  return String(valeur);
}

function carte(titre, montant, lignes, parti) {
  const c = el('section', { className: 'sim-carte', dataset: parti ? { parti } : {}, attrs: { 'aria-label': titre } });
  c.append(el('h3', { text: titre }), el('p', { text: euro0.format(montant), className: 'sim-montant' }), el('p', { text: 'par mois', className: 'sim-unite' }));
  for (const ligne of lignes) c.append(ligne);
  return c;
}

function barresEcarts(r) {
  const maxi = Math.max(1, Math.abs(r.rn.ecart_actuel), Math.abs(r.lfi.ecart_actuel));
  const figure = el('figure', { className: 'sim-barres' });
  figure.append(el('figcaption', { text: 'Écart de revenu disponible par rapport à aujourd’hui, en euros par mois' }));
  for (const parti of ['rn', 'lfi']) {
    const ecart = r[parti].ecart_actuel;
    const largeur = Math.min(50, Math.abs(ecart) / maxi * 50);
    const barre = el('span', { className: 'sim-barre', attrs: { 'aria-hidden': 'true' } });
    barre.style.width = `${largeur}%`;
    barre.style.marginLeft = ecart >= 0 ? '50%' : `${50 - largeur}%`;
    figure.append(el('div', { className: 'sim-barre-ligne' },
      el('span', { text: PARTIS[parti], className: 'sim-barre-nom' }),
      el('span', { className: 'sim-barre-piste' }, barre),
      el('strong', { text: formatSigne(ecart), className: 'sim-barre-valeur' })));
  }
  return figure;
}

function tableauActuel(r) {
  const a = r.actuel;
  const lignes = [['Revenus nets du foyer', a.revenus_nets, false], ['Impôt sur le revenu', -a.impot_revenu, true]];
  for (const [cle, nom] of Object.entries(NOMS_PRESTATIONS)) {
    if (a.prestations[cle] > 0 || cle === 'apl' && a.detail.apl_source !== 'aucune') {
      const source = cle === 'apl' ? (a.detail.apl_source === 'estimee' ? ' (estimation simplifiée)' : a.detail.apl_source === 'saisie' ? ' (montant saisi)' : '') : '';
      lignes.push([nom + source, a.prestations[cle], true]);
    }
  }
  const table = el('table', { className: 'score-table sim-table' }, el('caption', { text: 'Revenu disponible actuel, en euros par mois' }),
    el('thead', {}, el('tr', {}, el('th', { text: 'Poste', attrs: { scope: 'col' } }), el('th', { text: 'Montant', attrs: { scope: 'col' } }))));
  const corps = el('tbody');
  for (const [nom, v, signe] of lignes) corps.append(el('tr', {}, el('th', { text: nom, attrs: { scope: 'row' } }), el('td', { text: signe ? formatSigne(v) : euro2.format(v) })));
  corps.append(el('tr', { className: 'sim-total' }, el('th', { text: 'Revenu disponible', attrs: { scope: 'row' } }), el('td', { text: euro2.format(a.revenu_disponible) })));
  table.append(corps);
  const d = a.detail;
  const notes = el('p', { className: 'small', text: `Impôt annuel : ${euro0.format(d.impot_annuel)} pour ${String(d.parts).replace('.', ',')} part${d.parts > 1 ? 's' : ''} ; revenu net imposable du foyer : ${euro0.format(d.revenu_imposable_annuel)} par an.` });
  return el('details', { className: 'sim-detail' }, el('summary', { text: 'Votre situation actuelle en détail' }), el('div', { className: 'table-scroll' }, table), notes);
}

function effetsMesure(m) {
  const lignes = [];
  const e = m.effets;
  if (m.nature === 'prix') {
    for (const [produit, v] of Object.entries(m.effets_prix)) if (Math.abs(v) >= 0.005) lignes.push([`Dépense de ${NOMS_PRODUITS[produit]}`, v]);
  } else {
    if (Math.abs(e.revenus_nets) >= 0.005) lignes.push(['Revenus nets', e.revenus_nets]);
    if (Math.abs(e.impot_revenu) >= 0.005) lignes.push(['Impôt sur le revenu', e.impot_revenu]);
    for (const [cle, v] of Object.entries(e.prestations)) if (Math.abs(v) >= 0.005) lignes.push([NOMS_PRESTATIONS[cle], v]);
    if (Math.abs(e.transferts) >= 0.005) lignes.push(['Versement direct de la mesure', e.transferts]);
  }
  if (!lignes.length) return el('p', { text: 'Aucun effet sur votre budget avec les données saisies.', className: 'small' });
  const table = el('table', { className: 'score-table sim-table sim-table-compact' }, el('caption', { text: 'Effets, en euros par mois', className: 'sr-only' }));
  const corps = el('tbody');
  for (const [nom, v] of lignes) corps.append(el('tr', {}, el('th', { text: nom, attrs: { scope: 'row' } }), el('td', { text: formatSigne(v) })));
  table.append(corps);
  return el('div', { className: 'table-scroll' }, table);
}

function blocMesure(m, parti) {
  const d = el('details', { className: 'sim-mesure' });
  const resume = el('summary');
  resume.append(el('span', { text: m.id, className: 'sim-mesure-id' }), el('span', { text: m.libelle, className: 'sim-mesure-nom' }),
    el('span', { text: m.nature === 'prix' ? 'prix' : 'revenu', className: 'theme-tag' }), el('strong', { text: formatSigne(m.variation_mensuelle), className: 'sim-mesure-montant' }));
  d.append(resume, effetsMesure(m));
  const params = Object.entries(m.parametres || {});
  if (params.length) {
    d.append(el('p', { className: 'small', text: 'Paramètres tirés du texte : ' + params.map(([k, v]) => `${NOMS_PARAMETRES[k] || k} = ${valeurParametre(v)}`).join(' ; ') + '.' }));
  }
  const hyp = [...m.hypotheses.map(h => `${h.libelle} : ${valeurParametre(h.valeur)}${h.valeur === h.defaut ? '' : ' (modifié)'}`), ...m.hypotheses_fixes];
  if (hyp.length) d.append(el('p', { className: 'small', text: 'Hypothèses :' }), el('ul', { className: 'small' }, hyp.map(t => el('li', { text: t }))));
  if (m.note) d.append(el('p', { className: 'small', text: m.note }));
  const sources = el('ul', { className: 'small sim-sources' }, el('li', {}, lienSource(m.source, parti)), m.source.autres.map(s => el('li', {}, lienSource(s, parti))));
  d.append(el('p', { className: 'small', text: m.source.autres.length ? 'Sources (la mesure principale puis les reprises du même engagement) :' : 'Source :' }), sources);
  return d;
}

function blocParti(parti, r) {
  const p = r[parti];
  const section = el('section', { className: 'sim-parti', dataset: { parti }, attrs: { 'aria-labelledby': `sim-${parti}-titre` } });
  section.append(el('h3', { text: `Détail par mesure — ${PARTIS[parti]}`, attrs: { id: `sim-${parti}-titre` } }));
  if (p.mesures.length) {
    section.append(el('p', { className: 'small', text: 'Chaque effet est calculé seul, par rapport à la législation actuelle ; la ligne « interactions » reprend ce qui change quand les mesures se cumulent.' }));
    for (const m of p.mesures) section.append(blocMesure(m, parti));
    const resume = el('table', { className: 'score-table sim-table sim-table-compact' }, el('caption', { text: `Total pour ${PARTIS[parti]}`, className: 'sr-only' }));
    const corps = el('tbody');
    const somme = p.mesures.reduce((s, m) => s + m.variation_mensuelle, 0);
    corps.append(el('tr', {}, el('th', { text: 'Somme des mesures chiffrées', attrs: { scope: 'row' } }), el('td', { text: formatSigne(somme) })));
    if (p.interactions) corps.append(el('tr', {}, el('th', { text: 'Interactions entre mesures', attrs: { scope: 'row' } }), el('td', { text: formatSigne(p.interactions) })));
    corps.append(el('tr', { className: 'sim-total' }, el('th', { text: 'Écart total mensuel', attrs: { scope: 'row' } }), el('td', { text: formatSigne(p.ecart_actuel) })));
    resume.append(corps);
    section.append(el('div', { className: 'table-scroll' }, resume));
  } else {
    section.append(el('p', { text: 'Aucune mesure chiffrable ne change votre revenu disponible avec ces données.', className: 'empty-court' }));
  }
  if (p.ecartees.length) {
    section.append(el('details', { className: 'sim-detail' }, el('summary', { text: `Mesures chiffrables sans effet ou hors de votre situation (${p.ecartees.length})` }),
      el('ul', { className: 'small' }, p.ecartees.map(x => el('li', {}, lienMesure(parti, x.id), ` — ${x.libelle}. ${x.raison}`)))));
  }
  return section;
}

function blocNonChiffrables(parti, r) {
  const liste = r.non_chiffrables[parti];
  const section = el('section', { className: 'sim-parti', dataset: { parti }, attrs: { 'aria-labelledby': `sim-nc-${parti}-titre` } });
  section.append(el('h4', { text: `${PARTIS[parti]} : ${liste.length} mesure${liste.length > 1 ? 's' : ''} qui vous concerne${liste.length > 1 ? 'nt' : ''} sans pouvoir être chiffrée${liste.length > 1 ? 's' : ''}`, attrs: { id: `sim-nc-${parti}-titre` } }));
  if (!liste.length) { section.append(el('p', { text: 'Aucune.', className: 'small' })); return section; }
  const ul = el('ul', { className: 'sim-non-chiffrables' });
  for (const m of liste) {
    const item = el('li');
    item.append(lienMesure(parti, m.id), ` — ${m.libelle}. `, el('span', { text: `Ce qui manque : ${m.raison}`, className: 'small' }));
    if (m.condition) item.append(' ', el('span', { text: m.condition, className: 'small' }));
    item.append(' ', el('a', { text: `(page ${m.source.page})`, attrs: { href: m.source.url } }));
    ul.append(item);
  }
  section.append(ul);
  return section;
}

function blocHypotheses(r) {
  const section = el('section', { attrs: { 'aria-labelledby': 'sim-hyp-titre' } });
  section.append(el('h3', { text: 'Hypothèses retenues', attrs: { id: 'sim-hyp-titre' } }));
  section.append(el('ul', { className: 'small' }, r.hypotheses.generales.map(t => el('li', { text: t }))));
  const reglees = r.hypotheses.reglables.map(h => `${h.libelle} : ${valeurParametre(h.valeur)}${h.valeur === h.defaut ? '' : ' (valeur modifiée)'}`);
  section.append(el('p', { className: 'small', text: 'Valeurs des hypothèses réglables :' }), el('ul', { className: 'small' }, reglees.map(t => el('li', { text: t }))));
  return section;
}

function afficher(r) {
  resultat.replaceChildren();
  resultat.append(el('h2', { text: 'Résultat', attrs: { id: 'simulateur-resultat-titre' } }));
  resultat.append(el('p', { className: 'sim-lecture', text: 'Revenu disponible = revenus nets − impôt sur le revenu + prestations sociales. Les baisses de prix (TVA, électricité) sont comptées comme un gain de pouvoir d’achat en euros. Estimation mensuelle en euros, pour douze mois de revenus constants.' }));
  for (const w of r.avertissements) resultat.append(el('p', { className: 'sim-avertissement', text: w }));

  const cartes = el('div', { className: 'sim-cartes' });
  cartes.append(carte('Législation actuelle', r.actuel.revenu_disponible, [el('p', { text: `soit ${euro0.format(r.actuel.revenu_disponible * 12)} par an`, className: 'small' })]));
  for (const parti of ['rn', 'lfi']) {
    const p = r[parti];
    const lignes = [el('p', { text: `${formatSigne(p.ecart_actuel, euro0)} par mois, soit ${formatSigne(p.ecart_actuel * 12, euro0)} par an`, className: 'sim-ecart' })];
    if (p.ecart_prix) lignes.push(el('p', { className: 'small', text: `dont ${formatSigne(p.ecart_revenu, euro0)} de revenu et ${formatSigne(p.ecart_prix, euro0)} de baisse des prix` }));
    lignes.push(el('p', { className: 'small', text: `${p.mesures.length} mesure${p.mesures.length > 1 ? 's' : ''} chiffrée${p.mesures.length > 1 ? 's' : ''} ; ${r.non_chiffrables[parti].length} non chiffrable${r.non_chiffrables[parti].length > 1 ? 's' : ''}` }));
    cartes.append(carte(NOMS_PROGRAMMES[parti], p.revenu_disponible, lignes, parti));
  }
  resultat.append(cartes, barresEcarts(r), tableauActuel(r));
  resultat.append(blocParti('rn', r), blocParti('lfi', r));
  resultat.append(el('h3', { text: 'Mesures qui vous concernent mais ne peuvent pas être chiffrées' }),
    el('p', { className: 'small', text: 'Le texte ne donne pas les paramètres nécessaires, ou la situation correspondante n’est pas dans le formulaire. Elles ne sont comptées dans aucun total.' }),
    blocNonChiffrables('rn', r), blocNonChiffrables('lfi', r), blocHypotheses(r),
    el('p', { className: 'small' }, 'Voir la ', el('a', { text: 'méthode', attrs: { href: 'methode.html' } }), ' et les ', el('a', { text: 'avertissements', attrs: { href: 'avertissements.html' } }), '.'));
}

/* ------------------------------------------------------------------ orchestration */

function montrerErreur(message) {
  erreur.textContent = message;
  erreur.hidden = !message;
}

function estimer({ deplacerFocus }) {
  montrerErreur('');
  try {
    if (!donnees) throw new Error('Les données du simulateur ne sont pas encore chargées.');
    if (deplacerFocus && !form.reportValidity()) return;
    if (!form.checkValidity()) return;
    const situation = lireSituation();
    derniereSituation = situation;
    afficher(calculer(situation, donnees, lireOptions()));
    if (deplacerFocus) { resultat.focus({ preventScroll: true }); resultat.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  } catch (e) {
    montrerErreur(e instanceof Error ? e.message : 'Le calcul a échoué.');
  }
}

function initialiser() {
  majVisibilite();
  form.addEventListener('change', event => {
    if (event.target.name === 'heures_hebdo' || event.target.name === 'conjoint_heures_hebdo') delete event.target.dataset.auto;
    majVisibilite();
    if (derniereSituation && !event.target.closest('#sim-hypotheses')) estimer({ deplacerFocus: false });
  });
  form.addEventListener('input', event => {
    if (event.target.closest('#sim-hypotheses') && derniereSituation) estimer({ deplacerFocus: false });
    if (event.target.name === 'heures_hebdo' || event.target.name === 'conjoint_heures_hebdo') delete event.target.dataset.auto;
  });
  form.addEventListener('submit', event => { event.preventDefault(); estimer({ deplacerFocus: true }); });
  form.addEventListener('reset', () => setTimeout(() => {
    derniereSituation = null;
    for (const heures of form.querySelectorAll('[name$="heures_hebdo"]')) { heures.value = ''; heures.dataset.auto = '1'; }
    majVisibilite();
    montrerErreur('');
    resultat.replaceChildren(el('h2', { text: 'Résultat', attrs: { id: 'simulateur-resultat-titre' } }), el('p', { text: 'Renseignez le formulaire puis lancez l’estimation.' }));
  }, 0));
  document.getElementById('sim-hypotheses-reinitialiser').addEventListener('click', () => {
    construireHypotheses();
    if (derniereSituation) estimer({ deplacerFocus: false });
  });
}

(async function demarrer() {
  initialiser();
  try {
    donnees = await chargerDonnees(URL_DONNEES);
    construireHypotheses();
    statut.textContent = `Données prêtes : barème au ${new Date(`${donnees.date_reference}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}, ${donnees.mesures.filter(m => m.statut === 'chiffrable').length} mesures chiffrables sur ${donnees.mesures.length} retenues.`;
  } catch (e) {
    statut.textContent = 'Les données du simulateur n’ont pas pu être chargées. Le site doit être servi par un serveur web (et non ouvert comme un fichier) : voir le README.';
    statut.className = 'sim-status sim-erreur';
    form.querySelector('#sim-estimer').disabled = true;
  }
})();
