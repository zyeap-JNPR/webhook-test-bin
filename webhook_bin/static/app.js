async function createBin(form) {
  const formData = new FormData(form);
  const payload = { name: formData.get("name") };
  const res = await fetch("/api/bins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("bin create failed");
  const data = await res.json();
  window.location.href = data.dashboard_url;
}

function buildMessageQuery(params) {
  const query = new URLSearchParams();
  query.set("limit", String(params.limit || 100));
  if (params.beforeId) query.set("before_id", String(params.beforeId));
  if (params.method) query.set("method", params.method);
  if (params.q) query.set("q", params.q);
  if (params.headerKey) query.set("header_key", params.headerKey);
  if (params.headerValue) query.set("header_value", params.headerValue);
  return query.toString();
}

async function loadMessages(binId, params = {}) {
  const qs = buildMessageQuery(params);
  const res = await fetch(`/api/bins/${binId}/messages?${qs}`);
  if (!res.ok) throw new Error("message load failed");
  return await res.json();
}

async function loadBins() {
  const res = await fetch("/api/bins");
  if (!res.ok) throw new Error("bin load failed");
  return await res.json();
}

async function deleteBin(binId) {
  const res = await fetch(`/api/bins/${binId}`, { method: "DELETE" });
  if (!res.ok) {
    if (res.status === 404) throw new Error("bin not found");
    throw new Error("bin delete failed");
  }
}

function showToast(message, level = "info") {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const toast = document.createElement("div");
  toast.className = `toast ${level === "error" ? "error" : ""}`;
  toast.textContent = message;
  root.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

let currentMessage = null;
let bodyJsonMode = "pretty";
let uiTimezone = localStorage.getItem("ui-timezone") || "utc";
let nextBeforeId = null;
let currentFilters = { method: "", q: "", headerKey: "", headerValue: "" };

function formatTimestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (uiTimezone === "utc") return date.toISOString().slice(0, 23);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}.${get("fractionalSecond")}`;
}

function renderTimestamps(root = document) {
  root.querySelectorAll("[data-ui-timestamp]").forEach((el) => {
    el.textContent = formatTimestamp(el.dataset.iso);
  });
  root.querySelectorAll("[data-timezone]").forEach((button) => {
    button.classList.toggle("active", button.dataset.timezone === uiTimezone);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHomepage(data) {
  const bins = data.bins || [];
  const root = document.querySelector("[data-homepage-root]");
  if (!root) return;
  const baseUrl = root.dataset.baseUrl || location.origin;
  const totalBins = document.querySelector("[data-homepage-total-bins]");
  const totalMessages = document.querySelector("[data-homepage-total-messages]");
  const latestActivity = document.querySelector("[data-homepage-latest-activity]");
  const binsContainer = document.querySelector("[data-homepage-bins]");

  if (totalBins) totalBins.textContent = String(bins.length);
  if (totalMessages) totalMessages.textContent = String(bins.reduce((sum, bin) => sum + Number(bin.message_count || 0), 0));
  if (latestActivity) {
    latestActivity.dataset.iso = bins.find((bin) => bin.last_message_at)?.last_message_at || "";
    latestActivity.textContent = formatTimestamp(latestActivity.dataset.iso);
  }
  if (!binsContainer) return;
  binsContainer.innerHTML = bins.map((bin) => `
    <article class="card">
      <div class="card-head">
        <div>
          <h2><a href="/bins/${bin.id}">${escapeHtml(bin.name)}</a></h2>
          <p class="muted">${escapeHtml(bin.id)}</p>
        </div>
        <span class="pill">${bin.message_count} msgs</span>
      </div>
      <dl class="meta">
        <div>
          <dt>Ingest URL</dt>
          <dd class="meta-url-row">
            <code>/hooks/${bin.id}</code>
            <button type="button" class="icon-btn" data-copy-text="${escapeHtml(`${baseUrl}/hooks/${bin.id}`)}">Copy</button>
          </dd>
        </div>
        <div><dt>Last msg</dt><dd><span data-ui-timestamp data-iso="${escapeHtml(bin.last_message_at || "")}">${escapeHtml(bin.last_message_at || "—")}</span></dd></div>
      </dl>
      <div class="card-footer">
        <button type="button" class="ghost-danger" data-delete-bin="${bin.id}">Delete bin</button>
      </div>
    </article>
  `).join("") || `<article class="empty"><h2>No bins yet</h2><p>Create one, then POST to its ingest URL.</p></article>`;
  renderTimestamps(document);
}

function messageCard(message) {
  const rawPreview = message.body_preview || "";
  const body = rawPreview.length > 80 ? rawPreview.slice(0, 80) + "…" : rawPreview;
  const badge = message.body_json ? `<span class="pill">JSON</span>` : "";
  const sigStatus = message.signature_status;
  const sig = (sigStatus && sigStatus !== "disabled")
    ? `<span class="pill pill-sig-${escapeHtml(sigStatus)}">sig:${escapeHtml(sigStatus)}</span>`
    : "";
  return `
    <button class="message-item" data-message-id="${message.id}">
      <div class="message-head">
        <span class="message-id-method">${methodPill(message.method)}<strong>#${message.id}</strong></span>
        ${badge}${sig}
        <span class="muted" data-ui-timestamp data-iso="${escapeHtml(message.received_at)}">${escapeHtml(message.received_at)}</span>
      </div>
      <div class="muted">${escapeHtml(message.path)}${message.query_string ? `?${escapeHtml(message.query_string)}` : ""}</div>
      <div class="message-body">${escapeHtml(body)}</div>
    </button>
  `;
}

function methodPill(method) {
  const m = escapeHtml(method || "");
  return `<span class="method method-${m}">${m}</span>`;
}

function bodyContent(message) {
  if (!message.body_json) return escapeHtml(message.body_text || "");
  return bodyJsonMode === "compact"
    ? escapeHtml(JSON.stringify(message.body_json))
    : escapeHtml(JSON.stringify(message.body_json, null, 2));
}

function bodyModeButton(mode, label, active) {
  return `<button type="button" class="toggle-btn ${active ? "active" : ""}" data-body-mode="${mode}">${label}</button>`;
}

function renderMessageDetail(message) {
  const detail = document.getElementById("message-detail");
  if (!detail) return;
  const hasJson = Boolean(message.body_json);
  detail.classList.remove("detail-empty");
  detail.innerHTML = `
   <h3 class="section-title">${methodPill(message.method)} #${message.id}</h3>
   <p class="muted" data-ui-timestamp data-iso="${escapeHtml(message.received_at)}">${escapeHtml(message.received_at)}</p>
   <p><strong>Path:</strong> ${escapeHtml(message.path)}${message.query_string ? `?${escapeHtml(message.query_string)}` : ""}</p>
   <p><strong>Remote:</strong> ${escapeHtml(message.remote_addr || "—")} | <strong>Content-Type:</strong> ${escapeHtml(message.content_type || "—")}</p>
   ${message.signature_status && message.signature_status !== "disabled" ? `<p><strong>Signature:</strong> ${escapeHtml(message.signature_status)} ${message.signature_details ? `(${escapeHtml(message.signature_details)})` : ""}</p>` : ""}
   <div class="toolbar">
     <button type="button" data-copy-curl="/api/messages/${message.id}/curl">Copy cURL</button>
     <a class="ghost" href="/api/messages/${message.id}/export">Download JSON</a>
   </div>
   <h4>Headers</h4>
   <pre class="message-body">${escapeHtml(JSON.stringify(message.headers, null, 2))}</pre>
   <div class="body-head">
     <h4>Body</h4>
     ${hasJson ? `<div class="body-toggle">${bodyModeButton("pretty", "Pretty", bodyJsonMode === "pretty")}${bodyModeButton("compact", "Compact", bodyJsonMode === "compact")}</div>` : ""}
   </div>
   <pre class="message-body">${bodyContent(message)}</pre>
  `;
  renderTimestamps(detail);
  detail.querySelectorAll("[data-body-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      bodyJsonMode = button.dataset.bodyMode;
      renderMessageDetail(currentMessage);
    });
  });
}

async function showMessage(messageId) {
  const res = await fetch(`/api/messages/${messageId}`);
  if (!res.ok) throw new Error("message detail failed");
  const data = await res.json();
  currentMessage = data.message;
  bodyJsonMode = "pretty";
  renderMessageDetail(currentMessage);
  document.querySelectorAll(".message-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.messageId === String(messageId));
  });
}

async function refreshMessages({ append = false } = {}) {
  const container = document.getElementById("messages");
  if (!container) return;
  const binId = container.dataset.binId;
  const data = await loadMessages(binId, {
    limit: 100,
    beforeId: append ? nextBeforeId : null,
    ...currentFilters,
  });
  nextBeforeId = data.next_before_id;
  const totalCount = data.bin?.message_count ?? null;
  const html = data.messages.map(messageCard).join("") || `<p class="muted">No messages yet.</p>`;
  if (append) {
    container.insertAdjacentHTML("beforeend", html);
  } else {
    container.innerHTML = html;
  }
  // Show exact total from bin metadata; fall back to DOM count when filtered
  const countEl = document.getElementById("messages-count");
  if (countEl) {
    const isFiltered = Object.values(currentFilters).some(Boolean);
    if (isFiltered) {
      const domCount = container.querySelectorAll(".message-item").length;
      countEl.textContent = domCount > 0 ? `(${domCount}${nextBeforeId ? "+" : ""})` : "";
    } else {
      countEl.textContent = totalCount != null && totalCount > 0 ? `(${totalCount})` : "";
    }
  }
  renderTimestamps(container);
  container.querySelectorAll(".message-item").forEach((button) => {
    button.onclick = () => showMessage(button.dataset.messageId).catch((error) => showToast(error.message, "error"));
  });
  const loadMoreBtn = document.getElementById("load-more-btn");
  if (loadMoreBtn) {
    loadMoreBtn.disabled = !nextBeforeId;
    loadMoreBtn.style.display = nextBeforeId ? "" : "none";
  }
}

async function confirmDeleteBin(binId) {
  const typed = window.prompt(`Type bin id "${binId}" to confirm delete.`);
  if (typed !== binId) {
    showToast("Delete canceled: bin id mismatch", "error");
    return false;
  }
  return true;
}

async function handleDeleteBin(button) {
  const binId = button.dataset.deleteBin;
  if (!binId) return;
  if (!(await confirmDeleteBin(binId))) return;
  await deleteBin(binId);
  showToast(`Deleted bin ${binId}`);
  const redirect = button.dataset.deleteRedirect;
  if (redirect) {
    window.location.href = redirect;
    return;
  }
  const homepage = document.querySelector("[data-homepage-root]");
  if (homepage) {
    const bins = await loadBins();
    renderHomepage(bins);
  }
}

function setupLiveStream(binId) {
  const statusEl = document.getElementById("live-status");
  if (!window.EventSource || !statusEl) return;
  const source = new EventSource(`/api/bins/${binId}/stream`);
  source.addEventListener("message", () => {
    if (document.hidden) return;
    refreshMessages().catch(() => {});
    statusEl.textContent = "Live: connected";
    statusEl.classList.add("live-ok");
    statusEl.classList.remove("live-fallback");
  });
  source.onerror = () => {
    statusEl.textContent = "Live: fallback polling";
    statusEl.classList.remove("live-ok");
    statusEl.classList.add("live-fallback");
  };
}

document.addEventListener("DOMContentLoaded", () => {
  const POLL_INTERVAL_MS = 5000;

  const form = document.getElementById("create-bin-form");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      createBin(form).catch((error) => showToast(error.message, "error"));
    });
  }

  const messages = document.getElementById("messages");
  if (messages) {
    const binId = messages.dataset.binId;
    refreshMessages().catch((error) => {
      messages.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
    });
    setupLiveStream(binId);
    document.getElementById("refresh-btn")?.addEventListener("click", () => {
      refreshMessages().catch((error) => showToast(error.message, "error"));
    });
    document.getElementById("load-more-btn")?.addEventListener("click", () => {
      refreshMessages({ append: true }).catch((error) => showToast(error.message, "error"));
    });
    document.getElementById("message-filter-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);
      currentFilters = {
        method: String(formData.get("method") || ""),
        q: String(formData.get("q") || "").trim(),
        headerKey: String(formData.get("header_key") || "").trim(),
        headerValue: String(formData.get("header_value") || "").trim(),
      };
      nextBeforeId = null;
      refreshMessages().catch((error) => showToast(error.message, "error"));
    });
    document.getElementById("filter-reset-btn")?.addEventListener("click", () => {
      const filterForm = document.getElementById("message-filter-form");
      if (filterForm) filterForm.reset();
      currentFilters = { method: "", q: "", headerKey: "", headerValue: "" };
      nextBeforeId = null;
      refreshMessages().catch((error) => showToast(error.message, "error"));
    });
    const advancedBtn = document.getElementById("filter-advanced-btn");
    const advancedPanel = document.getElementById("filter-advanced");
    if (advancedBtn && advancedPanel) {
      advancedBtn.addEventListener("click", () => {
        const open = !advancedPanel.classList.contains("hidden");
        advancedPanel.classList.toggle("hidden", open);
        advancedBtn.textContent = open ? "Advanced ▾" : "Advanced ▲";
      });
    }
    setInterval(() => {
      if (document.hidden) return;
      refreshMessages().catch(() => {});
    }, POLL_INTERVAL_MS);
  }

  const homepage = document.querySelector("[data-homepage-root]");
  if (homepage) {
    loadBins().then(renderHomepage).catch(() => {});
    setInterval(() => {
      if (document.hidden) return;
      loadBins().then(renderHomepage).catch(() => {});
    }, POLL_INTERVAL_MS);
  }

  const timezoneToggle = document.querySelector("[data-timezone-toggle]");
  if (timezoneToggle) {
    renderTimestamps(document);
    timezoneToggle.querySelectorAll("[data-timezone]").forEach((button) => {
      button.addEventListener("click", () => {
        uiTimezone = button.dataset.timezone;
        localStorage.setItem("ui-timezone", uiTimezone);
        renderTimestamps(document);
      });
    });
  }

  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.textContent || "");
        showToast("Copied");
      } catch {
        showToast("Copy failed", "error");
      }
    });
  });

  // data-copy-text: copy inline text (used in dynamically rendered cards)
  document.addEventListener("click", (event) => {
    const copyTextBtn = event.target.closest("[data-copy-text]");
    if (copyTextBtn && !copyTextBtn.closest("[data-delete-bin]")) {
      event.preventDefault();
      navigator.clipboard.writeText(copyTextBtn.dataset.copyText || "")
        .then(() => showToast("Copied"))
        .catch(() => showToast("Copy failed", "error"));
      return;
    }
  });

  document.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete-bin]");
    if (deleteButton) {
      event.preventDefault();
      handleDeleteBin(deleteButton).catch((error) => showToast(error.message, "error"));
      return;
    }
    const curlButton = event.target.closest("[data-copy-curl]");
    if (curlButton) {
      event.preventDefault();
      fetch(curlButton.dataset.copyCurl)
        .then((res) => {
          if (!res.ok) throw new Error("failed to load curl");
          return res.text();
        })
        .then((text) => navigator.clipboard.writeText(text))
        .then(() => showToast("cURL copied"))
        .catch((error) => showToast(error.message, "error"));
    }
  });

  // Hide debug-only elements unless ?debug=1 in URL
  if (!new URLSearchParams(location.search).get("debug")) {
    document.querySelectorAll("[data-debug-only]").forEach((el) => { el.style.display = "none"; });
  }
});
