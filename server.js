const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ROOMS_FILE = path.join(__dirname, "rooms.json");
const ONE_HOUR = 60 * 60 * 1000;
const rooms = {};

// Reserved/banned names
const RESERVED_NAMES = ["system", "owner", "admin", "moderator"];
const BANNED_WORDS = ["badword1", "badword2", "slur1", "slur2"]; // extend this list

// Serve static files (index.html, etc.)
app.use(express.static(__dirname));

// Load persisted rooms
function loadRooms() {
  try {
    const raw = fs.readFileSync(ROOMS_FILE, "utf-8");
    const data = JSON.parse(raw);
    for (const [code, r] of Object.entries(data.rooms || {})) {
      rooms[code] = {
        createdAt: r.createdAt || Date.now(),
        lastActiveAt: r.lastActiveAt || Date.now(),
        messages: r.messages || [],
        members: 0,
        deleteTimerId: null,
        warningSent: false,
        password: r.password || null,
        limit: r.limit || null,
        usernames: new Set()
      };
    }
  } catch {}
}
function saveRooms() {
  const serializable = { rooms: {} };
  for (const [code, r] of Object.entries(rooms)) {
    serializable.rooms[code] = {
      createdAt: r.createdAt,
      lastActiveAt: r.lastActiveAt,
      messages: r.messages,
      password: r.password,
      limit: r.limit
    };
  }
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(serializable, null, 2));
}
loadRooms();

function ensureRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      messages: [],
      members: 0,
      deleteTimerId: null,
      warningSent: false,
      password: null,
      limit: null,
      usernames: new Set()
    };
    saveRooms();
  }
  return rooms[code];
}
function addMessage(code, msg) {
  const r = ensureRoom(code);
  r.messages.push({ ...msg, timestamp: Date.now() });
  if (r.messages.length > 1000) r.messages = r.messages.slice(-800);
  r.lastActiveAt = Date.now();
  cancelDeletion(code);
  saveRooms();
}
function deleteRoom(code) {
  if (!rooms[code]) return;
  io.to(code).emit("room-deleted", { code });
  delete rooms[code];
  saveRooms();
}
function scheduleDeletion(code, delay, reason) {
  const r = rooms[code];
  if (!r || r.deleteTimerId) return;
  if (reason === "age" && r.members > 0 && !r.warningSent) {
    r.warningSent = true;
    const warn = "This room is over 1 hour old and will be deleted in 60s unless there is activity.";
    addMessage(code, { name: "System", text: warn, system: true });
    io.to(code).emit("message", { name: "System", text: warn, system: true });
  }
  r.deleteTimerId = setTimeout(() => deleteRoom(code), delay);
}
function cancelDeletion(code) {
  const r = rooms[code];
  if (r && r.deleteTimerId) {
    clearTimeout(r.deleteTimerId);
    r.deleteTimerId = null;
    r.warningSent = false;
  }
}
setInterval(() => {
  for (const [code, r] of Object.entries(rooms)) {
    if (r.members === 0) {
      deleteRoom(code);
    } else if (Date.now() - r.createdAt >= ONE_HOUR) {
      scheduleDeletion(code, 60 * 1000, "age");
    }
  }
}, 60 * 1000);

// Username validation
function isNameInvalid(name, roomCode) {
  const lower = name.toLowerCase();
  if (RESERVED_NAMES.includes(lower)) return "That username is reserved.";
  for (const w of BANNED_WORDS) {
    if (lower.includes(w)) return "That username is not allowed.";
  }
  const r = rooms[roomCode];
  if (r && r.usernames && r.usernames.has(lower)) {
    return "That username is already taken in this room.";
  }
  return null;
}

// Endpoint to check room info
app.get("/roominfo/:code", (req, res) => {
  const code = req.params.code;
  const r = rooms[code];
  if (!r) return res.json({ exists: false });
  res.json({ exists: true, hasPassword: !!r.password });
});

// Endpoint to fetch full room data (for polling)
app.get("/room-data/:code", (req, res) => {
  const code = req.params.code;
  const r = rooms[code];
  if (!r) return res.json({ exists: false });
  res.json({
    exists: true,
    room: code,
    messages: r.messages,
    users: Array.from(r.usernames || []),
    limit: r.limit,
    hasPassword: !!r.password
  });
});

// Socket.IO
io.on("connection", socket => {
  socket.on("join", ({ room, name, password, limit }) => {
    const code = String(room || "default").trim();
    const r = ensureRoom(code);

    const userName = String(name || "Anon").trim();
    const invalidReason = isNameInvalid(userName, code);
    if (invalidReason) {
      socket.emit("join-error", { error: invalidReason });
      return;
    }

    // Password check
    if (r.password && r.password !== password) {
      socket.emit("join-error", { error: "Wrong password or room does not exist." });
      return;
    }

    // Limit check
    if (r.limit && r.members >= r.limit) {
      socket.emit("join-error", { error: "This room is full." });
      return;
    }

    // If new room, set password/limit
    if (!r.password && password) r.password = password;
    if (!r.limit && limit) r.limit = limit;

    r.members += 1;
    r.usernames.add(userName.toLowerCase());
    cancelDeletion(code);
    socket.join(code);

    socket.data = { room: code, name: userName };

    socket.emit("joined", { room: code });
    const joinText = `${userName} joined the room.`;
    addMessage(code, { name: "System", text: joinText, system: true });
    socket.to(code).emit("message", { name: "System", text: joinText, system: true });
  });

  socket.on("message", ({ room, name, text }) => {
    const code = String(room || (socket.data && socket.data.room) || "default");
    const nm = String(name || (socket.data && socket.data.name) || "Anon");
    const tx = String(text || "").slice(0, 5000);
    if (!code || !tx) return;
    addMessage(code, { name: nm, text: tx, system: false });
    io.to(code).emit("message", { name: nm, text: tx, system: false });
  });

  socket.on("disconnect", () => {
    const { room: code, name: userName } = socket.data || {};
    if (!code) return;
    const r = rooms[code];
    if (!r) return;
    r.members = Math.max(0, r.members - 1);
    if (userName) r.usernames.delete(userName.toLowerCase());
    addMessage(code, { name: "System", text: `${userName || "Anon"} left the room.`, system: true });
    if (r.members === 0) deleteRoom(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on http://localhost:" + PORT));
