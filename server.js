const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(express.static(path.join(__dirname, "public")));

// ── State ──────────────────────────────────────────────────────────────
const waitingQueue = [];   // sockets waiting for a partner
const pairs        = new Map(); // socketId → partnerSocketId

function removeFromQueue(socket) {
  const idx = waitingQueue.indexOf(socket);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function getPartner(socketId) {
  return pairs.get(socketId);
}

function disconnectPair(socket) {
  const partnerId = getPartner(socket.id);
  pairs.delete(socket.id);
  if (partnerId) {
    pairs.delete(partnerId);
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) partnerSocket.emit("partner_disconnected");
  }
  removeFromQueue(socket);
}

function tryMatch(socket) {
  if (waitingQueue.length > 0) {
    const partner = waitingQueue.shift();
    if (partner.id === socket.id) { waitingQueue.push(socket); return; }

    pairs.set(socket.id, partner.id);
    pairs.set(partner.id, socket.id);

    // Tell the FIRST user (partner, who was waiting longer) to create the WebRTC offer
    partner.emit("matched", { initiator: true });
    socket.emit("matched",  { initiator: false });

    console.log(`Matched: ${socket.id} <-> ${partner.id}`);
  } else {
    waitingQueue.push(socket);
    socket.emit("waiting");
    console.log(`Waiting: ${socket.id}  queue=${waitingQueue.length}`);
  }
}

// ── Relay helper — forward any WebRTC signal to partner ────────────────
function relay(socket, event, data) {
  const partnerId = getPartner(socket.id);
  if (!partnerId) return;
  const partnerSocket = io.sockets.sockets.get(partnerId);
  if (partnerSocket) partnerSocket.emit(event, data);
}

// ── Socket events ──────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`+ ${socket.id}`);
  io.emit("online_count", io.engine.clientsCount);

  socket.on("find_stranger", () => {
    if (getPartner(socket.id)) return;
    removeFromQueue(socket);
    tryMatch(socket);
  });

  // ── WebRTC signaling ───────────────────────────────────────────────
  socket.on("webrtc_offer",     (data) => relay(socket, "webrtc_offer",     data));
  socket.on("webrtc_answer",    (data) => relay(socket, "webrtc_answer",    data));
  socket.on("webrtc_ice",       (data) => relay(socket, "webrtc_ice",       data));

  // ── Chat ───────────────────────────────────────────────────────────
  socket.on("message", (data) => relay(socket, "message", { text: data.text, timestamp: Date.now() }));
  socket.on("typing",  (val)  => relay(socket, "stranger_typing", val));

  // ── Control ────────────────────────────────────────────────────────
  socket.on("skip", () => {
    disconnectPair(socket);
    tryMatch(socket);
  });

  socket.on("stop", () => {
    disconnectPair(socket);
    socket.emit("stopped");
  });

  socket.on("disconnect", () => {
    disconnectPair(socket);
    io.emit("online_count", io.engine.clientsCount);
    console.log(`- ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅  http://localhost:${PORT}`));