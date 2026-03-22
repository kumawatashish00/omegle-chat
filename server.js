const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const path    = require("path");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,
});

app.use(express.static(path.join(__dirname, "public")));

// ── ICE servers — STUN (global) + TURN (relay for cross-network) ──────────
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  // Free public TURN relay — works across all networks/devices
  { urls: "turn:openrelay.metered.ca:80",      username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443",     username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:80?transport=tcp",  username: "openrelayproject", credential: "openrelayproject" },
];

// ── State ─────────────────────────────────────────────────────────────────
const queue = [];           // sockets waiting for a partner
const pairs = new Map();    // socketId → partnerSocketId

function dequeue(socket) {
  const i = queue.findIndex(s => s.id === socket.id);
  if (i !== -1) queue.splice(i, 1);
}

function partner(socketId) {
  return pairs.get(socketId);
}

function unpair(socket) {
  const pid = partner(socket.id);
  pairs.delete(socket.id);
  if (pid) {
    pairs.delete(pid);
    const ps = io.sockets.sockets.get(pid);
    if (ps) ps.emit("partner_left");
  }
  dequeue(socket);
}

function relay(socket, event, data) {
  const pid = partner(socket.id);
  if (!pid) return;
  const ps = io.sockets.sockets.get(pid);
  if (ps) ps.emit(event, data);
}

function tryMatch(socket) {
  // Clean stale sockets from queue
  while (queue.length && !io.sockets.sockets.has(queue[0].id)) queue.shift();

  // Don't match with self
  const idx = queue.findIndex(s => s.id !== socket.id);
  if (idx !== -1) {
    const peer = queue.splice(idx, 1)[0];
    pairs.set(socket.id, peer.id);
    pairs.set(peer.id, socket.id);
    // peer (was waiting) = initiator
    peer.emit("matched",   { initiator: true,  iceServers: ICE_SERVERS });
    socket.emit("matched", { initiator: false, iceServers: ICE_SERVERS });
    console.log(`✅ Matched ${socket.id.slice(0,5)} ↔ ${peer.id.slice(0,5)}`);
  } else {
    if (!queue.find(s => s.id === socket.id)) queue.push(socket);
    socket.emit("waiting");
    console.log(`⌛ Queue: ${queue.length}`);
  }
}

// ── Socket events ─────────────────────────────────────────────────────────
io.on("connection", socket => {
  console.log(`+ ${socket.id.slice(0,5)}`);
  io.emit("online_count", io.engine.clientsCount);

  socket.on("find_stranger", () => {
    if (partner(socket.id)) return;
    dequeue(socket);
    tryMatch(socket);
  });

  // All WebRTC signaling goes through one "signal" event
  socket.on("signal",       d  => relay(socket, "signal",       d));

  // Chat
  socket.on("chat_message", d  => relay(socket, "chat_message", { text: d.text, ts: Date.now() }));
  socket.on("typing",       val => relay(socket, "typing",      val));

  socket.on("skip", () => { unpair(socket); tryMatch(socket); });
  socket.on("stop", () => { unpair(socket); socket.emit("stopped"); });

  socket.on("disconnect", () => {
    unpair(socket);
    io.emit("online_count", io.engine.clientsCount);
    console.log(`- ${socket.id.slice(0,5)}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅  http://localhost:${PORT}`));