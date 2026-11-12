async function createBin(form) {
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating…";
  }
  try {
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
  } catch (err) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create bin";
    }
    throw err;
  }
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

async function deleteMessage(messageId) {
  const res = await fetch(`/api/messages/${messageId}`, { method: "DELETE" });
  if (!res.ok) {
    if (res.status === 404) throw new Error("message not found");
    throw new Error("message delete failed");
  }
}

async function clearBinMessages(binId) {
  const res = await fetch(`/api/bins/${binId}/messages`, { method: "DELETE" });
  if (!res.ok) {
    if (res.status === 404) throw new Error("bin not found");
    throw new Error("clear messages failed");
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
const MESSAGE_FALLBACK_POLL_MIN_MS = 300000;
const MESSAGE_FALLBACK_POLL_MAX_MS = 900000;
let fallbackPollIntervalMs = MESSAGE_FALLBACK_POLL_MIN_MS;
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

const RELATIVE_TIME_FORMATTER = typeof Intl.RelativeTimeFormat !== "undefined"
  ? new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  : null;

function formatRelativeTime(date) {
  if (!RELATIVE_TIME_FORMATTER) return date.toISOString().slice(0, 23);
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, secondsInUnit] of units) {
    if (Math.abs(diffSec) >= secondsInUnit || unit === "second") {
      return RELATIVE_TIME_FORMATTER.format(-Math.round(diffSec / secondsInUnit), unit);
    }
  }
  return RELATIVE_TIME_FORMATTER.format(0, "second");
}

function formatTimestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (uiTimezone === "rel") return formatRelativeTime(date);
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
    const isActive = button.dataset.timezone === uiTimezone;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

