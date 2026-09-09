#!/usr/bin/env node
/**
 * Génère les workflows n8n depuis les définitions et le socle.
 *
 *   npm run n8n:build          régénère n8n/workflows/*.json
 *   npm run n8n:build -- --verifier   échoue si un fichier n'est plus à jour
 *
 * Le second mode sert au test : il garantit qu'un changement dans src/ ne
 * peut pas partir en production sans que les workflows soient régénérés.
 */

const fs = require('node:fs');
const path = require('node:path');
const { construireSocle, empreinte } = require('./bundle');

const DEFINITIONS = path.join(__dirname, 'definitions');
const SORTIE = path.join(__dirname, 'workflows');

function definitions() {
  return fs
    .readdirSync(DEFINITIONS)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => require(path.join(DEFINITIONS, f)));
}

function generer() {
  const socle = construireSocle();
  return definitions().map((definition) => ({
    fichier: definition.fichier,
    contenu: `${JSON.stringify(definition.construire(socle), null, 2)}\n`,
  }));
}

function main() {
  const verifier = process.argv.includes('--verifier');
  const socle = construireSocle();
  const fichiers = generer();
  let ecarts = 0;

  fs.mkdirSync(SORTIE, { recursive: true });

  for (const { fichier, contenu } of fichiers) {
    const chemin = path.join(SORTIE, fichier);
    const actuel = fs.existsSync(chemin) ? fs.readFileSync(chemin, 'utf8') : null;

    if (verifier) {
      if (actuel !== contenu) {
        process.stderr.write(`${fichier} n'est plus à jour\n`);
        ecarts += 1;
      }
      continue;
    }

    if (actuel !== contenu) fs.writeFileSync(chemin, contenu);
    const octets = Buffer.byteLength(contenu);
    process.stdout.write(`${fichier.padEnd(38)} ${String(Math.round(octets / 1024)).padStart(4)} Ko\n`);
  }

  if (verifier) {
    if (ecarts) {
      process.stderr.write('\nRégénérer avec : npm run n8n:build\n');
      process.exit(1);
    }
    process.stdout.write('Workflows à jour.\n');
    return;
  }

  process.stdout.write(`\nSocle : ${Math.round(socle.length / 1024)} Ko, empreinte ${empreinte(socle)}\n`);
}

if (require.main === module) main();

module.exports = { generer, definitions };
