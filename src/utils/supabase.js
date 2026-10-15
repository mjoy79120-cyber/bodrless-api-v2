const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error("SUPABASE_URL is missing — check Render environment variables");
if (!supabaseKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing — check Render environment variables");

console.log('[SUPABASE] URL:', supabaseUrl?.slice(0, 30));
console.log('[SUPABASE] Key type:', supabaseKey?.startsWith('eyJ') ? 'JWT present' : 'MISSING OR WRONG');

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession:   false,
  },
});

module.exports = supabase;