// =========================================================
// STATE
// =========================================================
let currentMode = "manual";
let resumeFileId = localStorage.getItem("resumeFileId") || null; // Drive file id of last uploaded resume, persisted across reloads
let pendingDraft = null; // { email_subject, email_body, company_name, hr_email, job_role, jd_text }

// Restore resume status banner on load if we already have a saved file id
window.addEventListener("DOMContentLoaded", () => {
  const savedName = localStorage.getItem("resumeFileName");
  if (resumeFileId && savedName) {
    const statusEl = document.getElementById("resumeStatus");
    if (statusEl) statusEl.textContent = "\u2705 Resume uploaded: " + savedName;
  }
});

// =========================================================
// MODE TOGGLE
// =========================================================
function setMode(mode) {
  currentMode = mode;
  document.getElementById("manualBtn").classList.toggle("active", mode === "manual");
  document.getElementById("autoBtn").classList.toggle("active", mode === "auto");
  document.getElementById("manualForm").classList.toggle("hidden", mode !== "manual");
  document.getElementById("autoForm").classList.toggle("hidden", mode !== "auto");
}

// =========================================================
// HELPERS
// =========================================================
function showResponse(message, type) {
  const box = document.getElementById("responseMsg");
  box.textContent = message;
  box.className = type; // "success" or "error"
  box.classList.remove("hidden");
  setTimeout(() => box.classList.add("hidden"), 6000);
}

function setLoading(btn, isLoading, normalText) {
  btn.disabled = isLoading;
  btn.textContent = isLoading ? "⏳ Please wait..." : normalText;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]); // strip data:...;base64,
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// =========================================================
// 1. RESUME UPLOAD
// =========================================================
document.getElementById("uploadResumeBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("resumeFile");
  const btn = document.getElementById("uploadResumeBtn");

  if (!fileInput.files.length) {
    showResponse("Please select a resume file first.", "error");
    return;
  }

  const formData = new FormData();
  formData.append("resume", fileInput.files[0]);
  formData.append("action", "upload_resume");
  formData.append("resume_name", fileInput.files[0].name);

  try {
    setLoading(btn, true, "Upload / Update Resume");
    const res = await fetch(CONFIG.APPLY_WEBHOOK, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) throw new Error("Upload failed");
    const data = await res.json();
    resumeFileId = data.resume_file_id || resumeFileId;

    // Persist so resume stays "uploaded" across page reloads / new tabs
    if (resumeFileId) {
      localStorage.setItem("resumeFileId", resumeFileId);
      localStorage.setItem("resumeFileName", fileInput.files[0].name);
    }

    document.getElementById("resumeStatus").textContent =
      "✅ Resume uploaded: " + fileInput.files[0].name;
    showResponse("Resume uploaded successfully!", "success");
  } catch (err) {
    showResponse("Resume upload failed. Check n8n webhook URL.", "error");
    console.error(err);
  } finally {
    setLoading(btn, false, "Upload / Update Resume");
  }
});

// =========================================================
// 2. MANUAL -> DRAFT EMAIL (preview step, does not send)
// =========================================================
document.getElementById("draftManualBtn").addEventListener("click", async () => {
  const btn = document.getElementById("draftManualBtn");
  const payload = {
    action: "draft_email",
    company_name: document.getElementById("companyName").value.trim(),
    hr_email: document.getElementById("hrEmail").value.trim(),
    job_role: document.getElementById("jobRole").value.trim(),
    jd_text: document.getElementById("jdText").value.trim(),
  };

  if (!payload.company_name || !payload.hr_email || !payload.job_role || !payload.jd_text) {
    showResponse("Please fill all fields.", "error");
    return;
  }

  await requestDraft(payload, btn, "✉️ Generate & Preview Email");
});

// =========================================================
// 3. AUTO EXTRACT — supports image (OCR via Groq Vision) OR pasted text
// =========================================================
document.getElementById("extractBtn").addEventListener("click", async () => {
  const btn = document.getElementById("extractBtn");
  const imageInput = document.getElementById("jdImage");
  const rawText = document.getElementById("jdRawText").value.trim();

  if (!imageInput.files.length && !rawText) {
    showResponse("Upload an image or paste JD text.", "error");
    return;
  }

  try {
    setLoading(btn, true, "🔍 Extract Details");
    let res;

    if (imageInput.files.length) {
      // Image path: send as multipart, n8n runs Groq Vision OCR + extraction
      const formData = new FormData();
      formData.append("action", "extract");
      formData.append("jd_image", imageInput.files[0]);
      res = await fetch(CONFIG.APPLY_WEBHOOK, { method: "POST", body: formData });
    } else {
      // Text path: existing AI Agent text extraction
      res = await fetch(CONFIG.APPLY_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "extract", jd_raw_text: rawText }),
      });
    }

    if (!res.ok) throw new Error("Extraction failed");

    const data = await res.json();
    // expected response: { company_name, hr_email, job_role, jd_text }

    document.getElementById("extCompany").value = data.company_name || "";
    document.getElementById("extEmail").value = data.hr_email || "";
    document.getElementById("extRole").value = data.job_role || "";
    document.getElementById("extJD").value = data.jd_text || rawText || "";

    document.getElementById("extractedPreview").classList.remove("hidden");
    showResponse("Details extracted! Please confirm below.", "success");
  } catch (err) {
    showResponse("Extraction failed. Check n8n webhook URL.", "error");
    console.error(err);
  } finally {
    setLoading(btn, false, "🔍 Extract Details");
  }
});

