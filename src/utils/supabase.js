const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error("SUPABASE_URL is missing — check Render environment variables");
if (!supabaseKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing — check Render environment variables");

console.log('[SUPABASE] URL:', supabaseUrl?.slice(0, 30));
console.log('[SUPABASE] Key type:', supabaseKey?.startsWith('eyJ') ? 'JWT present' : 'MISSING OR WRONG');

// ✅ NEW: decode the JWT payload to verify the role claim
try {
  const payload = JSON.parse(Buffer.from(supabaseKey.split('.')[1], 'base64').toString());
  console.log('[SUPABASE] Key role:', payload.role); // must be "service_role" — if "anon", wrong key!
} catch {
  console.error('[SUPABASE] Could not decode key — may not be a valid JWT');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession:   false,
  },
});

module.exports = supabase;