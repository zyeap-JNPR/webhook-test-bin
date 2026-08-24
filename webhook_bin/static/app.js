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
  if (params.afterId) query.set("after_id", String(params.afterId));
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
  if (!loadBins.inFlight) {
    loadBins.inFlight = (async () => {
      const res = await fetch("/api/bins");
      if (!res.ok) throw new Error("bin load failed");
      return await res.json();
    })();
    loadBins.inFlight.finally(() => { loadBins.inFlight = null; });
  }
  return await loadBins.inFlight;
}
loadBins.inFlight = null;

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
let currentPageSize = Number(localStorage.getItem("ui-page-size") || "25");
let knownTotalMessages = null;
let maxKnownMessageId = 0;
let lastMessagesRefreshAt = 0;
let lastHomepageRefreshAt = 0;
const VISIBILITY_REFRESH_MIN_INTERVAL_MS = 60000;
const MESSAGE_FALLBACK_POLL_INTERVAL_MS = 300000;
// message id (number) -> full detail object; never invalidated (messages are immutable)
const messageDetailCache = new Map();
// message id (number) -> slim list object; used for instant optimistic render
const listMessageCache = new Map();
// message id (number) -> generated curl command
const curlTextCache = new Map();
let currentAbortController = null;
let messagesPollTimer = null;
let streamRefreshDebounceTimer = null;
let streamRefreshPending = false;
let refreshMessagesInFlight = null;
let liveStreamConnected = false;

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
  // slim list uses has_json flag; full detail object has body_json
  const isJson = message.has_json != null ? message.has_json : Boolean(message.body_json);
  const badge = isJson ? `<span class="pill">JSON</span>` : "";
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
  if (!message.body_json) return escapeHtml(message.body_text || message.body_preview || "");
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
  const partial = message._partial === true;
  const hasJson = Boolean(message.body_json);
  const headersHtml = (!partial || message.headers)
    ? `<pre class="message-body">${escapeHtml(JSON.stringify(message.headers || {}, null, 2))}</pre>`
    : `<pre class="message-body muted">Loading headers…</pre>`;
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
   ${headersHtml}
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

function setActiveMessage(id) {
  document.querySelectorAll(".message-item").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.messageId) === id);
  });
}

function wireMessageButton(button) {
  button.onclick = () => showMessage(button.dataset.messageId).catch((error) => showToast(error.message, "error"));
}

function hasActiveFilters() {
  return Object.values(currentFilters).some(Boolean);
}

function updateMessagesCount(container) {
  const countEl = document.getElementById("messages-count");
  if (!countEl) return;
  const shownCount = container.querySelectorAll(".message-item").length;
  if (hasActiveFilters()) {
    countEl.textContent = shownCount > 0 ? `(${shownCount}${nextBeforeId ? "+" : ""} filtered)` : "";
  } else if (knownTotalMessages != null && knownTotalMessages > 0) {
    countEl.textContent = shownCount < knownTotalMessages
      ? `(${shownCount} of ${knownTotalMessages})`
      : `(${knownTotalMessages})`;
  } else {
    countEl.textContent = "";
  }
}

async function showMessage(messageId) {
  const id = Number(messageId);

  // Cancel any pending detail fetch
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }

  // Mark active immediately
  setActiveMessage(id);

  // Serve from cache (already fully fetched)
  if (messageDetailCache.has(id)) {
    currentMessage = messageDetailCache.get(id);
    bodyJsonMode = "pretty";
    renderMessageDetail(currentMessage);
    return;
  }

  // Optimistic instant render from slim list data while the full detail loads
  const listMsg = listMessageCache.get(id);
  if (listMsg) {
    currentMessage = { ...listMsg, _partial: true };
    bodyJsonMode = "pretty";
    renderMessageDetail(currentMessage);
  }

  // Fetch full detail
  const ac = new AbortController();
  currentAbortController = ac;
  try {
    const res = await fetch(`/api/messages/${id}`, { signal: ac.signal });
    if (!res.ok) throw new Error("message detail failed");
    const data = await res.json();
    if (currentAbortController !== ac) return; // superseded by a newer click
    currentMessage = data.message;
    messageDetailCache.set(id, currentMessage);
    bodyJsonMode = "pretty";
    renderMessageDetail(currentMessage);
    // Re-apply active in case a concurrent refreshMessages cleared it
    setActiveMessage(id);
  } catch (err) {
    if (err.name === "AbortError") return;
    throw err;
  } finally {
    if (currentAbortController === ac) currentAbortController = null;
  }
}

