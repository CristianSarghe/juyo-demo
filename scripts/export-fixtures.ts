import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NETWORK_DATA } from '../src/app/core/network.data.ts';
import { NETWORK_SCHEMA } from '../src/app/core/network.schema.ts';

const directory = fileURLToPath(new URL('../public/data/', import.meta.url));
mkdirSync(directory, { recursive: true });
for (const [name, data] of [['hotel-network.json', NETWORK_DATA], ['hotel-network.schema.json', NETWORK_SCHEMA]] as const) {
  writeFileSync(`${directory}${name}`, `${JSON.stringify(data, null, 2)}\n`);
}
console.log('Exported local hotel network fixtures and JSON Schema.');
