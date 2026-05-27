const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

// DEBUG (IMPORTANT — helps you confirm Render is loading env vars)
console.log("SUPABASE_URL:", supabaseUrl);
console.log("SUPABASE_KEY exists:", !!supabaseKey);

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL is missing in environment variables");
}

if (!supabaseKey) {
  throw new Error("Supabase key is missing in environment variables");
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;