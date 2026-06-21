// =========================================================
// CONFIG — Apna n8n webhook URL yahan daalo
// =========================================================

const CONFIG = {
  // Sab actions (upload_resume, extract, draft_email, submit_application, get_history)
  // ek hi webhook URL pe jaate hain — n8n "Switch: Action" node body.action field se route karta hai
  APPLY_WEBHOOK: "https://swastik2475.app.n8n.cloud/webhook/apply",
};
