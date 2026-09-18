import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';
const schema = JSON.parse(await readFile(new URL('../schema/protocol.v1.json', import.meta.url), 'utf8'));
const definitions = {...schema.definitions, ProtocolMessage: {title: 'ProtocolMessage', oneOf: schema.oneOf}};
const typeSchema = {$schema: schema.$schema, title: 'ContractTypes', type: 'object', additionalProperties: false, definitions,
  properties: Object.fromEntries(Object.keys(definitions).map(name => [name, {$ref: '#/definitions/' + name}]))};
const generated = await compile(typeSchema, 'ContractTypes', {bannerComment: '/* Generated from schema/protocol.v1.json. Edit the schema, then npm run generate. */'});
await mkdir(new URL('../src/', import.meta.url), {recursive: true});
await writeFile(new URL('../src/protocol.generated.ts', import.meta.url), generated);
await writeFile(new URL('../src/schema.generated.ts', import.meta.url), '/* Generated from schema/protocol.v1.json. */\nexport const protocolSchema = ' + JSON.stringify(schema) + ' as const;\n');
