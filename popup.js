// popup.js — orchestrates the scan and renders results.
const $ = (id) => document.getElementById(id);

$("scan").addEventListener("click", async () => {
  const btn = $("scan");
  btn.disabled = true;
  btn.textContent = "Scanning…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPage,        // defined below, runs in the page context
    });
    render(result);
  } catch (e) {
    $("list").innerHTML =
      `<div class="empty"><div class="big">⚠️</div>Can't scan this page.<br><span style="font-size:11px">Try a normal http(s) page (not chrome:// or the extensions tab).</span></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Re-scan this page";
  }
});

function render(data) {
  if (!data) return;
  $("summary").style.display = "flex";
  $("cCrit").textContent = data.issues.filter((i) => i.sev === "crit").length;
  $("cWarn").textContent = data.issues.filter((i) => i.sev === "warn").length;
  $("cScanned").textContent = data.scanned;

  const list = $("list");
  if (data.issues.length === 0) {
    list.innerHTML = `<div class="empty"><div class="big">✓</div>No hygiene issues found on the visible fields.</div>`;
    return;
  }
  // critical first
  const order = { crit: 0, warn: 1 };
  data.issues.sort((a, b) => order[a.sev] - order[b.sev]);
  list.innerHTML = data.issues
    .map(
      (i) => `
      <div class="issue">
        <div class="top">
          <span class="sev ${i.sev}">${i.sev === "crit" ? "Critical" : "Warning"}</span>
          <span class="field">${esc(i.field)}</span>
        </div>
        <div class="msg">${esc(i.msg)}${i.value ? ` <span class="val">${esc(i.value)}</span>` : ""}</div>
      </div>`
    )
    .join("");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ----------------------------------------------------------------------------
// scanPage() runs INSIDE the page (serialized by chrome.scripting). Keep it
// self-contained — no references to popup variables.
// ----------------------------------------------------------------------------
function scanPage() {
  const issues = [];
  let scanned = 0;

  const phoneRe = /[\d\(\)\+\-\s\.]{7,}/;
  const e164Re = /^\+\d{7,15}$/;
  const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const urlRe = /^https?:\/\//i;

  // Find a human-readable label for a field element.
  function labelFor(el) {
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && l.textContent.trim()) return l.textContent.trim();
    }
    const wrapLabel = el.closest("label");
    if (wrapLabel && wrapLabel.textContent.trim()) return wrapLabel.textContent.trim().slice(0, 60);
    if (el.placeholder) return el.placeholder.trim();
    if (el.name) return el.name.replace(/[_\-.]/g, " ").trim();
    // look for a preceding sibling label-ish element
    const prev = el.closest("[class],[data-test-id],div")?.previousElementSibling;
    if (prev && prev.textContent && prev.textContent.trim().length < 40) return prev.textContent.trim();
    return "(unlabeled field)";
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  }

  const fields = Array.from(
    document.querySelectorAll("input, textarea, select, [contenteditable='true']")
  ).filter((el) => {
    const t = (el.getAttribute("type") || "").toLowerCase();
    if (["hidden", "password", "checkbox", "radio", "file", "submit", "button", "image", "range"].includes(t)) return false;
    return visible(el);
  });

  const seenLabels = new Set();

  fields.forEach((el) => {
    const label = labelFor(el);
    const value = (el.value ?? el.textContent ?? "").trim();
    const key = label.toLowerCase();
    scanned++;

    // de-dupe identical labels so we don't spam
    const dedupeKey = key + "::" + value;
    if (seenLabels.has(dedupeKey)) return;
    seenLabels.add(dedupeKey);

    const looksRequired =
      el.required ||
      el.getAttribute("aria-required") === "true" ||
      /\*/.test(label);

    // 1. Missing required-looking value
    if (!value) {
      if (looksRequired) {
        issues.push({ sev: "crit", field: label, msg: "Required field is empty." });
      }
      return; // nothing else to check on empty fields
    }

    // 2. Email format
    if (key.includes("email") || el.type === "email") {
      if (!emailRe.test(value)) issues.push({ sev: "crit", field: label, msg: "Email looks malformed:", value });
      if (/@(gmail|yahoo|hotmail|outlook|icloud)\./i.test(value))
        issues.push({ sev: "warn", field: label, msg: "Personal email on a business record:", value });
    }

    // 3. Phone format
    if (key.includes("phone") || key.includes("mobile") || el.type === "tel") {
      const compact = value.replace(/[\s\-\(\)\.]/g, "");
      if (phoneRe.test(value) && !e164Re.test(compact)) {
        issues.push({ sev: "warn", field: label, msg: "Phone not in E.164 (+countrycode) format:", value });
      }
    }

    // 4. URL / website / domain
    if (key.includes("website") || key.includes("url") || key.includes("domain") || el.type === "url") {
      if (!urlRe.test(value) && !key.includes("domain")) {
        issues.push({ sev: "warn", field: label, msg: "URL missing https://", value });
      }
    }

    // 5. Casing problems on names / companies
    if (key.includes("name") || key.includes("company") || key.includes("account")) {
      if (value === value.toUpperCase() && /[A-Z]/.test(value) && value.length > 2)
        issues.push({ sev: "warn", field: label, msg: "Value is ALL CAPS:", value });
      else if (value === value.toLowerCase() && /[a-z]/.test(value) && value.length > 2)
        issues.push({ sev: "warn", field: label, msg: "Value is all lowercase:", value });
    }

    // 6. Placeholder / junk values
    if (/^(n\/?a|none|test|asdf|xxx+|tbd|unknown|\.|-)$/i.test(value))
      issues.push({ sev: "warn", field: label, msg: "Looks like a placeholder/junk value:", value });

    // 7. Leading/trailing or double whitespace
    if (/\s{2,}/.test(value) || value !== value.trim())
      issues.push({ sev: "warn", field: label, msg: "Extra whitespace in value:", value });
  });

  // 8. "No next step" heuristic — scan visible text for an empty next-step area
  const bodyText = document.body.innerText.toLowerCase();
  const hasNextStepLabel = /next step|next activity|follow.?up/.test(bodyText);
  const hasScheduled = /scheduled|due|upcoming|task/.test(bodyText);
  if (hasNextStepLabel && !hasScheduled) {
    issues.push({ sev: "crit", field: "Next step", msg: "Record mentions a next step but none appears scheduled." });
  }

  return { issues, scanned, url: location.href };
}
