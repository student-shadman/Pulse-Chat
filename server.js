const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);


const publicDir = __dirname;
const port = process.env.PORT || 3000;
const defaultRoom = "general";

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
// activeUsers: socketId -> { username, room }
const activeUsers = new Map();
// roomUsers: room -> Map<socketId, username>
const roomUsers = new Map();
// roomTypingUsers: room -> Map<socketId, username>
const roomTypingUsers = new Map();
// roomMessages: room -> Map<messageId, messageRecord>
const roomMessages = new Map();
// roomPins: room -> Map<messageId, true>   (ordered by insertion)
const roomPins = new Map();
// knownRooms: room -> { name, createdAt }
const knownRooms = new Map();

const DEFAULT_ROOMS = [
  { name: "general", topic: "Say hello and talk about anything." },
  { name: "tech-talk", topic: "Frameworks, tools, and shipping software." },
  { name: "design", topic: "UI, UX, and everything visual." },
  { name: "random", topic: "Off-topic chatter and fun." }
];

for (const room of DEFAULT_ROOMS) {
  knownRooms.set(room.name, { name: room.name, topic: room.topic, createdAt: Date.now() });
}

const MAX_ROOM_MESSAGES = 500;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_MESSAGES = 20;
// socketId -> array of timestamps
const rateLimitLog = new Map();

app.use(express.static(publicDir));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    usersOnline: activeUsers.size,
    rooms: knownRooms.size
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sanitizeText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeRoomName(value) {
  const cleaned = sanitizeText(value, 32)
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned || defaultRoom;
}

function sanitizeImagePayload(image) {
  if (!image || typeof image !== "object") {
    return null;
  }

  const dataUrl = typeof image.dataUrl === "string" ? image.dataUrl.trim() : "";
  const type = typeof image.type === "string" ? image.type.trim() : "";
  const name = sanitizeText(image.name, 120);

  if (!dataUrl || !dataUrl.startsWith("data:image/") || dataUrl.length > 8_000_000) {
    return null;
  }

  if (!type.startsWith("image/")) {
    return null;
  }

  return { dataUrl, type, name };
}

function normalizeJoinPayload(payload) {
  if (typeof payload === "string") {
    return { username: payload, room: defaultRoom };
  }

  return {
    username: payload && payload.username,
    room: payload && payload.room
  };
}

function getAck(callback) {
  return typeof callback === "function" ? callback : () => {};
}

function getOrCreateRoomStore(store, room) {
  if (!store.has(room)) {
    store.set(room, new Map());
  }

  return store.get(room);
}

function addRoomUser(room, socketId, username) {
  getOrCreateRoomStore(roomUsers, room).set(socketId, username);
}

function removeRoomUser(room, socketId) {
  const users = roomUsers.get(room);

  if (!users) {
    return "";
  }

  const username = users.get(socketId) || "";
  users.delete(socketId);

  if (users.size === 0) {
    roomUsers.delete(room);
  }

  return username;
}

function getRoomUsers(room) {
  return Array.from((roomUsers.get(room) || new Map()).values()).sort((left, right) =>
    left.localeCompare(right)
  );
}

function addTypingUser(room, socketId, username) {
  getOrCreateRoomStore(roomTypingUsers, room).set(socketId, username);
}

function removeTypingUser(room, socketId) {
  const users = roomTypingUsers.get(room);

  if (!users) {
    return "";
  }

  const username = users.get(socketId) || "";
  users.delete(socketId);

  if (users.size === 0) {
    roomTypingUsers.delete(room);
  }

  return username;
}

function getMessageRecord(room, messageId) {
  const messages = roomMessages.get(room);
  return messages ? messages.get(messageId) : null;
}

function serializeReactions(record) {
  const output = {};

  for (const [emoji, usernames] of record.reactions.entries()) {
    if (usernames.size > 0) {
      output[emoji] = Array.from(usernames);
    }
  }

  return output;
}

function serializeMessage(record) {
  return {
    id: record.id,
    room: record.room,
    username: record.username,
    senderId: record.senderId,
    message: record.deleted ? "" : record.message,
    image: record.deleted ? null : record.image,
    timestamp: record.timestamp,
    edited: record.edited,
    deleted: record.deleted,
    pinned: record.pinned,
    mentions: record.mentions,
    replyTo: record.replyTo,
    reactions: serializeReactions(record)
  };
}

function broadcastPresence(room) {
  const users = getRoomUsers(room);

  io.to(room).emit("presence:update", {
    count: users.length,
    room,
    users
  });
}

