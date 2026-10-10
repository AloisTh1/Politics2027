// Seul point de raccordement au moteur : l'interface importe ses deux fonctions publiques.
async function calculerAvecMoteur(situation) {
  const module = await import('./simulateur.js');
  const donnees = await module.chargerDonnees('static/data/simulateur.json');
  return module.calculer(situation, donnees);
}

const form = document.getElementById('simulateur-form');
const output = document.getElementById('simulateur-resultat');
const euros = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

function element(tag, text, parent, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function readSituation() {
  const data = Object.fromEntries(new FormData(form));
  const ages = data.enfants.trim() ? data.enfants.split(',').map(value => Number(value.trim())) : [];
  if (ages.some(age => !Number.isInteger(age) || age < 0 || age > 30)) throw new Error('Indiquez des âges d’enfants entiers, séparés par des virgules.');
  return {
    couple: data.couple === 'oui', age: Number(data.age), statut: data.statut,
    revenu: Number(data.revenu), type_revenu: data.type_revenu,
    revenu_conjoint: data.couple === 'oui' ? Number(data.revenu_conjoint) : 0,
    enfants: ages, logement: data.logement, apl_actuelle: Number(data.apl_actuelle),
    energie_mensuelle: Number(data.energie_mensuelle), carburant_mensuel: Number(data.carburant_mensuel),
    chauffage: data.chauffage, temps_travail_heures: Number(data.temps_travail_heures)
  };
}

function renderResult(result) {
  output.replaceChildren();
  element('h2', 'Résultat mensuel indicatif', output);
  element('p', `Situation actuelle : ${euros.format(result.actuel.revenu_disponible)} de revenu disponible`, output);
  const comparison = element('div', '', output, 'comparison');
  for (const [party, name] of [['rn', 'Rassemblement national'], ['lfi', 'La France insoumise']]) {
    const panel = element('section', '', comparison, 'party-panel');
    element('h3', name, panel);
    element('p', `${euros.format(result[party].revenu_disponible)} par mois ; écart estimé : ${euros.format(result[party].ecart_actuel)}`, panel);
    if (result[party].mesures.length) {
      const list = element('ul', '', panel);
      result[party].mesures.forEach(measure => element('li', `${measure.id} — ${measure.libelle} : ${euros.format(measure.variation_mensuelle)}`, list));
    } else element('p', 'Aucune variation chiffrable retenue pour cette situation.', panel);
    const missing = result.non_chiffrables[party];
    if (missing.length) {
      element('h4', 'Mesures non chiffrées', panel);
      const list = element('ul', '', panel);
      missing.forEach(measure => element('li', `${measure.id} — ${measure.raison || 'Paramètres manquants'}`, list));
    }
  }
  if (result.hypotheses.length) {
    element('h3', 'Hypothèses', output);
    const list = element('ul', '', output);
    result.hypotheses.forEach(item => element('li', item, list));
  }
}

form?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  output.replaceChildren();
  element('p', 'Calcul en cours…', output);
  try {
    renderResult(await calculerAvecMoteur(readSituation()));
  } catch (error) {
    output.replaceChildren();
    element('h2', 'Résultat indisponible', output);
    element('p', error instanceof Error ? error.message : 'Erreur de calcul.', output);
  }
});