// =========================================================
// 4. AUTO -> DRAFT EMAIL (after confirming extracted fields)
// =========================================================
document.getElementById("draftAutoBtn").addEventListener("click", async () => {
  const btn = document.getElementById("draftAutoBtn");
  const payload = {
    action: "draft_email",
    company_name: document.getElementById("extCompany").value.trim(),
    hr_email: document.getElementById("extEmail").value.trim(),
    job_role: document.getElementById("extRole").value.trim(),
    jd_text: document.getElementById("extJD").value.trim(),
  };

  if (!payload.company_name || !payload.hr_email || !payload.job_role || !payload.jd_text) {
    showResponse("Please fill all confirmed fields.", "error");
    return;
  }

  await requestDraft(payload, btn, "✉️ Generate & Preview Email");
});

// =========================================================
// SHARED: REQUEST DRAFT (calls n8n draft_email action, shows preview card)
// =========================================================
async function requestDraft(payload, btn, normalText) {
  try {
    setLoading(btn, true, normalText);
    const res = await fetch(CONFIG.APPLY_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error("Draft generation failed");

    const data = await res.json();
    // expected: { email_subject, email_body, company_name, hr_email, job_role, jd_text }

    pendingDraft = data;
    showPreview(data);
  } catch (err) {
    showResponse("Could not generate email draft. Check n8n webhook URL.", "error");
    console.error(err);
  } finally {
    setLoading(btn, false, normalText);
  }
}

// =========================================================
// PREVIEW CARD — show draft, wait for explicit Send / Cancel
// =========================================================
function showPreview(draft) {
  document.getElementById("previewMeta").innerHTML =
    `<strong>To:</strong> ${draft.hr_email} &nbsp;|&nbsp; <strong>Subject:</strong> ${draft.email_subject}`;
  document.getElementById("previewBody").innerHTML = draft.email_body;
  document.getElementById("previewCard").classList.remove("hidden");
  document.getElementById("previewCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("cancelSendBtn").addEventListener("click", () => {
  pendingDraft = null;
  document.getElementById("previewCard").classList.add("hidden");
  showResponse("Cancelled. Email was not sent.", "error");
});

document.getElementById("confirmSendBtn").addEventListener("click", async () => {
  if (!pendingDraft) return;
  const btn = document.getElementById("confirmSendBtn");

  if (!resumeFileId) {
    showResponse("Please upload your resume first (Step 1) before sending.", "error");
    return;
  }

  const payload = {
    action: "submit_application",
    company_name: pendingDraft.company_name,
    hr_email: pendingDraft.hr_email,
    job_role: pendingDraft.job_role,
    jd_text: pendingDraft.jd_text,
    email_subject: pendingDraft.email_subject,
    email_body: pendingDraft.email_body,
    resume_file_id: resumeFileId,
  };

  try {
    setLoading(btn, true, "✅ Send Application");
    const res = await fetch(CONFIG.APPLY_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error("Application failed");

    showResponse("✅ Application sent to " + payload.company_name + "!", "success");
    document.getElementById("previewCard").classList.add("hidden");
    pendingDraft = null;
    clearForms();
    loadHistory();
  } catch (err) {
    showResponse("Failed to send application. Check n8n webhook URL.", "error");
    console.error(err);
  } finally {
    setLoading(btn, false, "✅ Send Application");
  }
});

function clearForms() {
  document.getElementById("companyName").value = "";
  document.getElementById("hrEmail").value = "";
  document.getElementById("jobRole").value = "";
  document.getElementById("jdText").value = "";
  document.getElementById("jdImage").value = "";
  document.getElementById("jdRawText").value = "";
  document.getElementById("extCompany").value = "";
  document.getElementById("extEmail").value = "";
  document.getElementById("extRole").value = "";
  document.getElementById("extJD").value = "";
  document.getElementById("extractedPreview").classList.add("hidden");
}

// =========================================================
// 5. LOAD HISTORY (from Google Sheet via n8n)
// =========================================================
async function loadHistory() {
  const tbody = document.getElementById("historyBody");
  try {
    const res = await fetch(CONFIG.APPLY_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get_history" }),
    });
    if (!res.ok) throw new Error("Failed to load history");

    // n8n can return an empty body for this action - guard against that
    // instead of letting res.json() throw "Unexpected end of JSON input"
    const text = await res.text();
    let rows = [];
    if (text && text.trim().length) {
      try {
        const parsed = JSON.parse(text);
        rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      } catch (parseErr) {
        console.error("History response was not valid JSON:", text);
        rows = [];
      }
    }

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-row">No applications yet</td></tr>`;
      return;
    }

    tbody.innerHTML = rows
      .map((row) => {
        const statusClass =
          row.status === "responded" ? "responded" :
          row.status === "followup_sent" ? "followup" : "sent";
        return `
          <tr>
            <td>${row.company_name || "-"}</td>
            <td>${row.hr_email || "-"}</td>
            <td>${row.applied_date || "-"}</td>
            <td><span class="badge ${statusClass}">${row.status || "sent"}</span></td>
            <td>${row.mail_opened === "true" || row.mail_opened === true ? "✅ Yes" : "❌ No"}</td>
          </tr>
        `;
      })
      .join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-row">Could not load history. Check webhook.</td></tr>`;
    console.error(err);
  }
}

document.getElementById("refreshHistoryBtn").addEventListener("click", loadHistory);

// Load history on page load
window.addEventListener("DOMContentLoaded", loadHistory);