function broadcastRoomList() {
  const rooms = Array.from(knownRooms.values())
    .map((room) => ({
      name: room.name,
      topic: room.topic || "",
      online: (roomUsers.get(room.name) || new Map()).size
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  io.emit("room:list", { rooms });
}

function broadcastPins(room) {
  const pinIds = Array.from((roomPins.get(room) || new Map()).keys());
  const messages = roomMessages.get(room) || new Map();
  const pins = pinIds
    .map((id) => messages.get(id))
    .filter(Boolean)
    .map((record) => serializeMessage(record));

  io.to(room).emit("room:pins", { room, pins });
}

function systemMessage(message) {
  return { message, timestamp: new Date().toISOString() };
}

function ensureRoomKnown(room, topic) {
  if (!knownRooms.has(room)) {
    knownRooms.set(room, { name: room, topic: topic || "No topic set yet.", createdAt: Date.now() });
    broadcastRoomList();
  }
}

function extractMentions(text, room) {
  if (!text) {
    return [];
  }

  const roomUsernames = new Set(getRoomUsers(room));
  const matches = text.match(/@([a-zA-Z0-9_.-]{1,24})/g) || [];
  const mentioned = new Set();

  for (const raw of matches) {
    const candidate = raw.slice(1);

    if (candidate.toLowerCase() === "everyone") {
      mentioned.add("everyone");
      continue;
    }

    for (const username of roomUsernames) {
      if (username.toLowerCase() === candidate.toLowerCase()) {
        mentioned.add(username);
      }
    }
  }

  return Array.from(mentioned);
}

function isRateLimited(socketId) {
  const now = Date.now();
  const log = rateLimitLog.get(socketId) || [];
  const recent = log.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  rateLimitLog.set(socketId, recent);
  return recent.length > RATE_LIMIT_MAX_MESSAGES;
}

function trimRoomMessages(room) {
  const messages = roomMessages.get(room);

  if (!messages || messages.size <= MAX_ROOM_MESSAGES) {
    return;
  }

  const oldestId = messages.keys().next().value;
  messages.delete(oldestId);
  const pins = roomPins.get(room);

  if (pins) {
    pins.delete(oldestId);
  }
}

// ---------------------------------------------------------------------------
// Socket handling
// ---------------------------------------------------------------------------
io.on("connection", (socket) => {
  socket.emit("room:list", {
    rooms: Array.from(knownRooms.values())
      .map((room) => ({
        name: room.name,
        topic: room.topic || "",
        online: (roomUsers.get(room.name) || new Map()).size
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  });

  socket.on("user:join", (payload, callback) => {
    const ack = getAck(callback);

    try {
      const { username: rawUsername, room: rawRoom } = normalizeJoinPayload(payload);
      const username = sanitizeText(rawUsername, 24);
      const room = sanitizeRoomName(rawRoom);

      if (!username) {
        ack({ ok: false, error: "Please enter a username to join the chat." });
        return;
      }

      const usernameTaken = Array.from((roomUsers.get(room) || new Map()).entries()).some(
        ([id, existing]) => id !== socket.id && existing.toLowerCase() === username.toLowerCase()
      );

      if (usernameTaken) {
        ack({ ok: false, error: "That username is already taken in this room." });
        return;
      }

      ensureRoomKnown(room);

      const previousSession = activeUsers.get(socket.id);

      if (previousSession && previousSession.room !== room) {
        const stoppedTypingUser = removeTypingUser(previousSession.room, socket.id);
        removeRoomUser(previousSession.room, socket.id);
        socket.leave(previousSession.room);

        if (stoppedTypingUser) {
          io.to(previousSession.room).emit("typing:update", {
            socketId: socket.id,
            username: stoppedTypingUser,
            room: previousSession.room,
            isTyping: false
          });
        }

        io.to(previousSession.room).emit(
          "chat:system",
          systemMessage(`${previousSession.username} left room #${previousSession.room}.`)
        );
        broadcastPresence(previousSession.room);
      }

      if (previousSession && previousSession.room === room && previousSession.username !== username) {
        const stoppedTypingUser = removeTypingUser(room, socket.id);

        if (stoppedTypingUser) {
          io.to(room).emit("typing:update", {
            socketId: socket.id,
            username: stoppedTypingUser,
            room,
            isTyping: false
          });
        }
      }

      socket.join(room);
      activeUsers.set(socket.id, { username, room });
      addRoomUser(room, socket.id, username);

      if (!previousSession || previousSession.username !== username || previousSession.room !== room) {
        io.to(room).emit("chat:system", systemMessage(`${username} joined room #${room}.`));
      }

      broadcastPresence(room);
      broadcastRoomList();

      const roomInfo = knownRooms.get(room);
      const recentMessages = Array.from((roomMessages.get(room) || new Map()).values())
        .slice(-50)
        .map(serializeMessage);
      const pins = Array.from((roomPins.get(room) || new Map()).keys())
        .map((id) => getMessageRecord(room, id))
        .filter(Boolean)
        .map(serializeMessage);

      ack({
        ok: true,
        username,
        room,
        topic: roomInfo ? roomInfo.topic : "",
        recentMessages,
        pins
      });
    } catch (error) {
      console.error("Join failed:", error);
      ack({ ok: false, error: "Unable to join the chat right now." });
    }
  });

  socket.on("room:create", (payload, callback) => {
    const ack = getAck(callback);
    const session = activeUsers.get(socket.id);

    if (!session) {
      ack({ ok: false, error: "Join the chat before creating a room." });
      return;
    }

    const room = sanitizeRoomName(payload && payload.name);
    const topic = sanitizeText(payload && payload.topic, 120);

    if (!room) {
      ack({ ok: false, error: "Please provide a valid room name." });
      return;
    }

    ensureRoomKnown(room, topic || undefined);
    ack({ ok: true, room });
  });

  socket.on("chat:message", (payload, callback) => {
    const ack = getAck(callback);
    const session = activeUsers.get(socket.id);

    if (!session) {
      ack({ ok: false, error: "Join the chat before sending a message." });
      return;
    }

    if (isRateLimited(socket.id)) {
      ack({ ok: false, error: "You are sending messages too quickly. Slow down a little." });
      return;
    }

    const rawMessage = typeof payload === "string" ? payload : payload && payload.message;
    const message = sanitizeText(rawMessage, 1000);
    const image = sanitizeImagePayload(payload && payload.image);
    const replyToId = payload && payload.replyToId ? sanitizeText(payload.replyToId, 64) : null;

    if (!message && !image) {
      ack({ ok: false, error: "Message or image is required." });
      return;
    }

    let replyTo = null;
    if (replyToId) {
      const original = getMessageRecord(session.room, replyToId);
      if (original) {
        replyTo = {
          id: original.id,
          username: original.username,
          message: original.deleted ? "This message was deleted." : original.message.slice(0, 120)
        };
      }
    }

    const id = `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const mentions = extractMentions(message, session.room);

    const record = {
      id,
      room: session.room,
      senderId: socket.id,
      username: session.username,
      message,
      image,
      timestamp: new Date().toISOString(),
      edited: false,
      deleted: false,
      pinned: false,
      mentions,
      replyTo,
      reactions: new Map(),
      deliveredBy: new Set(),
      seenBy: new Set()
    };

    getOrCreateRoomStore(roomMessages, session.room).set(id, record);
    trimRoomMessages(session.room);

    io.to(session.room).emit("chat:message", serializeMessage(record));
    ack({ ok: true, id });
  });

  socket.on("message:edit", (payload, callback) => {
    const ack = getAck(callback);
    const session = activeUsers.get(socket.id);

    if (!session) {
      ack({ ok: false, error: "Join the chat first." });
      return;
    }

    const id = payload && payload.id;
    const nextMessage = sanitizeText(payload && payload.message, 1000);
    const record = getMessageRecord(session.room, id);

    if (!record || record.senderId !== socket.id || record.deleted) {
      ack({ ok: false, error: "You can only edit your own messages." });
      return;
    }

    if (!nextMessage) {
      ack({ ok: false, error: "Edited message cannot be empty." });
      return;
    }

    record.message = nextMessage;
    record.edited = true;
    record.mentions = extractMentions(nextMessage, session.room);

    io.to(session.room).emit("message:edit", {
      id: record.id,
      room: session.room,
      message: record.message,
      mentions: record.mentions,
      edited: true
    });

    ack({ ok: true });
  });

  socket.on("message:delete", (payload, callback) => {
    const ack = getAck(callback);
    const session = activeUsers.get(socket.id);

    if (!session) {
      ack({ ok: false, error: "Join the chat first." });
      return;
    }

    const id = payload && payload.id;
    const record = getMessageRecord(session.room, id);

    if (!record || record.senderId !== socket.id) {
      ack({ ok: false, error: "You can only delete your own messages." });
      return;
    }

    record.deleted = true;
    record.message = "";
    record.image = null;

    const pins = roomPins.get(session.room);
    if (pins && pins.has(id)) {
      pins.delete(id);
      broadcastPins(session.room);
    }

    io.to(session.room).emit("message:delete", { id: record.id, room: session.room });
    ack({ ok: true });
  });

  socket.on("message:react", (payload, callback) => {
    const ack = getAck(callback);
    const session = activeUsers.get(socket.id);

    if (!session) {
      ack({ ok: false, error: "Join the chat first." });
      return;
    }

    const id = payload && payload.id;
    const emoji = sanitizeText(payload && payload.emoji, 8);
    const record = getMessageRecord(session.room, id);

    if (!record || record.deleted || !emoji) {
      ack({ ok: false, error: "Unable to react to that message." });
      return;
    }

    if (!record.reactions.has(emoji)) {
      record.reactions.set(emoji, new Set());
    }

    const reactors = record.reactions.get(emoji);

    if (reactors.has(session.username)) {
      reactors.delete(session.username);
    } else {
      reactors.add(session.username);
    }

    io.to(session.room).emit("message:reactions", {
      id: record.id,
      room: session.room,
      reactions: serializeReactions(record)
    });

    ack({ ok: true });
  });

  socket.on("message:pin", (payload, callback) => {
    const ack = getAck(callback);
    const session = activeUsers.get(socket.id);

    if (!session) {
      ack({ ok: false, error: "Join the chat first." });
      return;
    }

    const id = payload && payload.id;
    const shouldPin = Boolean(payload && payload.pinned);
    const record = getMessageRecord(session.room, id);

    if (!record || record.deleted) {
      ack({ ok: false, error: "Unable to pin that message." });
      return;
    }

    record.pinned = shouldPin;
    const pins = getOrCreateRoomStore(roomPins, session.room);

    if (shouldPin) {
      pins.set(id, true);
    } else {
      pins.delete(id);
    }

    io.to(session.room).emit("message:pin", { id: record.id, room: session.room, pinned: shouldPin });
    broadcastPins(session.room);
    ack({ ok: true });
  });

  socket.on("message:delivered", (payload) => {
    const session = activeUsers.get(socket.id);

    if (!session) {
      return;
    }

    const messageId = payload && payload.id;
    const room = sanitizeRoomName(payload && payload.room) || session.room;
    const record = getMessageRecord(room, messageId);

    if (
      !messageId ||
      !record ||
      record.room !== session.room ||
      record.senderId === socket.id ||
      record.deliveredBy.has(socket.id)
    ) {
      return;
    }

    record.deliveredBy.add(socket.id);
    io.to(record.room).emit("message:delivered", {
      id: messageId,
      room: record.room,
      username: session.username
    });
  });

  socket.on("message:seen", (payload) => {
    const session = activeUsers.get(socket.id);

    if (!session) {
      return;
    }

    const messageId = payload && payload.id;
    const room = sanitizeRoomName(payload && payload.room) || session.room;
    const record = getMessageRecord(room, messageId);

    if (
      !messageId ||
      !record ||
      record.room !== session.room ||
      record.senderId === socket.id ||
      record.seenBy.has(socket.id)
    ) {
      return;
    }

    record.deliveredBy.add(socket.id);
    record.seenBy.add(socket.id);
    io.to(record.room).emit("message:seen", {
      id: messageId,
      room: record.room,
      username: session.username
    });
  });

  socket.on("typing:start", (payload) => {
    const session = activeUsers.get(socket.id);

    if (!session) {
      return;
    }

    const username = sanitizeText(payload && payload.username, 24) || session.username;
    const room = sanitizeRoomName(payload && payload.room) || session.room;

    if (room !== session.room || !username) {
      return;
    }

    addTypingUser(room, socket.id, username);
    socket.to(room).emit("typing:update", { socketId: socket.id, username, room, isTyping: true });
  });

  socket.on("typing:stop", (payload) => {
    const session = activeUsers.get(socket.id);

    if (!session) {
      return;
    }

    const room = sanitizeRoomName(payload && payload.room) || session.room;

    if (room !== session.room) {
      return;
    }

    const username = removeTypingUser(room, socket.id) || session.username;
    socket.to(room).emit("typing:update", { socketId: socket.id, username, room, isTyping: false });
  });

  socket.on("disconnect", () => {
    const session = activeUsers.get(socket.id);

    if (!session) {
      return;
    }

    const stoppedTypingUser = removeTypingUser(session.room, socket.id);
    removeRoomUser(session.room, socket.id);
    activeUsers.delete(socket.id);
    rateLimitLog.delete(socket.id);

    if (stoppedTypingUser) {
      io.to(session.room).emit("typing:update", {
        socketId: socket.id,
        username: stoppedTypingUser,
        room: session.room,
        isTyping: false
      });
    }

    io.to(session.room).emit("chat:system", systemMessage(`${session.username} left room #${session.room}.`));
    broadcastPresence(session.room);
    broadcastRoomList();
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`PulseChat server listening on port ${port}`);
});