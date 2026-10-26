// Receive & Sort — pallet sorting backend (same Supabase project the PO Sort app uses,
// so pallet numbers are shared with any PO Sort phones still running on the same truck).
// The anon key is a PUBLIC key by design: it can only read tables and call the RPCs that
// supabase-schema.sql grants (start_truck_session, current_truck_session, assign_pallet).
window.PL_SORT_CONFIG = {
  supabaseUrl: "https://sdaniffexxmdtjptyfsh.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkYW5pZmZleHhtZHRqcHR5ZnNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0ODAyODksImV4cCI6MjA5ODA1NjI4OX0._2wiDu0X9J9a-Oz-kUktHRMXeFVGEXzkFA0djewlBTs",
  // 4-digit code to reset a truck that's already in progress (floor guard, not security).
  resetPin: "0901",
  // Name shown to receivers for where the first unit of an FAI SKU goes to be dimmed.
  faiLocationName: "FAI location",
};