async function runRefreshMessages({ append = false } = {}) {
  const container = document.getElementById("messages");
  if (!container) return;
  const binId = container.dataset.binId;
  const data = await loadMessages(binId, {
    limit: currentPageSize,
    beforeId: append ? nextBeforeId : null,
    ...currentFilters,
  });
  nextBeforeId = data.next_before_id;
  knownTotalMessages = data.bin?.message_count ?? null;

  // Cache slim list rows for instant optimistic detail render on click
  for (const msg of data.messages) {
    listMessageCache.set(msg.id, msg);
    if (msg.id > maxKnownMessageId) maxKnownMessageId = msg.id;
  }

  const html = data.messages.map(messageCard).join("") || `<p class="muted">No messages yet.</p>`;

  if (append) {
    container.insertAdjacentHTML("beforeend", html);
  } else {
    // Preserve scroll position and active selection across re-render
    const prevScrollTop = container.scrollTop;
    const activeId = container.querySelector(".message-item.active")?.dataset.messageId;
    container.innerHTML = html;
    if (activeId) {
      container.querySelector(`[data-message-id="${activeId}"]`)?.classList.add("active");
    }
    container.scrollTop = prevScrollTop;
  }

  updateMessagesCount(container);

  renderTimestamps(container);
  container.querySelectorAll(".message-item").forEach((button) => {
    wireMessageButton(button);
  });
  lastMessagesRefreshAt = Date.now();

  const loadMoreBtn = document.getElementById("load-more-btn");
  if (loadMoreBtn) {
    loadMoreBtn.disabled = !nextBeforeId;
    loadMoreBtn.style.display = nextBeforeId ? "" : "none";
    loadMoreBtn.textContent = nextBeforeId ? `Load more (${currentPageSize})` : "Load more";
  }
}

async function refreshMessages(options = {}) {
  const { append = false } = options;
  if (append) return await runRefreshMessages(options);
  if (!refreshMessagesInFlight) {
    refreshMessagesInFlight = runRefreshMessages(options).finally(() => {
      refreshMessagesInFlight = null;
    });
  }
  return await refreshMessagesInFlight;
}

function shouldRefreshOnVisible(lastRefreshAt) {
  return (Date.now() - lastRefreshAt) >= VISIBILITY_REFRESH_MIN_INTERVAL_MS;
}

function maybeRefreshMessagesOnVisible() {
  if (document.hidden) return;
  if (streamRefreshPending) {
    streamRefreshPending = false;
    refreshMessages().catch(() => {});
    return;
  }
  if (liveStreamConnected) return;
  if (!shouldRefreshOnVisible(lastMessagesRefreshAt)) return;
  refreshMessages().catch(() => {});
}

function refreshHomepage() {
  return loadBins().then((bins) => {
    renderHomepage(bins);
    lastHomepageRefreshAt = Date.now();
  });
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
  if (document.querySelector("[data-homepage-root]")) {
    await refreshHomepage();
  }
}

function stopMessagesPolling() {
  if (messagesPollTimer) {
    clearTimeout(messagesPollTimer);
    messagesPollTimer = null;
  }
}

function startMessagesPolling(intervalMs) {
  stopMessagesPolling();
  const tick = async () => {
    if (!document.hidden) await refreshMessages().catch(() => {});
    messagesPollTimer = setTimeout(tick, intervalMs);
  };
  messagesPollTimer = setTimeout(tick, intervalMs);
}

