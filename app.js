(() => {
  "use strict";

  const socket = io();

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const state = {
    username: "",
    room: "",
    topic: "",
    pendingJoin: null,
    joinInFlight: false,
    pendingImage: null,
    replyTo: null, // { id, username, message }
    editingId: null,
    messages: new Map(), // id -> record (current room only, cleared on room switch)
    deliveredMessageIds: new Set(),
    seenMessageIds: new Set(),
    isTyping: false,
    typingTimerId: null,
    typingUsers: new Map(),
    rooms: new Map(), // name -> { name, topic, online }
    pins: [],
    saved: loadSaved(),
    notifications: [],
    mentionQuery: null, // { start, end } while typing @mention
    roomUsersCache: []
  };

  const EMOJI_SET = [
    "😀", "😂", "😍", "🤔", "😎", "😢", "😮", "🙌",
    "👍", "👎", "❤️", "🔥", "🎉", "🚀", "👀", "🙏",
    "😅", "😴", "🥳", "💯", "✅", "❌", "⭐", "🤝"
  ];
  const REACTION_QUICK_SET = ["👍", "❤️", "😂", "🎉", "😮", "🙌"];
  const SLASH_COMMANDS = [
    { cmd: "/help", desc: "List available commands" },
    { cmd: "/clear", desc: "Clear this room's view locally" },
    { cmd: "/shrug", desc: "Append ¯\\_(ツ)_/¯ to your message" }
  ];

  // -------------------------------------------------------------------------
  // Element refs
  // -------------------------------------------------------------------------
  const el = {
    appShell: document.getElementById("appShell"),
    sidebar: document.getElementById("sidebar"),
    sidebarScrim: document.getElementById("sidebarScrim"),
    openSidebarButton: document.getElementById("openSidebarButton"),
    closeSidebarButton: document.getElementById("closeSidebarButton"),
    roomSearchInput: document.getElementById("roomSearchInput"),
    roomList: document.getElementById("roomList"),
    newRoomButton: document.getElementById("newRoomButton"),
    newRoomOverlay: document.getElementById("newRoomOverlay"),
    newRoomForm: document.getElementById("newRoomForm"),
    newRoomName: document.getElementById("newRoomName"),
    newRoomTopic: document.getElementById("newRoomTopic"),
    cancelNewRoomButton: document.getElementById("cancelNewRoomButton"),
    openSavedButton: document.getElementById("openSavedButton"),
    openPinnedButton: document.getElementById("openPinnedButton"),
    savedCount: document.getElementById("savedCount"),
    pinnedCount: document.getElementById("pinnedCount"),
    themeSelect: document.getElementById("themeSelect"),
    meAvatar: document.getElementById("meAvatar"),
    currentUser: document.getElementById("currentUser"),

    currentRoom: document.getElementById("currentRoom"),
    roomTopic: document.getElementById("roomTopic"),
    connectionStatus: document.getElementById("connectionStatus"),
    onlineCount: document.getElementById("onlineCount"),
    searchToggleButton: document.getElementById("searchToggleButton"),
    notifButton: document.getElementById("notifButton"),
    notifBadge: document.getElementById("notifBadge"),
    notifPanel: document.getElementById("notifPanel"),
    notifList: document.getElementById("notifList"),
    clearNotifsButton: document.getElementById("clearNotifsButton"),
    openMembersButton: document.getElementById("openMembersButton"),

    searchBar: document.getElementById("searchBar"),
    searchInput: document.getElementById("searchInput"),
    searchResultCount: document.getElementById("searchResultCount"),
    searchCloseButton: document.getElementById("searchCloseButton"),

    pinnedStrip: document.getElementById("pinnedStrip"),
    pinnedStripText: document.getElementById("pinnedStripText"),
    pinnedStripNext: document.getElementById("pinnedStripNext"),

    messages: document.getElementById("messages"),
    jumpToLatest: document.getElementById("jumpToLatest"),
    typingIndicator: document.getElementById("typingIndicator"),

    replyPreview: document.getElementById("replyPreview"),
    replyPreviewName: document.getElementById("replyPreviewName"),
    replyPreviewText: document.getElementById("replyPreviewText"),
    cancelReplyButton: document.getElementById("cancelReplyButton"),

    editBanner: document.getElementById("editBanner"),
    cancelEditButton: document.getElementById("cancelEditButton"),

    imageInput: document.getElementById("imageInput"),
    imagePreview: document.getElementById("imagePreview"),
    imagePreviewThumb: document.getElementById("imagePreviewThumb"),
    imagePreviewName: document.getElementById("imagePreviewName"),
    clearImageButton: document.getElementById("clearImageButton"),

    emojiButton: document.getElementById("emojiButton"),
    emojiPicker: document.getElementById("emojiPicker"),
    mentionMenu: document.getElementById("mentionMenu"),

    messageForm: document.getElementById("messageForm"),
    messageInput: document.getElementById("messageInput"),
    sendButton: document.getElementById("sendButton"),

    rightPanel: document.getElementById("rightPanel"),
    closeRightPanelButton: document.getElementById("closeRightPanelButton"),
    membersPanel: document.getElementById("membersPanel"),
    pinnedPanel: document.getElementById("pinnedPanel"),
    savedPanel: document.getElementById("savedPanel"),
    membersCount: document.getElementById("membersCount"),
    membersList: document.getElementById("membersList"),
    pinnedList: document.getElementById("pinnedList"),
    savedList: document.getElementById("savedList"),

    usernameOverlay: document.getElementById("usernameOverlay"),
    joinForm: document.getElementById("joinForm"),
    usernameInput: document.getElementById("usernameInput"),
    roomInput: document.getElementById("roomInput"),
    joinError: document.getElementById("joinError"),
    joinButton: document.querySelector("#joinForm button[type='submit']"),

    toastStack: document.getElementById("toastStack")
  };

  const rightPanelTabs = Array.from(document.querySelectorAll(".right-panel__tab"));
  const themeStorageKey = "pulsechat-theme";
  const savedStorageKey = "pulsechat-saved";
  const supportedThemes = new Set(["aurora", "midnight", "sunset", "forest", "minimal"]);

  const seenObserver =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(handleSeenEntries, { root: el.messages, threshold: 0.7 })
      : null;

  // -------------------------------------------------------------------------
  // Utility helpers
  // -------------------------------------------------------------------------
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatTime(timestamp) {
    return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
  }

  function formatDateLabel(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    const isSameDay = (a, b) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

    if (isSameDay(date, today)) return "Today";
    if (isSameDay(date, yesterday)) return "Yesterday";

    return new Intl.DateTimeFormat([], { month: "short", day: "numeric", year: "numeric" }).format(date);
  }

  function initials(name) {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] || "";
    const second = parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] || "";
    return (first + second).toUpperCase();
  }

  function avatarColorSeed(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) {
      hash = (hash << 5) - hash + name.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function shouldStickToBottom() {
    const { scrollTop, scrollHeight, clientHeight } = el.messages;
    return scrollHeight - scrollTop - clientHeight < 96;
  }

  function scrollToBottom(smooth) {
    el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    el.jumpToLatest.classList.add("is-hidden");
  }

  function loadSaved() {
    try {
      const raw = localStorage.getItem("pulsechat-saved");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function persistSaved() {
    try {
      localStorage.setItem(savedStorageKey, JSON.stringify(state.saved));
    } catch (error) {
      // Storage may be unavailable (private browsing); fail silently.
    }
  }

  function showToast(title, body) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<strong>${escapeHtml(title)}</strong><div>${escapeHtml(body || "")}</div>`;
    el.toastStack.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  function linkify(text) {
    const urlPattern = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g;
    return text.replace(urlPattern, (match) => `<a href="${match}" target="_blank" rel="noopener noreferrer">${match}</a>`);
  }

  function renderMessageBody(text, mentions) {
    let safe = escapeHtml(text);
    safe = linkify(safe);

    if (mentions && mentions.length) {
      for (const name of mentions) {
        const pattern = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
        safe = safe.replace(pattern, (match) => `<span class="mention-chip">${match}</span>`);
      }
    }

    return safe;
  }

  // -------------------------------------------------------------------------
  // Theme
  // -------------------------------------------------------------------------
  function applyTheme(theme) {
    const safeTheme = supportedThemes.has(theme) ? theme : "aurora";
    document.body.className = `theme-${safeTheme}`;
    el.themeSelect.value = safeTheme;
    localStorage.setItem(themeStorageKey, safeTheme);
  }

  function loadSavedTheme() {
    applyTheme(localStorage.getItem(themeStorageKey) || "aurora");
  }

  // -------------------------------------------------------------------------
  // Sidebar / room list
  // -------------------------------------------------------------------------
  function openSidebar() {
    el.sidebar.classList.add("is-open");
    el.sidebarScrim.hidden = false;
  }

  function closeSidebar() {
    el.sidebar.classList.remove("is-open");
    el.sidebarScrim.hidden = true;
  }

  function renderRoomList(filter = "") {
    const query = filter.trim().toLowerCase();
    const rooms = Array.from(state.rooms.values())
      .filter((room) => !query || room.name.includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));

    el.roomList.replaceChildren();

    for (const room of rooms) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `room-item${room.name === state.room ? " is-active" : ""}`;
      button.innerHTML = `<span class="room-item__hash">#</span><span>${escapeHtml(room.name)}</span><span class="room-item__online">${room.online}</span>`;
      button.addEventListener("click", () => {
        if (room.name !== state.room) {
          requestJoin(state.username, room.name);
        }
        closeSidebar();
      });
      li.appendChild(button);
      el.roomList.appendChild(li);
    }

    if (!rooms.length) {
      const empty = document.createElement("li");
      empty.className = "member-empty";
      empty.textContent = "No rooms match your search.";
      el.roomList.appendChild(empty);
    }
  }

  // -------------------------------------------------------------------------
  // Right panel
  // -------------------------------------------------------------------------
  function setRightPanelOpen(open) {
    el.rightPanel.hidden = !open;
    el.appShell.classList.toggle("has-right-panel", open);
  }

  function switchRightPanelTab(name) {
    for (const tab of rightPanelTabs) {
      tab.classList.toggle("is-active", tab.dataset.panel === name);
    }

    el.membersPanel.classList.toggle("is-hidden", name !== "members");
    el.pinnedPanel.classList.toggle("is-hidden", name !== "pinned");
    el.savedPanel.classList.toggle("is-hidden", name !== "saved");
    setRightPanelOpen(true);
  }

  function renderMembers(users) {
    el.membersCount.textContent = `${users.length} ${users.length === 1 ? "user" : "users"}`;
    el.membersList.replaceChildren();

    if (!users.length) {
      const li = document.createElement("li");
      li.className = "member-empty";
      li.textContent = "Join a room to see who is here.";
      el.membersList.appendChild(li);
      return;
    }

    for (const username of users) {
      const li = document.createElement("li");
      li.className = "member-item";
      li.innerHTML = `<span class="member-item__dot"></span><span>${escapeHtml(username)}</span>`;
      el.membersList.appendChild(li);
    }
  }

  function renderPinnedPanel() {
    el.pinnedCount.textContent = String(state.pins.length);
    el.pinnedList.replaceChildren();

    if (!state.pins.length) {
      const li = document.createElement("li");
      li.className = "panel-empty";
      li.textContent = "No pinned messages yet. Pin an important message to see it here.";
      el.pinnedList.appendChild(li);
      updatePinnedStrip();
      return;
    }

    for (const record of state.pins) {
      const li = document.createElement("li");
      li.className = "panel-message";
      li.innerHTML = `
        <div class="panel-message__meta"><span>${escapeHtml(record.username)}</span><span>${formatTime(record.timestamp)}</span></div>
        <div class="panel-message__text">${escapeHtml(record.message || "Image")}</div>
      `;
      li.addEventListener("click", () => scrollToMessage(record.id));
      el.pinnedList.appendChild(li);
    }

    updatePinnedStrip();
  }

  function updatePinnedStrip() {
    if (!state.pins.length) {
      el.pinnedStrip.classList.add("is-hidden");
      return;
    }

    const latest = state.pins[state.pins.length - 1];
    el.pinnedStripText.textContent = `${latest.username}: ${latest.message || "Shared an image"}`;
    el.pinnedStrip.classList.remove("is-hidden");
  }

  function renderSavedPanel() {
    el.savedCount.textContent = String(state.saved.length);
    el.savedList.replaceChildren();

    if (!state.saved.length) {
      const li = document.createElement("li");
      li.className = "panel-empty";
      li.textContent = "Nothing saved yet. Use the 🔖 action on any message to save it.";
      el.savedList.appendChild(li);
      return;
    }

    for (const item of state.saved.slice().reverse()) {
      const li = document.createElement("li");
      li.className = "panel-message";
      li.innerHTML = `
        <div class="panel-message__meta"><span>${escapeHtml(item.username)} · #${escapeHtml(item.room)}</span><span>${formatTime(item.timestamp)}</span></div>
        <div class="panel-message__text">${escapeHtml(item.message || "Image")}</div>
      `;
      li.addEventListener("click", () => {
        if (item.room === state.room) {
          scrollToMessage(item.id);
        } else {
          showToast("Saved in another room", `This message is in #${item.room}. Switch rooms to view it.`);
        }
      });
      el.savedList.appendChild(li);
    }
  }

  function toggleSaveMessage(record) {
    const index = state.saved.findIndex((item) => item.id === record.id);

    if (index >= 0) {
      state.saved.splice(index, 1);
      showToast("Removed", "Message removed from saved.");
    } else {
      state.saved.push({
        id: record.id,
        room: record.room,
        username: record.username,
        message: record.message,
        timestamp: record.timestamp
      });
      showToast("Saved", "Message added to your saved list.");
    }

    persistSaved();
    renderSavedPanel();
    updateSaveButtons(record.id);
  }

  function isSaved(id) {
    return state.saved.some((item) => item.id === id);
  }

  function updateSaveButtons(id) {
    const button = el.messages.querySelector(`[data-message-id="${cssEscape(id)}"] [data-action="save"]`);
    if (button) {
      button.classList.toggle("is-active", isSaved(id));
      button.title = isSaved(id) ? "Remove from saved" : "Save message";
    }
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------
  function pushNotification(kind, record) {
    state.notifications.unshift({
      id: `${record.id}-${kind}`,
      kind,
      messageId: record.id,
      username: record.username,
      preview: record.message || "Sent an image",
      timestamp: record.timestamp,
      read: false
    });
    state.notifications = state.notifications.slice(0, 30);
    renderNotifications();
    showToast(kind === "mention" ? `${record.username} mentioned you` : `Reply from ${record.username}`, record.message);
  }

  function renderNotifications() {
    const unread = state.notifications.filter((item) => !item.read).length;
    el.notifBadge.textContent = String(unread);
    el.notifBadge.classList.toggle("is-hidden", unread === 0);
    el.notifList.replaceChildren();

    if (!state.notifications.length) {
      const li = document.createElement("li");
      li.className = "notif-empty";
      li.textContent = "You're all caught up.";
      el.notifList.appendChild(li);
      return;
    }

    for (const item of state.notifications) {
      const li = document.createElement("li");
      li.className = "notif-item";
      li.innerHTML = `
        <span>${item.kind === "mention" ? "🔔" : "↩️"} <strong>${escapeHtml(item.username)}</strong> ${
        item.kind === "mention" ? "mentioned you" : "replied to you"
      }</span>
        <span>${escapeHtml((item.preview || "").slice(0, 80))}</span>
        <span class="notif-item__meta">${formatTime(item.timestamp)}</span>
      `;
      li.addEventListener("click", () => {
        item.read = true;
        renderNotifications();
        scrollToMessage(item.messageId);
        toggleNotifPanel(false);
      });
      el.notifList.appendChild(li);
    }
  }

  function toggleNotifPanel(forceState) {
    const shouldOpen = typeof forceState === "boolean" ? forceState : el.notifPanel.classList.contains("is-hidden");
    el.notifPanel.classList.toggle("is-hidden", !shouldOpen);

    if (shouldOpen) {
      for (const item of state.notifications) item.read = true;
      renderNotifications();
    }
  }

  // -------------------------------------------------------------------------
  // Message rendering
  // -------------------------------------------------------------------------
  function isOwnMessage(record) {
    return (record.senderId && record.senderId === socket.id) || (state.username && record.username === state.username);
  }

  function maybeInsertDateDivider(timestamp) {
    const label = formatDateLabel(timestamp);
    const lastDivider = el.messages.dataset.lastDateLabel;

    if (lastDivider !== label) {
      const divider = document.createElement("div");
      divider.className = "date-divider";
      divider.textContent = label;
      el.messages.appendChild(divider);
      el.messages.dataset.lastDateLabel = label;
    }
  }

  function buildReactionsHtml(record) {
    const entries = Object.entries(record.reactions || {});
    if (!entries.length) return "";

    return `<div class="message__reactions">${entries
      .map(([emoji, users]) => {
        const mine = users.includes(state.username);
        return `<button type="button" class="reaction-pill${mine ? " is-mine" : ""}" data-action="react" data-emoji="${escapeHtml(
          emoji
        )}" title="${escapeHtml(users.join(", "))}">${emoji} <span>${users.length}</span></button>`;
      })
      .join("")}</div>`;
  }

  function buildReplyHtml(record) {
    if (!record.replyTo) return "";
    return `
      <div class="reply-quote" data-action="jump-to-reply" data-target="${escapeHtml(record.replyTo.id)}">
        <span class="reply-quote__author">${escapeHtml(record.replyTo.username)}</span>
        <span class="reply-quote__text">${escapeHtml(record.replyTo.message)}</span>
      </div>
    `;
  }

  function buildActionsHtml(record, own) {
    const buttons = [];

    for (const emoji of REACTION_QUICK_SET.slice(0, 3)) {
      buttons.push(`<button type="button" data-action="quick-react" data-emoji="${emoji}" title="React ${emoji}">${emoji}</button>`);
    }

    buttons.push(`<button type="button" data-action="reply" title="Reply">↩️</button>`);
    buttons.push(
      `<button type="button" data-action="save" title="${isSaved(record.id) ? "Remove from saved" : "Save message"}" class="${
        isSaved(record.id) ? "is-active" : ""
      }">🔖</button>`
    );
    buttons.push(
      `<button type="button" data-action="pin" title="${record.pinned ? "Unpin" : "Pin"}">${record.pinned ? "📌" : "📍"}</button>`
    );

    if (own) {
      buttons.push(`<button type="button" data-action="edit" title="Edit">✏️</button>`);
      buttons.push(`<button type="button" data-action="delete" title="Delete">🗑️</button>`);
    }

    return `<div class="message__actions">${buttons.join("")}</div>`;
  }

  function renderMessageRow(record) {
    const own = isOwnMessage(record);
    const row = document.createElement("article");
    row.className = `message-row${own ? " is-own" : ""}`;
    row.dataset.messageId = record.id;
    row.dataset.username = record.username;

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.style.background = `linear-gradient(135deg, hsl(${avatarColorSeed(record.username) % 360} 70% 55%), hsl(${
      (avatarColorSeed(record.username) + 60) % 360
    } 70% 50%))`;
    avatar.textContent = initials(record.username);

    const col = document.createElement("div");
    col.className = "message-col";

    const meta = document.createElement("div");
    meta.className = "message__meta";
    meta.innerHTML = `
      <span class="message__author">${escapeHtml(record.username)}</span>
      <span class="message__time">${formatTime(record.timestamp)}</span>
      ${record.edited ? '<span class="message__edited">(edited)</span>' : ""}
      ${own ? `<span class="message__status message__status--sent" data-role="status">✔</span>` : ""}
    `;

    const bubble = document.createElement("div");
    bubble.className = `message__bubble${record.deleted ? " is-deleted" : ""}`;
    bubble.dataset.role = "bubble";

    if (record.deleted) {
      bubble.textContent = "This message was deleted.";
    } else {
      bubble.innerHTML =
        buildReplyHtml(record) +
        (record.message ? `<span data-role="text">${renderMessageBody(record.message, record.mentions)}</span>` : "") +
        (record.image && record.image.dataUrl
          ? `<img class="message__image" src="${record.image.dataUrl}" alt="${escapeHtml(record.image.name || "Shared image")}" loading="lazy" />`
          : "");
    }

    col.appendChild(meta);
    col.appendChild(bubble);

    if (!record.deleted) {
      const reactionsWrap = document.createElement("div");
      reactionsWrap.dataset.role = "reactions";
      reactionsWrap.innerHTML = buildReactionsHtml(record);
      col.appendChild(reactionsWrap);
    }

    row.appendChild(avatar);
    row.appendChild(col);

    if (!record.deleted) {
      const actionsHost = document.createElement("div");
      actionsHost.innerHTML = buildActionsHtml(record, own);
      row.appendChild(actionsHost.firstElementChild);
    }

    row.addEventListener("click", (event) => handleMessageRowClick(event, record.id));

    return row;
  }

  function appendChatMessage(record, options = {}) {
    state.messages.set(record.id, record);
    const shouldScroll = shouldStickToBottom();

    maybeInsertDateDivider(record.timestamp);
    const row = renderMessageRow(record);
    el.messages.appendChild(row);

    if (!isOwnMessage(record) && record.id && !options.skipDelivery) {
      emitMessageDelivered(record.id, record.room);
      if (seenObserver) seenObserver.observe(row);
      else emitMessageSeen(record.id, record.room);
    }

    if (!options.skipMentionCheck) {
      const mentionedMe =
        record.mentions && (record.mentions.includes(state.username) || record.mentions.includes("everyone"));
      const isReplyToMe = record.replyTo && record.replyTo.id && isRecordMine(record.replyTo.id);

      if (!isOwnMessage(record) && mentionedMe) pushNotification("mention", record);
      else if (!isOwnMessage(record) && isReplyToMe) pushNotification("reply", record);
    }

    if (shouldScroll) {
      scrollToBottom(!options.initialLoad);
    } else if (!options.initialLoad) {
      el.jumpToLatest.classList.remove("is-hidden");
    }
  }

  function isRecordMine(id) {
    const record = state.messages.get(id);
    return record ? isOwnMessage(record) : false;
  }

  function appendSystemMessage(text, timestamp = new Date().toISOString()) {
    const shouldScroll = shouldStickToBottom();
    const item = document.createElement("div");
    item.className = "system-message";
    item.textContent = `${text} · ${formatTime(timestamp)}`;
    el.messages.appendChild(item);
    if (shouldScroll) scrollToBottom();
  }

  function scrollToMessage(id) {
    const row = el.messages.querySelector(`[data-message-id="${cssEscape(id)}"]`);
    if (!row) {
      showToast("Message not found", "It may be from an older session or a different room.");
      return;
    }
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("is-highlight");
    setTimeout(() => row.classList.remove("is-highlight"), 1600);
  }

  function updateMessageStatus(id, nextStatus) {
    const order = { sent: 1, delivered: 2, seen: 3 };
    const row = el.messages.querySelector(`[data-message-id="${cssEscape(id)}"]`);
    if (!row) return;
    const statusEl = row.querySelector('[data-role="status"]');
    if (!statusEl) return;

    const current = statusEl.dataset.status || "sent";
    if (order[nextStatus] <= order[current]) return;

    statusEl.dataset.status = nextStatus;
    statusEl.className = `message__status message__status--${nextStatus}`;
    statusEl.textContent = nextStatus === "sent" ? "✔" : "✔✔";
    statusEl.title = nextStatus[0].toUpperCase() + nextStatus.slice(1);
  }

  function emitMessageDelivered(id, room) {
    if (!id || state.deliveredMessageIds.has(id)) return;
    state.deliveredMessageIds.add(id);
    socket.emit("message:delivered", { id, room });
  }

  function emitMessageSeen(id, room) {
    if (!id || state.seenMessageIds.has(id)) return;
    state.seenMessageIds.add(id);
    emitMessageDelivered(id, room);
    socket.emit("message:seen", { id, room });
  }

  function handleSeenEntries(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = entry.target.dataset.messageId;
      const record = state.messages.get(id);
      emitMessageSeen(id, record ? record.room : state.room);
      if (seenObserver) seenObserver.unobserve(entry.target);
    }
  }

  // -------------------------------------------------------------------------
  // Message row interactions (reactions, reply, edit, delete, pin, save)
  // -------------------------------------------------------------------------
  function handleMessageRowClick(event, id) {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    const record = state.messages.get(id);
    if (!record) return;

    const action = button.dataset.action;

    if (action === "quick-react" || action === "react") {
      sendReaction(record.id, button.dataset.emoji);
      return;
    }

    if (action === "reply") {
      setReplyTarget(record);
      return;
    }

    if (action === "save") {
      toggleSaveMessage(record);
      return;
    }

    if (action === "pin") {
      socket.emit("message:pin", { id: record.id, pinned: !record.pinned }, (response) => {
        if (!response || !response.ok) showToast("Couldn't pin", (response && response.error) || "Try again.");
      });
      return;
    }

    if (action === "edit") {
      startEditing(record);
      return;
    }

    if (action === "delete") {
      if (window.confirm("Delete this message for everyone?")) {
        socket.emit("message:delete", { id: record.id }, (response) => {
          if (!response || !response.ok) showToast("Couldn't delete", (response && response.error) || "Try again.");
        });
      }
      return;
    }

    if (action === "jump-to-reply") {
      scrollToMessage(button.dataset.target);
    }
  }

  function sendReaction(id, emoji) {
    socket.emit("message:react", { id, emoji }, (response) => {
      if (!response || !response.ok) showToast("Couldn't react", (response && response.error) || "Try again.");
    });
  }

  function setReplyTarget(record) {
    state.replyTo = { id: record.id, username: record.username, message: record.message || "Image" };
    el.replyPreviewName.textContent = record.username;
    el.replyPreviewText.textContent = record.message || "Shared an image";
    el.replyPreview.classList.remove("is-hidden");
    el.messageInput.focus();
  }

  function clearReplyTarget() {
    state.replyTo = null;
    el.replyPreview.classList.add("is-hidden");
  }

  function startEditing(record) {
    state.editingId = record.id;
    el.messageInput.value = record.message || "";
    autoGrowTextarea();
    el.editBanner.classList.remove("is-hidden");
    clearReplyTarget();
    el.messageInput.focus();
  }

  function cancelEditing() {
    state.editingId = null;
    el.editBanner.classList.add("is-hidden");
    el.messageInput.value = "";
    autoGrowTextarea();
  }

  // -------------------------------------------------------------------------
  // Typing indicator
  // -------------------------------------------------------------------------
  function renderTypingIndicator() {
    const users = Array.from(state.typingUsers.values());

    if (!users.length) {
      el.typingIndicator.textContent = "";
    } else if (users.length === 1) {
      el.typingIndicator.textContent = `${users[0]} is typing...`;
    } else if (users.length === 2) {
      el.typingIndicator.textContent = `${users[0]} and ${users[1]} are typing...`;
    } else {
      el.typingIndicator.textContent = `${users[0]} and ${users.length - 1} others are typing...`;
    }
  }

  function resetTypingUsers() {
    state.typingUsers.clear();
    renderTypingIndicator();
  }

  function stopTyping(shouldNotify = true) {
    if (state.typingTimerId) {
      clearTimeout(state.typingTimerId);
      state.typingTimerId = null;
    }
    if (!state.isTyping) return;
    state.isTyping = false;
    if (shouldNotify && state.username && state.room) {
      socket.emit("typing:stop", { username: state.username, room: state.room });
    }
  }

  function scheduleTypingStop() {
    if (state.typingTimerId) clearTimeout(state.typingTimerId);
    state.typingTimerId = window.setTimeout(() => stopTyping(true), 1500);
  }

  function startTyping() {
    if (!state.username || !state.room) return;
    if (!state.isTyping) {
      socket.emit("typing:start", { username: state.username, room: state.room });
      state.isTyping = true;
    }
    scheduleTypingStop();
  }

  // -------------------------------------------------------------------------
  // Composer: image, emoji picker, mentions, slash commands, autosize
  // -------------------------------------------------------------------------
  function setImagePreview(image) {
    state.pendingImage = image;

    if (!image) {
      el.imagePreview.classList.add("is-hidden");
      el.imagePreviewThumb.removeAttribute("src");
      el.imagePreviewName.textContent = "";
      el.imageInput.value = "";
      return;
    }

    el.imagePreview.classList.remove("is-hidden");
    el.imagePreviewThumb.src = image.dataUrl;
    el.imagePreviewName.textContent = image.name || "Selected image";
  }

  function autoGrowTextarea() {
    el.messageInput.style.height = "auto";
    el.messageInput.style.height = `${Math.min(el.messageInput.scrollHeight, 160)}px`;
  }

  function toggleEmojiPicker(forceState) {
    const shouldOpen = typeof forceState === "boolean" ? forceState : el.emojiPicker.classList.contains("is-hidden");
    el.emojiPicker.classList.toggle("is-hidden", !shouldOpen);
  }

  function buildEmojiPicker() {
    el.emojiPicker.replaceChildren();
    for (const emoji of EMOJI_SET) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = emoji;
      button.addEventListener("click", () => {
        insertAtCursor(el.messageInput, emoji);
        toggleEmojiPicker(false);
        el.messageInput.focus();
      });
      el.emojiPicker.appendChild(button);
    }
  }

  function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    const cursor = start + text.length;
    textarea.setSelectionRange(cursor, cursor);
    autoGrowTextarea();
  }

  function updateMentionMenu() {
    const value = el.messageInput.value;
    const cursor = el.messageInput.selectionStart;
    const uptoCursor = value.slice(0, cursor);
    const match = uptoCursor.match(/(^|\s)@([a-zA-Z0-9_.-]{0,24})$/);

    if (!match) {
      state.mentionQuery = null;
      el.mentionMenu.classList.add("is-hidden");
      return;
    }

    const query = match[2].toLowerCase();
    const candidates = ["everyone", ...state.roomUsersCache.filter((name) => name !== state.username)].filter((name) =>
      name.toLowerCase().startsWith(query)
    );

    if (!candidates.length) {
      el.mentionMenu.classList.add("is-hidden");
      return;
    }

    state.mentionQuery = { start: cursor - match[2].length - 1, end: cursor };
    el.mentionMenu.replaceChildren();

    for (const name of candidates.slice(0, 8)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mention-menu__item";
      button.textContent = `@${name}`;
      button.addEventListener("click", () => applyMention(name));
      el.mentionMenu.appendChild(button);
    }

    el.mentionMenu.classList.remove("is-hidden");
  }

  function applyMention(name) {
    if (!state.mentionQuery) return;
    const { start, end } = state.mentionQuery;
    const value = el.messageInput.value;
    el.messageInput.value = `${value.slice(0, start)}@${name} ${value.slice(end)}`;
    state.mentionQuery = null;
    el.mentionMenu.classList.add("is-hidden");
    el.messageInput.focus();
    autoGrowTextarea();
  }

  function handleSlashCommand(text) {
    const trimmed = text.trim();

    if (trimmed === "/help") {
      appendSystemMessage(`Commands: ${SLASH_COMMANDS.map((c) => c.cmd).join(", ")}`);
      return true;
    }

    if (trimmed === "/clear") {
      el.messages.replaceChildren();
      delete el.messages.dataset.lastDateLabel;
      appendSystemMessage("Cleared locally. Other members still see the full history.");
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------
  function toggleSearchBar(forceState) {
    const shouldOpen = typeof forceState === "boolean" ? forceState : el.searchBar.classList.contains("is-hidden");
    el.searchBar.classList.toggle("is-hidden", !shouldOpen);

    if (shouldOpen) {
      el.searchInput.value = "";
      el.searchInput.focus();
      runSearch("");
    } else {
      clearSearchHighlights();
    }
  }

  function clearSearchHighlights() {
    el.messages.querySelectorAll('[data-role="text"] mark').forEach((mark) => {
      mark.replaceWith(document.createTextNode(mark.textContent));
    });
    el.messages.querySelectorAll(".message-row").forEach((row) => row.classList.remove("is-hidden"));
  }

  function runSearch(rawQuery) {
    clearSearchHighlights();
    const query = rawQuery.trim().toLowerCase();

    if (!query) {
      el.searchResultCount.textContent = "";
      return;
    }

    let matches = 0;
    const rows = Array.from(el.messages.querySelectorAll(".message-row"));

    for (const row of rows) {
      const record = state.messages.get(row.dataset.messageId);
      const haystack = `${record ? record.message : ""} ${row.dataset.username}`.toLowerCase();
      const isMatch = haystack.includes(query);
      row.classList.toggle("is-hidden", !isMatch);

      if (isMatch) {
        matches += 1;
        const textEl = row.querySelector('[data-role="text"]');
        if (textEl && record && record.message) {
          const pattern = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
          textEl.innerHTML = renderMessageBody(record.message, record.mentions).replace(pattern, "<mark>$1</mark>");
        }
      }
    }

    el.searchResultCount.textContent = `${matches} match${matches === 1 ? "" : "es"}`;
  }

  // -------------------------------------------------------------------------
  // Join flow
  // -------------------------------------------------------------------------
  function setJoinPending(isPending) {
    el.usernameInput.disabled = isPending;
    el.roomInput.disabled = isPending;
    el.joinButton.disabled = isPending;
  }

  function setComposerEnabled(enabled) {
    el.imageInput.disabled = !enabled;
    el.messageInput.disabled = !enabled;
    el.sendButton.disabled = !enabled;
  }

  function setConnectionStatus(text, isLive) {
    el.connectionStatus.textContent = text;
    el.connectionStatus.classList.toggle("is-live", Boolean(isLive));
  }

  function setCurrentUser(username) {
    el.currentUser.textContent = username ? `@${username}` : "Guest";
    el.meAvatar.textContent = initials(username);
  }

  function setCurrentRoom(room, topic) {
    el.currentRoom.textContent = room ? `#${room}` : "#waiting";
    el.messageInput.placeholder = room ? `Message #${room} — use @ to mention, / for commands` : "Message...";
    if (typeof topic === "string") {
      el.roomTopic.textContent = topic || "No topic set for this room yet.";
    }
  }

  function resetRoomView() {
    el.messages.replaceChildren();
    delete el.messages.dataset.lastDateLabel;
    state.messages.clear();
    state.deliveredMessageIds.clear();
    state.seenMessageIds.clear();
    state.pins = [];
    renderPinnedPanel();
    resetTypingUsers();
    clearReplyTarget();
    cancelEditing();
  }

  function finishJoin(response) {
    stopTyping(false);
    state.pendingJoin = null;
    state.joinInFlight = false;
    state.username = response.username;
    state.room = response.room;
    state.topic = response.topic || "";

    el.joinError.textContent = "";
    setJoinPending(false);
    el.usernameOverlay.classList.add("is-hidden");
    setComposerEnabled(true);
    setCurrentUser(state.username);
    setCurrentRoom(state.room, state.topic);
    resetRoomView();

    for (const record of response.recentMessages || []) {
      appendChatMessage(record, { initialLoad: true, skipMentionCheck: true });
    }

    state.pins = response.pins || [];
    renderPinnedPanel();
    renderRoomList(el.roomSearchInput.value);
    scrollToBottom(false);
    el.messageInput.focus();
  }

  function sendPendingJoin() {
    if (!state.pendingJoin || state.joinInFlight) return;
    const { username, room } = state.pendingJoin;
    state.joinInFlight = true;
    setJoinPending(true);
    el.joinError.textContent = "";

    socket.emit("user:join", { username, room }, (response) => {
      state.joinInFlight = false;

      if (!response || !response.ok) {
        const message = (response && response.error) || "Unable to join the chat right now.";
        el.joinError.textContent = message;
        showToast("Couldn't join", message);
        setJoinPending(false);
        return;
      }

      finishJoin(response);
    });
  }

  function requestJoin(username, room) {
    state.pendingJoin = { username, room };
    if (!socket.connected) {
      el.joinError.textContent = "Connecting to server...";
      setJoinPending(true);
      return;
    }
    sendPendingJoin();
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------
  el.joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const username = el.usernameInput.value.trim();
    const room = el.roomInput.value.trim();

    if (!username) {
      el.joinError.textContent = "Username is required.";
      return;
    }
    if (!room) {
      el.joinError.textContent = "Room name is required.";
      return;
    }
    requestJoin(username, room);
  });

  el.messageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const raw = el.messageInput.value;
    const message = raw.trim();

    if (!message && !state.pendingImage) return;

    if (!state.editingId && handleSlashCommand(message)) {
      el.messageInput.value = "";
      autoGrowTextarea();
      return;
    }

    if (state.editingId) {
      socket.emit("message:edit", { id: state.editingId, message }, (response) => {
        if (!response || !response.ok) showToast("Couldn't edit", (response && response.error) || "Try again.");
      });
      cancelEditing();
      return;
    }

    stopTyping(true);
    const replyToId = state.replyTo ? state.replyTo.id : null;

    socket.emit("chat:message", { message, image: state.pendingImage, replyToId }, (response) => {
      if (!response || !response.ok) {
        appendSystemMessage((response && response.error) || "Message could not be delivered.");
        return;
      }
      setImagePreview(null);
      clearReplyTarget();
      el.messageInput.value = "";
      autoGrowTextarea();
      el.messageInput.focus();
    });
  });

  el.messageInput.addEventListener("input", () => {
    autoGrowTextarea();
    updateMentionMenu();

    if (!state.username || !state.room) return;

    if (!el.messageInput.value.trim()) {
      stopTyping(true);
      return;
    }
    startTyping();
  });

  el.messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && el.mentionMenu.classList.contains("is-hidden")) {
      event.preventDefault();
      el.messageForm.requestSubmit();
    } else if (event.key === "Escape") {
      if (state.editingId) cancelEditing();
      else if (state.replyTo) clearReplyTarget();
    } else if (event.key === "ArrowUp" && !el.messageInput.value && !state.editingId) {
      const mine = Array.from(state.messages.values())
        .filter((record) => isOwnMessage(record) && !record.deleted)
        .pop();
      if (mine) {
        event.preventDefault();
        startEditing(mine);
      }
    }
  });

  el.imageInput.addEventListener("change", () => {
    const [file] = el.imageInput.files || [];
    if (!file) {
      setImagePreview(null);
      return;
    }
    if (!file.type.startsWith("image/")) {
      showToast("Unsupported file", "Only image files can be shared.");
      setImagePreview(null);
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      setImagePreview({
        dataUrl: typeof reader.result === "string" ? reader.result : "",
        type: file.type,
        name: file.name
      });
    });
    reader.readAsDataURL(file);
  });

  el.clearImageButton.addEventListener("click", () => setImagePreview(null));
  el.cancelReplyButton.addEventListener("click", clearReplyTarget);
  el.cancelEditButton.addEventListener("click", cancelEditing);

  el.emojiButton.addEventListener("click", () => toggleEmojiPicker());
  document.addEventListener("click", (event) => {
    if (!el.emojiPicker.contains(event.target) && event.target !== el.emojiButton) {
      toggleEmojiPicker(false);
    }
    if (!el.notifPanel.contains(event.target) && event.target !== el.notifButton) {
      toggleNotifPanel(false);
    }
    if (!el.mentionMenu.contains(event.target) && event.target !== el.messageInput) {
      el.mentionMenu.classList.add("is-hidden");
    }
  });

  el.themeSelect.addEventListener("change", (event) => applyTheme(event.target.value));

  el.openSidebarButton.addEventListener("click", openSidebar);
  el.closeSidebarButton.addEventListener("click", closeSidebar);
  el.sidebarScrim.addEventListener("click", closeSidebar);
  el.roomSearchInput.addEventListener("input", () => renderRoomList(el.roomSearchInput.value));

  el.newRoomButton.addEventListener("click", () => {
    el.newRoomOverlay.classList.remove("is-hidden");
    el.newRoomName.focus();
  });
  el.cancelNewRoomButton.addEventListener("click", () => el.newRoomOverlay.classList.add("is-hidden"));
  el.newRoomForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = el.newRoomName.value.trim();
    const topic = el.newRoomTopic.value.trim();
    if (!name) return;

    socket.emit("room:create", { name, topic }, (response) => {
      if (!response || !response.ok) {
        showToast("Couldn't create room", (response && response.error) || "Try a different name.");
        return;
      }
      el.newRoomOverlay.classList.add("is-hidden");
      el.newRoomForm.reset();
      requestJoin(state.username, response.room);
      closeSidebar();
    });
  });

  el.openSavedButton.addEventListener("click", () => {
    switchRightPanelTab("saved");
    closeSidebar();
  });
  el.openPinnedButton.addEventListener("click", () => {
    switchRightPanelTab("pinned");
    closeSidebar();
  });
  el.openMembersButton.addEventListener("click", () => switchRightPanelTab("members"));
  el.closeRightPanelButton.addEventListener("click", () => setRightPanelOpen(false));
  for (const tab of rightPanelTabs) {
    tab.addEventListener("click", () => switchRightPanelTab(tab.dataset.panel));
  }

  el.notifButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleNotifPanel();
  });
  el.clearNotifsButton.addEventListener("click", () => {
    state.notifications = [];
    renderNotifications();
  });

  el.searchToggleButton.addEventListener("click", () => toggleSearchBar());
  el.searchCloseButton.addEventListener("click", () => toggleSearchBar(false));
  el.searchInput.addEventListener("input", () => runSearch(el.searchInput.value));

  el.jumpToLatest.addEventListener("click", () => scrollToBottom(true));
  el.pinnedStrip.addEventListener("click", (event) => {
    if (event.target === el.pinnedStripNext) {
      event.stopPropagation();
      const currentIndex = state.pins.findIndex((p) => p.message === el.pinnedStripText.textContent.split(": ")[1]);
      const nextIndex = (currentIndex + 1) % state.pins.length;
      const next = state.pins[nextIndex];
      if (next) {
        el.pinnedStripText.textContent = `${next.username}: ${next.message || "Shared an image"}`;
        scrollToMessage(next.id);
      }
      return;
    }
    const latest = state.pins[state.pins.length - 1];
    if (latest) scrollToMessage(latest.id);
  });

  document.addEventListener("keydown", (event) => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const modKey = isMac ? event.metaKey : event.ctrlKey;

    if (modKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      toggleSearchBar(true);
    } else if (event.key === "Escape") {
      if (!el.searchBar.classList.contains("is-hidden")) toggleSearchBar(false);
    }
  });

  el.messages.addEventListener("scroll", () => {
    if (shouldStickToBottom()) el.jumpToLatest.classList.add("is-hidden");
  });

  // -------------------------------------------------------------------------
  // Socket events
  // -------------------------------------------------------------------------
  socket.on("connect", () => {
    setConnectionStatus("Connected", true);
    if (state.pendingJoin) sendPendingJoin();
    else if (state.username && state.room) requestJoin(state.username, state.room);
  });

  socket.on("disconnect", () => {
    setConnectionStatus("Reconnecting...", false);
    state.joinInFlight = false;
    setJoinPending(Boolean(state.pendingJoin));
    setComposerEnabled(false);
    stopTyping(false);
    resetTypingUsers();
    if (state.username) appendSystemMessage("Connection lost. Trying to reconnect...");
  });

  socket.on("room:list", ({ rooms = [] }) => {
    state.rooms = new Map(rooms.map((room) => [room.name, room]));
    renderRoomList(el.roomSearchInput.value);
  });

  socket.on("presence:update", ({ count, room, users = [] }) => {
    el.onlineCount.textContent = `${count} online`;
    state.roomUsersCache = users;
    renderMembers(users);
    if (room) setCurrentRoom(room, state.topic);
  });

  socket.on("typing:update", ({ socketId, username, room, isTyping }) => {
    if (!room || room !== state.room || !socketId || !username) return;
    if (isTyping) state.typingUsers.set(socketId, username);
    else state.typingUsers.delete(socketId);
    renderTypingIndicator();
  });

  socket.on("chat:system", ({ message, timestamp }) => appendSystemMessage(message, timestamp));

  socket.on("chat:message", (payload) => {
    if (payload.room !== state.room) return;
    appendChatMessage(payload);
  });

  socket.on("message:edit", ({ id, room, message, mentions, edited }) => {
    if (room !== state.room) return;
    const record = state.messages.get(id);
    if (!record) return;
    record.message = message;
    record.mentions = mentions;
    record.edited = edited;

    const row = el.messages.querySelector(`[data-message-id="${cssEscape(id)}"]`);
    if (row) {
      const textEl = row.querySelector('[data-role="text"]');
      if (textEl) textEl.innerHTML = renderMessageBody(message, mentions);
      const metaEl = row.querySelector(".message__meta");
      if (metaEl && !metaEl.querySelector(".message__edited")) {
        const span = document.createElement("span");
        span.className = "message__edited";
        span.textContent = "(edited)";
        metaEl.insertBefore(span, metaEl.children[2] || null);
      }
    }
  });

  socket.on("message:delete", ({ id, room }) => {
    if (room !== state.room) return;
    const record = state.messages.get(id);
    if (record) {
      record.deleted = true;
      record.message = "";
      record.image = null;
    }
    const row = el.messages.querySelector(`[data-message-id="${cssEscape(id)}"]`);
    if (row) {
      const bubble = row.querySelector('[data-role="bubble"]');
      if (bubble) {
        bubble.className = "message__bubble is-deleted";
        bubble.textContent = "This message was deleted.";
      }
      const actions = row.querySelector(".message__actions");
      if (actions) actions.remove();
      const reactions = row.querySelector('[data-role="reactions"]');
      if (reactions) reactions.replaceChildren();
    }
  });

  socket.on("message:reactions", ({ id, room, reactions }) => {
    if (room !== state.room) return;
    const record = state.messages.get(id);
    if (record) record.reactions = reactions;
    const row = el.messages.querySelector(`[data-message-id="${cssEscape(id)}"]`);
    if (row) {
      const wrap = row.querySelector('[data-role="reactions"]');
      if (wrap) wrap.innerHTML = buildReactionsHtml({ reactions });
    }
  });

  socket.on("message:pin", ({ id, room, pinned }) => {
    if (room !== state.room) return;
    const record = state.messages.get(id);
    if (record) record.pinned = pinned;
    const row = el.messages.querySelector(`[data-message-id="${cssEscape(id)}"]`);
    if (row) {
      const pinButton = row.querySelector('[data-action="pin"]');
      if (pinButton) {
        pinButton.textContent = pinned ? "📌" : "📍";
        pinButton.title = pinned ? "Unpin" : "Pin";
      }
    }
  });

  socket.on("room:pins", ({ room, pins }) => {
    if (room !== state.room) return;
    state.pins = pins;
    renderPinnedPanel();
  });

  socket.on("message:delivered", ({ id, room }) => {
    if (room && room !== state.room) return;
    updateMessageStatus(id, "delivered");
  });

  socket.on("message:seen", ({ id, room }) => {
    if (room && room !== state.room) return;
    updateMessageStatus(id, "seen");
  });

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  buildEmojiPicker();
  loadSavedTheme();
  setConnectionStatus("Connecting...", false);
  setJoinPending(false);
  setComposerEnabled(false);
  setImagePreview(null);
  setCurrentRoom("", "");
  renderMembers([]);
  renderPinnedPanel();
  renderSavedPanel();
  renderNotifications();
  setCurrentUser("");
  appendSystemMessage("Welcome to PulseChat. Enter a username to start chatting.");
})();