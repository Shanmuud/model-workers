import { readFileSync } from 'node:fs';

export const ROLES = ['explain', 'review', 'draft'];
export const PROVIDERS = ['codex', 'claude', 'demo'];

// Configuration is explicit: never execute a repository's routing config merely
// because the user asked to inspect that repository.
export function resolveWorker({ role, configPath, provider, model }) {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}. Choose ${ROLES.join(', ')}.`);
  let selected = {};
  if (configPath) {
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read routing config: ${error.message}`);
    }
    if (config?.version !== 1 || !config.workers || typeof config.workers !== 'object') {
      throw new Error('Routing config must have version: 1 and a workers object.');
    }
    selected = config.workers[role];
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
      throw new Error(`Routing config has no worker for "${role}".`);
    }
  }
  const result = { provider: provider ?? selected.provider, model: model ?? selected.model };
  if (!PROVIDERS.includes(result.provider)) {
    throw new Error('Choose --provider codex|claude and --model MODEL, or pass --config FILE. Use --provider demo to try without a model.');
  }
  if (result.provider === 'demo') return { provider: 'demo', model: 'none (offline demonstration)' };
  if (typeof result.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/i.test(result.model)) {
    throw new Error('Choose a valid --model ID or set the model in your routing config.');
  }
  if (/YOUR_|REPLACE_/i.test(result.model)) {
    throw new Error('Replace the example model placeholder with a model available in your provider account.');
  }
  return result;
}

export function positiveInteger(value, label, fallback, ceiling) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > ceiling) {
    throw new Error(`${label} must be between 1 and ${ceiling}.`);
  }
  return number;
}