function appendMessageFromStream(streamMessage) {
  const container = document.getElementById("messages");
  if (!container) return;
  const id = Number(streamMessage.id);
  if (!Number.isFinite(id)) return;
  if (hasActiveFilters()) {
    scheduleStreamRefresh();
    return;
  }
  if (container.querySelector(`[data-message-id="${id}"]`)) return;
  listMessageCache.set(id, streamMessage);
  if (id > maxKnownMessageId) maxKnownMessageId = id;

  if (!container.querySelector(".message-item")) {
    container.innerHTML = "";
  }
  container.insertAdjacentHTML("afterbegin", messageCard(streamMessage));
  const button = container.querySelector(`[data-message-id="${id}"]`);
  if (button) wireMessageButton(button);
  renderTimestamps(container);
  if (knownTotalMessages != null) knownTotalMessages += 1;
  updateMessagesCount(container);
}

function scheduleStreamRefresh() {
  if (streamRefreshDebounceTimer) return;
  if (document.hidden) {
    streamRefreshPending = true;
    return;
  }
  streamRefreshDebounceTimer = setTimeout(() => {
    streamRefreshDebounceTimer = null;
    streamRefreshPending = false;
    refreshMessages().catch(() => {});
  }, 300);
}

function setupLiveStream(binId, afterId = 0) {
  const statusEl = document.getElementById("live-status");
  if (!window.EventSource || !statusEl) return false;
  const source = new EventSource(`/api/bins/${binId}/stream?after_id=${afterId}`);
  source.onopen = () => {
    liveStreamConnected = true;
    stopMessagesPolling();
    statusEl.textContent = "Live: connected";
    statusEl.classList.add("live-ok");
    statusEl.classList.remove("live-fallback");
  };
  source.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data || "{}");
      if (payload?.message) {
        appendMessageFromStream(payload.message);
      } else {
        scheduleStreamRefresh();
      }
    } catch {
      scheduleStreamRefresh();
    }
  });
  source.onerror = () => {
    liveStreamConnected = false;
    source.close();
    statusEl.textContent = "Live: fallback polling";
    statusEl.classList.remove("live-ok");
    statusEl.classList.add("live-fallback");
    if (!messagesPollTimer) startMessagesPolling(MESSAGE_FALLBACK_POLL_INTERVAL_MS);
  };
  return true;
}

document.addEventListener("DOMContentLoaded", () => {
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
    refreshMessages().then(() => {
      const hasLiveStream = setupLiveStream(binId, maxKnownMessageId);
      if (!hasLiveStream) startMessagesPolling(MESSAGE_FALLBACK_POLL_INTERVAL_MS);
    }).catch((error) => {
      messages.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
      startMessagesPolling(MESSAGE_FALLBACK_POLL_INTERVAL_MS);
    });
    document.getElementById("refresh-btn")?.addEventListener("click", () => {
      refreshMessages().catch((error) => showToast(error.message, "error"));
    });
    document.getElementById("load-more-btn")?.addEventListener("click", () => {
      refreshMessages({ append: true }).catch((error) => showToast(error.message, "error"));
    });
    const pageSizeSelect = document.getElementById("page-size-select");
    if (pageSizeSelect) {
      pageSizeSelect.value = String(currentPageSize);
      pageSizeSelect.addEventListener("change", () => {
        currentPageSize = Number(pageSizeSelect.value);
        localStorage.setItem("ui-page-size", String(currentPageSize));
        nextBeforeId = null;
        refreshMessages().catch((error) => showToast(error.message, "error"));
      });
    }
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
    document.addEventListener("visibilitychange", () => {
      maybeRefreshMessagesOnVisible();
    });
  }

  const homepage = document.querySelector("[data-homepage-root]");
  if (homepage) {
    lastHomepageRefreshAt = Date.now();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (!shouldRefreshOnVisible(lastHomepageRefreshAt)) return;
      refreshHomepage().catch(() => {});
    });
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
      const messageId = Number(curlButton.dataset.copyCurl?.split("/").at(-2));
      const cachedText = Number.isFinite(messageId) ? curlTextCache.get(messageId) : null;
      const writeText = cachedText
        ? Promise.resolve(cachedText)
        : fetch(curlButton.dataset.copyCurl)
          .then((res) => {
            if (!res.ok) throw new Error("failed to load curl");
            return res.text();
          })
          .then((text) => {
            if (Number.isFinite(messageId)) curlTextCache.set(messageId, text);
            return text;
          });
      writeText
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