// Briefly swaps a copy button's label to a checkmark as extra confirmation
// alongside the toast (useful when the toast has already scrolled by).
function flashCopied(button, label = "Copied") {
  if (!button) return;
  if (button.dataset.copyOriginalLabel === undefined) {
    button.dataset.copyOriginalLabel = button.textContent;
  }
  button.textContent = `✓ ${label}`;
  button.classList.add("copied");
  clearTimeout(Number(button.dataset.copyFlashTimer) || undefined);
  const timer = setTimeout(() => {
    button.textContent = button.dataset.copyOriginalLabel;
    button.classList.remove("copied");
  }, 1500);
  button.dataset.copyFlashTimer = String(timer);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function applyHomepageBinFilter() {
  const input = document.getElementById("bin-search-input");
  const binsContainer = document.querySelector("[data-homepage-bins]");
  const shownEl = document.querySelector("[data-homepage-shown-count]");
  if (!binsContainer) return;
  const cards = Array.from(binsContainer.querySelectorAll("[data-bin-card]"));
  const q = (input?.value || "").trim().toLowerCase();
  let visibleCount = 0;
  for (const card of cards) {
    const match = !q
      || (card.dataset.binName || "").includes(q)
      || (card.dataset.binId || "").includes(q);
    card.classList.toggle("hidden", !match);
    if (match) visibleCount += 1;
  }
  let noMatchEl = binsContainer.querySelector("[data-bin-filter-empty]");
  if (cards.length > 0 && visibleCount === 0) {
    if (!noMatchEl) {
      binsContainer.insertAdjacentHTML(
        "beforeend",
        `<article class="empty" data-bin-filter-empty><h2>No matching bins</h2><p>Clear filter to see all ${cards.length} bins.</p></article>`,
      );
    }
  } else if (noMatchEl) {
    noMatchEl.remove();
  }
  if (shownEl) {
    shownEl.textContent = q && visibleCount !== cards.length
      ? `(${visibleCount} of ${cards.length})`
      : `(${cards.length})`;
  }
}

function renderHomepage(data) {
  const bins = data.bins || [];
  const root = document.querySelector("[data-homepage-root]");
  if (!root) return;
  const baseUrl = root.dataset.baseUrl || location.origin;
  const totalBins = document.querySelector("[data-homepage-total-bins]");
  const totalMessages = document.querySelector("[data-homepage-total-messages]");
  const latestActivity = document.querySelector("[data-homepage-latest-activity]");
  const toolbar = document.querySelector("[data-homepage-toolbar]");
  const binsContainer = document.querySelector("[data-homepage-bins]");

  if (totalBins) totalBins.textContent = String(bins.length);
  if (totalMessages) totalMessages.textContent = String(bins.reduce((sum, bin) => sum + Number(bin.message_count || 0), 0));
  if (latestActivity) {
    latestActivity.dataset.iso = bins.find((bin) => bin.last_message_at)?.last_message_at || "";
    latestActivity.textContent = formatTimestamp(latestActivity.dataset.iso);
  }
  if (toolbar) toolbar.classList.toggle("hidden", bins.length === 0);
  if (!binsContainer) return;
  binsContainer.innerHTML = bins.map((bin) => {
    const count = Number(bin.message_count || 0);
    const curlCmd = `curl -X POST '${baseUrl}/hooks/${bin.id}' -H 'content-type: application/json' -d '{"event":"ping"}'`;
    return `
    <article class="card" data-bin-card data-bin-name="${escapeHtml(String(bin.name || "").toLowerCase())}" data-bin-id="${escapeHtml(String(bin.id || "").toLowerCase())}">
      <div class="card-head">
        <div>
          <h2><a href="/bins/${bin.id}">${escapeHtml(bin.name)}</a></h2>
          <p class="muted mono">${escapeHtml(bin.id)}</p>
        </div>
        <span class="pill">${count} ${count === 1 ? "msg" : "msgs"}</span>
      </div>
      <dl class="meta">
        <div>
          <dt>Ingest URL</dt>
          <dd class="meta-url-row">
            <code>/hooks/${bin.id}</code>
            <button type="button" class="icon-btn" data-copy-text="${escapeHtml(`${baseUrl}/hooks/${bin.id}`)}">Copy URL</button>
            <button type="button" class="icon-btn" data-copy-text="${escapeHtml(curlCmd)}">Copy cURL</button>
          </dd>
        </div>
        <div><dt>Last msg</dt><dd><span data-ui-timestamp data-iso="${escapeHtml(bin.last_message_at || "")}">${escapeHtml(bin.last_message_at || "—")}</span></dd></div>
      </dl>
      <div class="card-footer">
        <a class="ghost card-open" href="/bins/${bin.id}">Open →</a>
        <button type="button" class="ghost-danger" data-delete-bin="${bin.id}">Delete bin</button>
      </div>
    </article>
  `;
  }).join("") || `<article class="empty"><h2>No bins yet</h2><p>Create a bin above, then send requests to <code>/hooks/&lt;bin_id&gt;</code>.</p></article>`;
  applyHomepageBinFilter();
  renderTimestamps(document);
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
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
  const size = message.body_size != null ? `<span class="size-label">${escapeHtml(formatBytes(message.body_size))}</span>` : "";
  const previewHtml = body
    ? `<div class="message-body">${escapeHtml(body)}</div>`
    : `<div class="message-body message-preview-empty">(empty body)</div>`;
  return `
    <button type="button" class="message-item" data-message-id="${message.id}">
      <div class="message-head">
        <span class="message-id-method">${methodPill(message.method)}<strong>#${message.id}</strong></span>
        <span class="message-badges">${badge}${sig}${size}</span>
        <span class="muted" data-ui-timestamp data-iso="${escapeHtml(message.received_at)}">${escapeHtml(message.received_at)}</span>
      </div>
      <div class="message-path">${escapeHtml(message.path)}${message.query_string ? `?${escapeHtml(message.query_string)}` : ""}</div>
      ${previewHtml}
    </button>
  `;
}

function methodPill(method) {
  const m = escapeHtml(method || "");
  return `<span class="method method-${m}">${m}</span>`;
}

function formattedBodyText(message) {
  if (!message.body_json || bodyJsonMode === "raw") {
    return message.body_text ?? message.body_preview ?? "";
  }
  return bodyJsonMode === "compact"
    ? JSON.stringify(message.body_json)
    : JSON.stringify(message.body_json, null, 2);
}

function bodyModeButton(mode, label, active) {
  return `<button type="button" class="toggle-btn ${active ? "active" : ""}" data-body-mode="${mode}">${label}</button>`;
}

function renderKvRows(entries) {
  if (!entries.length) return `<p class="muted">None</p>`;
  return `<div class="kv-list">${entries.map(([k, v]) => `
    <div class="kv-row"><span class="kv-key">${escapeHtml(k)}</span><span class="kv-val">${escapeHtml(v)}</span></div>
  `).join("")}</div>`;
}

function resetMessageDetail() {
  currentMessage = null;
  const detail = document.getElementById("message-detail");
  if (!detail) return;
  detail.classList.add("detail-empty");
  detail.textContent = "Pick a message to see headers and body.";
}

function renderMessageDetail(message) {
  const detail = document.getElementById("message-detail");
  if (!detail) return;
  const partial = message._partial === true;
  const hasJson = Boolean(message.body_json);
  const headerEntries = Object.entries(message.headers || {});
  const headersHtml = (!partial || message.headers)
    ? renderKvRows(headerEntries)
    : `<pre class="message-body muted">Loading headers…</pre>`;
  const queryEntries = message.query_string
    ? Array.from(new URLSearchParams(message.query_string).entries())
    : [];
  const querySection = queryEntries.length
    ? `<div class="section-head"><h4>Query parameters <span class="count-badge">(${queryEntries.length})</span></h4></div>${renderKvRows(queryEntries)}`
    : "";
  const sigStatus = message.signature_status;
  const sigItem = (sigStatus && sigStatus !== "disabled")
    ? `<div class="detail-meta-item detail-meta-wide"><span class="detail-meta-label">Signature</span><span class="detail-meta-value"><span class="pill pill-sig-${escapeHtml(sigStatus)}">${escapeHtml(sigStatus)}</span> ${message.signature_details ? escapeHtml(message.signature_details) : ""}</span></div>`
    : "";
  const bodyText = formattedBodyText(message);
  const bodyBlock = bodyText
    ? `<pre class="message-body">${escapeHtml(bodyText)}</pre>`
    : (partial && Number(message.body_size) > 0
      ? `<pre class="message-body muted">Loading body…</pre>`
      : `<pre class="message-body message-preview-empty">(empty body)</pre>`);

  detail.classList.remove("detail-empty");
  detail.innerHTML = `
   <div class="detail-head">
     <div>
       <h3 class="section-title">${methodPill(message.method)} #${message.id}</h3>
       <p class="muted" data-ui-timestamp data-iso="${escapeHtml(message.received_at)}">${escapeHtml(message.received_at)}</p>
     </div>
     <div class="toolbar">
       <button type="button" data-copy-curl="/api/messages/${message.id}/curl">Copy cURL</button>
       <a class="ghost" href="/api/messages/${message.id}/export">Download JSON</a>
       <button type="button" class="ghost-danger" data-delete-message="${message.id}">Delete</button>
     </div>
   </div>
   <div class="detail-meta-grid">
     <div class="detail-meta-item detail-meta-wide"><span class="detail-meta-label">Path</span><span class="detail-meta-value"><code>${escapeHtml(message.path)}${message.query_string ? `?${escapeHtml(message.query_string)}` : ""}</code></span></div>
     <div class="detail-meta-item"><span class="detail-meta-label">Remote</span><span class="detail-meta-value">${escapeHtml(message.remote_addr || "—")}</span></div>
     <div class="detail-meta-item"><span class="detail-meta-label">Content-Type</span><span class="detail-meta-value">${escapeHtml(message.content_type || "—")}</span></div>
     <div class="detail-meta-item"><span class="detail-meta-label">Payload size</span><span class="detail-meta-value">${escapeHtml(formatBytes(message.body_size))}</span></div>
     ${sigItem}
   </div>
   ${querySection}
   <div class="section-head">
     <h4>Headers ${!partial ? `<span class="count-badge">(${headerEntries.length})</span>` : ""}</h4>
     ${(!partial && headerEntries.length) ? `<button type="button" class="icon-btn" data-copy-headers>Copy JSON</button>` : ""}
   </div>
   ${headersHtml}
   <div class="body-head">
     <h4>Body <span class="count-badge">(${escapeHtml(formatBytes(message.body_size))})</span></h4>
     <div class="body-toggle">
       ${hasJson ? `${bodyModeButton("pretty", "Pretty", bodyJsonMode === "pretty")}${bodyModeButton("compact", "Compact", bodyJsonMode === "compact")}${bodyModeButton("raw", "Raw", bodyJsonMode === "raw")}` : ""}
       ${bodyText ? `<button type="button" class="icon-btn" data-copy-body>Copy body</button>` : ""}
     </div>
   </div>
   ${bodyBlock}
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

function readHashMessageId() {
  const match = /^#msg-(\d+)$/.exec(window.location.hash || "");
  return match ? Number(match[1]) : null;
}

function setHashMessageId(id) {
  const url = `${window.location.pathname}${window.location.search}${id ? `#msg-${id}` : ""}`;
  window.history.replaceState(null, "", url);
}

function updateAdvancedFilterIndicator() {
  const advancedBtn = document.getElementById("filter-advanced-btn");
  if (!advancedBtn) return;
  advancedBtn.classList.toggle("active", Boolean(currentFilters.headerKey || currentFilters.headerValue));
}

function updateMessagesCount(container) {
  const countEl = document.getElementById("messages-count");
  const shownCount = container.querySelectorAll(".message-item").length;
  if (countEl) {
    if (hasActiveFilters()) {
      countEl.textContent = shownCount > 0 ? `(${shownCount}${nextBeforeId ? "+" : ""} filtered)` : "(0 filtered)";
    } else if (knownTotalMessages != null && knownTotalMessages > 0) {
      countEl.textContent = shownCount < knownTotalMessages
        ? `(${shownCount} of ${knownTotalMessages})`
        : `(${knownTotalMessages})`;
    } else {
      countEl.textContent = "";
    }
  }
  const clearBtn = document.getElementById("clear-messages-btn");
  if (clearBtn) {
    const hasAny = (knownTotalMessages ?? shownCount) > 0;
    clearBtn.classList.toggle("hidden", !hasAny);
  }
}

async function showMessage(messageId, { updateHash = true } = {}) {
  const id = Number(messageId);
  if (!Number.isFinite(id)) return;

  // Cancel any pending detail fetch
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }

  // Mark active immediately
  setActiveMessage(id);
  if (updateHash) setHashMessageId(id);

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
    if (!res.ok) throw new Error(res.status === 404 ? "message not found" : "message detail failed");
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
  applyMessagesResponse(data, { append });
}

function applyMessagesResponse(data, { append = false } = {}) {
  const container = document.getElementById("messages");
  if (!container) return;
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
    loadMoreBtn.classList.toggle("hidden", !nextBeforeId);
    loadMoreBtn.textContent = nextBeforeId ? `Load more (${currentPageSize})` : "Load more";
  }
}

function applyMessageDeleted(messageId) {
  const id = Number(messageId);
  listMessageCache.delete(id);
  messageDetailCache.delete(id);
  curlTextCache.delete(id);
  const container = document.getElementById("messages");
  if (!container) return;
  const el = container.querySelector(`[data-message-id="${id}"]`);
  if (el) {
    el.remove();
    if (knownTotalMessages != null && knownTotalMessages > 0) knownTotalMessages -= 1;
  }
  if (!container.querySelector(".message-item")) {
    container.innerHTML = `<p class="muted">No messages yet.</p>`;
  }
  if (currentMessage && Number(currentMessage.id) === id) {
    resetMessageDetail();
    setHashMessageId(null);
  }
  updateMessagesCount(container);
}

function applyMessagesCleared() {
  listMessageCache.clear();
  messageDetailCache.clear();
  curlTextCache.clear();
  nextBeforeId = null;
  knownTotalMessages = 0;
  const container = document.getElementById("messages");
  if (container) {
    container.innerHTML = `<p class="muted">No messages yet.</p>`;
    updateMessagesCount(container);
  }
  const loadMoreBtn = document.getElementById("load-more-btn");
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.classList.add("hidden");
  }
  resetMessageDetail();
  setHashMessageId(null);
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
  // Coming back to a backed-off fallback poll: reset to baseline so the tab
  // catches up promptly instead of waiting out a stale long interval.
  if (messagesPollTimer && fallbackPollIntervalMs > MESSAGE_FALLBACK_POLL_MIN_MS) {
    startMessagesPolling(MESSAGE_FALLBACK_POLL_MIN_MS);
  }
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

function startMessagesPolling(initialIntervalMs = MESSAGE_FALLBACK_POLL_MIN_MS) {
  stopMessagesPolling();
  fallbackPollIntervalMs = initialIntervalMs;
  const tick = async () => {
    if (!document.hidden) {
      const beforeMaxId = maxKnownMessageId;
      await refreshMessages().catch(() => {});
      // Back off further on quiet bins, reset to baseline as soon as new data shows up.
      fallbackPollIntervalMs = maxKnownMessageId > beforeMaxId
        ? MESSAGE_FALLBACK_POLL_MIN_MS
        : Math.min(Math.round(fallbackPollIntervalMs * 1.5), MESSAGE_FALLBACK_POLL_MAX_MS);
    }
    messagesPollTimer = setTimeout(tick, fallbackPollIntervalMs);
  };
  messagesPollTimer = setTimeout(tick, fallbackPollIntervalMs);
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
  if (button) {
    wireMessageButton(button);
    button.classList.add("new-pulse");
    button.addEventListener("animationend", () => button.classList.remove("new-pulse"), { once: true });
  }
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

function setupLiveStream(binId, afterId = 0, onEvent = null) {
  const statusEl = document.getElementById("live-status");
  if (!window.EventSource || !statusEl) return false;
  const source = new EventSource(`/api/bins/${binId}/stream?after_id=${afterId}`);
  source.onopen = () => {
    liveStreamConnected = true;
    stopMessagesPolling();
    statusEl.textContent = "Live: connected";
    statusEl.classList.add("live-ok");
    statusEl.classList.remove("live-fallback");
    onEvent?.({ type: "status", connected: true });
  };
  source.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data || "{}");
      if (payload?.type === "message_deleted" && payload.message_id != null) {
        applyMessageDeleted(payload.message_id);
        onEvent?.(payload);
      } else if (payload?.type === "messages_cleared") {
        applyMessagesCleared();
        onEvent?.(payload);
      } else if (payload?.message) {
        appendMessageFromStream(payload.message);
        onEvent?.({ type: "new_message", message: payload.message });
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
    onEvent?.({ type: "status", connected: false });
    if (!messagesPollTimer) startMessagesPolling(MESSAGE_FALLBACK_POLL_MIN_MS);
  };
  return true;
}

// Coordinates SSE across multiple tabs open on the same bin: only one tab (the
// "leader", chosen via the Web Locks API) holds a real EventSource connection;
// other tabs relay off a BroadcastChannel. This avoids N idle tunnel/tab
// connections for the same bin. Falls back to a plain per-tab connection when
// either API is unavailable. Note: a follower tab that starts listening after
// messages have already been relayed past it can miss those messages until its
// next manual refresh — an acceptable tradeoff for the common single-tab case.
function startLiveUpdates(binId, afterId = 0) {
  const statusEl = document.getElementById("live-status");
  if (!window.EventSource || !statusEl) {
    startMessagesPolling(MESSAGE_FALLBACK_POLL_MIN_MS);
    return;
  }
  if (typeof BroadcastChannel === "undefined" || !("locks" in navigator)) {
    if (!setupLiveStream(binId, afterId)) startMessagesPolling(MESSAGE_FALLBACK_POLL_MIN_MS);
    return;
  }

  const channel = new BroadcastChannel(`webhook-bin-stream-${binId}`);
  let isLeader = false;
  channel.onmessage = (event) => {
    const payload = event.data;
    if (payload?.type === "hello") {
      // A newly-joined tab is asking for current status; only the leader answers.
      if (isLeader) channel.postMessage({ type: "status", connected: liveStreamConnected });
      return;
    }
    if (isLeader) return; // leader already applied this event locally
    if (payload?.type === "new_message" && payload.message) {
      appendMessageFromStream(payload.message);
    } else if (payload?.type === "message_deleted" && payload.message_id != null) {
      applyMessageDeleted(payload.message_id);
    } else if (payload?.type === "messages_cleared") {
      applyMessagesCleared();
    } else if (payload?.type === "status") {
      liveStreamConnected = Boolean(payload.connected);
      stopMessagesPolling();
      statusEl.textContent = payload.connected ? "Live: connected" : "Live: fallback polling";
      statusEl.classList.toggle("live-ok", payload.connected);
      statusEl.classList.toggle("live-fallback", !payload.connected);
    }
  };
  statusEl.textContent = "Live: connecting…";
  // Ask any existing leader tab for its current status (covers the case where
  // this tab joins after the leader's initial connection already happened).
  channel.postMessage({ type: "hello" });

  navigator.locks.request(`webhook-bin-stream-lock-${binId}`, { mode: "exclusive" }, () => {
    isLeader = true;
    const hasStream = setupLiveStream(binId, maxKnownMessageId, (event) => channel.postMessage(event));
    if (!hasStream) startMessagesPolling(MESSAGE_FALLBACK_POLL_MIN_MS);
    return new Promise(() => {}); // hold the lock (and connection) until this tab unloads
  }).catch(() => {});
}

function readBootstrapMessages(container) {
  const el = document.getElementById("bootstrap-messages");
  if (!el) return null;
  el.remove(); // one-time use, avoid stale re-reads on later refresh calls
  if (hasActiveFilters()) return null;
  const bootstrapSize = Number(container.dataset.bootstrapPageSize || "0");
  if (!bootstrapSize || currentPageSize !== bootstrapSize) return null;
  try {
    const data = JSON.parse(el.textContent || "null");
    if (!data || !data.bin || data.bin.id !== container.dataset.binId) return null;
    return data;
  } catch {
    return null;
  }
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
    const bootstrap = readBootstrapMessages(messages);
    const initial = bootstrap ? Promise.resolve(applyMessagesResponse(bootstrap)) : refreshMessages();
    initial.then(() => {
      const hashMsgId = readHashMessageId();
      if (hashMsgId) {
        showMessage(hashMsgId, { updateHash: false }).catch((error) => showToast(error.message, "error"));
      }
      startLiveUpdates(binId, maxKnownMessageId);
    }).catch((error) => {
      messages.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
      startMessagesPolling(MESSAGE_FALLBACK_POLL_MIN_MS);
    });
    window.addEventListener("hashchange", () => {
      const hashMsgId = readHashMessageId();
      if (hashMsgId && (!currentMessage || Number(currentMessage.id) !== hashMsgId)) {
        showMessage(hashMsgId, { updateHash: false }).catch((error) => showToast(error.message, "error"));
      }
    });
    document.getElementById("refresh-btn")?.addEventListener("click", () => {
      refreshMessages().catch((error) => showToast(error.message, "error"));
    });
    document.getElementById("clear-messages-btn")?.addEventListener("click", async () => {
      if (!window.confirm("Clear all messages in this bin? The bin and its ingest URL will stay active.")) return;
      try {
        await clearBinMessages(binId);
        applyMessagesCleared();
        showToast("Cleared messages");
      } catch (error) {
        showToast(error.message, "error");
      }
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
      updateAdvancedFilterIndicator();
      refreshMessages().catch((error) => showToast(error.message, "error"));
    });
    document.getElementById("filter-reset-btn")?.addEventListener("click", () => {
      const filterForm = document.getElementById("message-filter-form");
      if (filterForm) filterForm.reset();
      currentFilters = { method: "", q: "", headerKey: "", headerValue: "" };
      nextBeforeId = null;
      updateAdvancedFilterIndicator();
      refreshMessages().catch((error) => showToast(error.message, "error"));
    });
    const advancedBtn = document.getElementById("filter-advanced-btn");
    const advancedPanel = document.getElementById("filter-advanced");
    if (advancedBtn && advancedPanel) {
      advancedBtn.addEventListener("click", () => {
        const willCollapse = !advancedPanel.classList.contains("hidden");
        advancedPanel.classList.toggle("hidden", willCollapse);
        advancedBtn.setAttribute("aria-expanded", String(!willCollapse));
        advancedBtn.textContent = willCollapse ? "Advanced ▾" : "Advanced ▲";
      });
    }
    document.addEventListener("visibilitychange", () => {
      maybeRefreshMessagesOnVisible();
    });
    document.addEventListener("keydown", (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const isTyping = target instanceof HTMLElement
        && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.key === "Escape" && isTyping && target instanceof HTMLElement) {
        target.blur();
        return;
      }
      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        document.querySelector('#message-filter-form input[name="q"]')?.focus();
        return;
      }
      if (isTyping) return;
      if (event.key === "r") {
        refreshMessages().catch((error) => showToast(error.message, "error"));
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = Array.from(messages.querySelectorAll(".message-item"));
        if (!items.length) return;
        event.preventDefault();
        const activeIndex = items.findIndex((el) => el.classList.contains("active"));
        const step = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = activeIndex === -1 ? 0 : Math.min(Math.max(activeIndex + step, 0), items.length - 1);
        const nextItem = items[nextIndex];
        nextItem?.click();
        nextItem?.scrollIntoView({ block: "nearest" });
      }
    });
  }

  const homepage = document.querySelector("[data-homepage-root]");
  if (homepage) {
    lastHomepageRefreshAt = Date.now();
    const binSearchInput = document.getElementById("bin-search-input");
    binSearchInput?.addEventListener("input", () => applyHomepageBinFilter());
    document.addEventListener("keydown", (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const isTyping = target instanceof HTMLElement
        && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.key === "Escape" && target === binSearchInput) {
        if (binSearchInput.value) {
          binSearchInput.value = "";
          applyHomepageBinFilter();
        }
        binSearchInput.blur();
        return;
      }
      if (event.key === "/" && !isTyping && binSearchInput && !binSearchInput.closest(".hidden")) {
        event.preventDefault();
        binSearchInput.focus();
      }
    });
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
    // Keep "time ago" labels fresh while the tab is visible in relative mode.
    setInterval(() => {
      if (uiTimezone === "rel" && !document.hidden) renderTimestamps(document);
    }, 30000);
  }

  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.textContent || "");
        showToast("Copied");
        flashCopied(button);
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
        .then(() => {
          showToast("Copied");
          flashCopied(copyTextBtn);
        })
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
    const deleteMsgBtn = event.target.closest("[data-delete-message]");
    if (deleteMsgBtn) {
      event.preventDefault();
      const msgId = Number(deleteMsgBtn.dataset.deleteMessage);
      deleteMessage(msgId)
        .then(() => {
          applyMessageDeleted(msgId);
          showToast(`Deleted message #${msgId}`);
        })
        .catch((error) => showToast(error.message, "error"));
      return;
    }
    const copyBodyBtn = event.target.closest("[data-copy-body]");
    if (copyBodyBtn && currentMessage) {
      event.preventDefault();
      navigator.clipboard.writeText(formattedBodyText(currentMessage))
        .then(() => {
          showToast("Body copied");
          flashCopied(copyBodyBtn, "Copied");
        })
        .catch(() => showToast("Copy failed", "error"));
      return;
    }
    const copyHeadersBtn = event.target.closest("[data-copy-headers]");
    if (copyHeadersBtn && currentMessage) {
      event.preventDefault();
      navigator.clipboard.writeText(JSON.stringify(currentMessage.headers || {}, null, 2))
        .then(() => {
          showToast("Headers copied");
          flashCopied(copyHeadersBtn, "Copied");
        })
        .catch(() => showToast("Copy failed", "error"));
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
        .then(() => {
          showToast("cURL copied");
          flashCopied(curlButton, "cURL copied");
        })
        .catch((error) => showToast(error.message, "error"));
    }
  });
});
