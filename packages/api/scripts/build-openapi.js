// scripts/build-openapi.js
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

const yamlPath = path.join(process.cwd(), 'openapi', 'openapi.yaml');
const jsonPath = path.join(process.cwd(), 'openapi', 'openapi.json');
const specYaml = fs.readFileSync(yamlPath, 'utf-8');
const specJson = JSON.stringify(yaml.parse(specYaml), null, 2);
fs.writeFileSync(jsonPath, specJson);
console.log('OpenAPI built ->', jsonPath);
