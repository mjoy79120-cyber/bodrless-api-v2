// Environment config. Pre-production and production are fully separate.
const ENVIRONMENTS = {
  preprod: {
    authUrl: 'https://auth.pp.travelport.com/oauth/token',
    airBase: 'https://api.pp.travelport.net/11/air/',
    rootBase: 'https://api.pp.travelport.net/11/', // APIs with no /air prefix
  },
  prod: {
    authUrl: 'https://auth.travelport.net/oauth/token',
    airBase: 'https://api.travelport.net/11/air/',
    rootBase: 'https://api.travelport.net/11/',
  },
};

function resolveEnv(name) {
  const env = ENVIRONMENTS[name];
  if (!env) throw new Error(`Unknown Travelport environment "${name}" (use preprod or prod)`);
  return env;
}

module.exports = { ENVIRONMENTS, resolveEnv };
