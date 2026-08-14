const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error("SUPABASE_URL is missing — check Render environment variables");
if (!supabaseKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing — check Render environment variables");

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession:   false,
  },
});

module.exports = supabase;