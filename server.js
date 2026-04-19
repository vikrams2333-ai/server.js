const express = require("express");
const http = require("http");
const crypto = require("crypto");
const cors = require("cors");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");
const app = express();
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.set("trust proxy", 1);
app.use(
  cors({
    origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((s) => s.trim()),
  })
);
app.get("/", (_req, res) => {
  res.type("text").send("Multiplayer server OK");
});
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((s) => s.trim()),
  },
  connectTimeout: 45_000,
  pingTimeout: 25_000,
  pingInterval: 10_000,
});
const DISCONNECT_FORFEIT_MS = 30_000;
const BACKGROUND_FORFEIT_MS = 60_000;
/** @type {Map<string, { socket: import("socket.io").Socket, uid: string }>} */
const firestoreMatchWaiters = new Map();
/** @type {Map<string, Array<{ socket: import("socket.io").Socket, uid: string, mode: "free" | "paid", betAmount: number }>>} */
const waitingQueues = new Map();
/** @type {Map<string, any>} */
const roomStates = new Map();
/** In-memory wallet ledger (replace with DB for production) */
const DEFAULT_SERVER_BALANCE = 1000;
/** @type {Map<string, number>} */
const serverBalancesByUid = new Map();
/** @type {Set<string>} */
const serverWalletSettledGameIds = new Set();
function perPlayerMsForMode(mode) {
  return mode === "paid" ? 5 * 60 * 1000 : 10 * 60 * 1000;
}
function queueKey(mode, betAmount) {
  return mode === "paid" ? `paid_${Number(betAmount) || 0}` : "free";
}
function getSrvBal(uid) {
  if (!serverBalancesByUid.has(uid)) {
    serverBalancesByUid.set(uid, DEFAULT_SERVER_BALANCE);
  }
  return serverBalancesByUid.get(uid);
}
function calculateWinnerCreditServer(betPerPlayer) {
  const total = betPerPlayer * 2;
  const commission = Math.floor(total * 0.1);
  const winnerAmount = total - commission;
  return { total, commission, winnerAmount };
}
function buildBalancesForGameResult(st, payload) {
  const snapshot = () => ({
    [st.whiteUid]: getSrvBal(st.whiteUid),
    [st.blackUid]: getSrvBal(st.blackUid),
  });
  if (st.mode !== "paid" || !(st.betAmount > 0)) {
    return { balancesByUid: snapshot(), paid: false };
  }
  if (serverWalletSettledGameIds.has(st.gameId)) {
    return { balancesByUid: snapshot(), paid: true, alreadySettled: true };
  }
  serverWalletSettledGameIds.add(st.gameId);
  if (payload.draw) {
    return { balancesByUid: snapshot(), paid: true };
  }
  const bet = st.betAmount;
  const { winnerAmount } = calculateWinnerCreditServer(bet);
  let w = getSrvBal(st.whiteUid);
  let b = getSrvBal(st.blackUid);
  if (payload.winnerColor === "white") {
    w = Math.max(0, w - bet + winnerAmount);
    b = Math.max(0, b - bet);
  } else if (payload.winnerColor === "black") {
    b = Math.max(0, b - bet + winnerAmount);
    w = Math.max(0, w - bet);
  }
  serverBalancesByUid.set(st.whiteUid, w);
  serverBalancesByUid.set(st.blackUid, b);
  return { balancesByUid: { [st.whiteUid]: w, [st.blackUid]: b }, paid: true };
}
/** Live clock payload from authoritative server state. */
function liveClockPayloadFromState(st) {
  const serverNow = Date.now();
  const elapsed = Math.max(0, serverNow - st.turnClockStartedAt);
  let white = st.whiteMs;
  let black = st.blackMs;
  if (st.toMove === "w") {
    white = Math.max(0, white - elapsed);
  } else {
    black = Math.max(0, black - elapsed);
  }
  return {
    room: st.room,
    gameId: st.gameId,
    whiteRemainingMs: white,
    blackRemainingMs: black,
    whiteTime: white,
    blackTime: black,
    currentTurn: st.toMove === "w" ? "white" : "black",
    sideToMove: st.toMove,
    turnClockStartedAt: st.turnClockStartedAt,
    lastMoveTimestamp: st.turnClockStartedAt,
    serverNow,
  };
}
function emitPresenceState(st) {
  if (!st || st.isFinished) return;
  io.to(st.room).emit("presenceState", {
    room: st.room,
    gameId: st.gameId,
    white: {
      status: st.presence.white.status, // online|background|offline
      deadlineMs: st.presence.white.deadlineMs,
    },
    black: {
      status: st.presence.black.status,
      deadlineMs: st.presence.black.deadlineMs,
    },
    serverNow: Date.now(),
  });
}
function clearTimeoutSafe(id) {
  if (id) clearTimeout(id);
}
function clearDisconnectGraceForColor(st, color) {
  clearTimeoutSafe(st.disconnectTimeoutIdByColor[color]);
  st.disconnectTimeoutIdByColor[color] = null;
}
function clearBackgroundGraceForColor(st, color) {
  clearTimeoutSafe(st.backgroundTimeoutIdByColor[color]);
  st.backgroundTimeoutIdByColor[color] = null;
  st.presence[color].deadlineMs = null;
}
function clearAllTimers(st) {
  clearDisconnectGraceForColor(st, "white");
  clearDisconnectGraceForColor(st, "black");
  clearBackgroundGraceForColor(st, "white");
  clearBackgroundGraceForColor(st, "black");
}
function destroyRoomState(room) {
  const st = roomStates.get(room);
  if (!st) return;
  clearAllTimers(st);
  roomStates.delete(room);
}
function endMatch(room, payload) {
  const st = roomStates.get(room);
  if (!st || st.isFinished) return;
  st.isFinished = true;
  clearAllTimers(st);
  const { balancesByUid, paid } = buildBalancesForGameResult(st, payload);
  io.to(room).emit("gameResult", {
    room,
    gameId: st.gameId,
    paid,
    draw: !!payload.draw,
    winnerColor: payload.winnerColor ?? null,
    reason: payload.reason,
    balancesByUid,
    whiteUid: st.whiteUid,
    blackUid: st.blackUid,
    betAmount: st.betAmount,
    mode: st.mode,
  });
  roomStates.delete(room);
}
function finalizeTimeoutFlag(room) {
  const st = roomStates.get(room);
  if (!st || st.isFinished) return;
  const now = Date.now();
  const bank = st.toMove === "w" ? st.whiteMs : st.blackMs;
  const elapsed = Math.max(0, now - st.turnClockStartedAt);
  if (bank - elapsed > 0) return;
  const winnerColor = st.toMove === "w" ? "black" : "white";
  endMatch(room, {
    reason: "timeout",
    winnerColor,
    draw: false,
  });
}
function tickActiveGames() {
  for (const [room, st] of [...roomStates.entries()]) {
    if (!st || st.isFinished || !roomStates.has(room)) continue;
    const live = liveClockPayloadFromState(st);
    if (st.toMove === "w" && live.whiteRemainingMs <= 0) {
      finalizeTimeoutFlag(room);
      continue;
    }
    if (st.toMove === "b" && live.blackRemainingMs <= 0) {
      finalizeTimeoutFlag(room);
      continue;
    }
    io.to(room).emit("clockSync", live);
    io.to(room).emit("gameState", live);
  }
}
function createRoomState(room, gameId, mode, betAmount, whiteUid, blackUid) {
  destroyRoomState(room);
  const per = perPlayerMsForMode(mode);
  const st = {
    room,
    gameId,
    mode,
    betAmount,
    isFinished: false,
    chess: new Chess(),
    whiteUid,
    blackUid,
    whiteMs: per,
    blackMs: per,
    toMove: "w",
    turnClockStartedAt: Date.now(),
    disconnectTimeoutIdByColor: {
      white: null,
      black: null,
    },
    backgroundTimeoutIdByColor: {
      white: null,
      black: null,
    },
    presence: {
      white: { status: "online", deadlineMs: null },
      black: { status: "online", deadlineMs: null },
    },
  };
  roomStates.set(room, st);
  return st;
}
function startDisconnectGrace(room, color) {
  const st = roomStates.get(room);
  if (!st || st.isFinished) return;
  clearDisconnectGraceForColor(st, color);
  st.presence[color].status = "offline";
  emitPresenceState(st);
  st.disconnectTimeoutIdByColor[color] = setTimeout(() => {
    st.disconnectTimeoutIdByColor[color] = null;
    const s2 = roomStates.get(room);
    if (!s2 || s2.isFinished) return;
    if (s2.presence[color].status !== "offline") return;
    const winnerColor = color === "white" ? "black" : "white";
    endMatch(room, {
      reason: "disconnect_forfeit",
      winnerColor,
      draw: false,
    });
  }, DISCONNECT_FORFEIT_MS);
}
function startBackgroundGrace(room, color) {
  const st = roomStates.get(room);
  if (!st || st.isFinished) return;
  clearBackgroundGraceForColor(st, color);
  st.presence[color].status = "background";
  st.presence[color].deadlineMs = Date.now() + BACKGROUND_FORFEIT_MS;
  emitPresenceState(st);
  st.backgroundTimeoutIdByColor[color] = setTimeout(() => {
    st.backgroundTimeoutIdByColor[color] = null;
    const s2 = roomStates.get(room);
    if (!s2 || s2.isFinished) return;
    if (s2.presence[color].status !== "background") return;
    const winnerColor = color === "white" ? "black" : "white";
    endMatch(room, {
      reason: "background_forfeit",
      winnerColor,
      draw: false,
    });
  }, BACKGROUND_FORFEIT_MS);
}
function stopBackgroundGrace(room, color) {
  const st = roomStates.get(room);
  if (!st || st.isFinished) return;
  clearBackgroundGraceForColor(st, color);
  st.presence[color].status = "online";
  emitPresenceState(st);
}
function markOnlineAndClearAllGrace(room, color) {
  const st = roomStates.get(room);
  if (!st || st.isFinished) return;
  clearDisconnectGraceForColor(st, color);
  clearBackgroundGraceForColor(st, color);
  st.presence[color].status = "online";
  emitPresenceState(st);
}
function moverCharFromMeta(meta) {
  if (!meta || (meta.color !== "white" && meta.color !== "black")) return null;
  return meta.color === "white" ? "w" : "b";
}
function handlePlayerResigned(socket, payload = {}) {
  const room = socket.matchMeta?.room;
  if (!room || socket.room !== room || !socket.matchMeta) return;
  const st = roomStates.get(room);
  if (!st || st.isFinished) return;
  const reqGid = payload.gameId != null ? String(payload.gameId) : "";
  const reqPid = payload.playerId != null ? String(payload.playerId) : "";
  if (reqGid && reqGid !== st.gameId) return;
  if (reqPid && socket.matchMeta.playerId && reqPid !== socket.matchMeta.playerId) return;
  const loserColor = socket.matchMeta.color;
  const winnerColor = loserColor === "white" ? "black" : "white";
  endMatch(room, {
    reason: "playerResigned",
    winnerColor,
    draw: false,
  });
}
io.on("connection", (socket) => {
  socket.on("joinGame", (payload = {}) => {
    // Firestore room flow
    if (payload.firestoreMatchId) {
      const rid = String(payload.firestoreMatchId)
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 120);
      if (!rid) {
        socket.emit("matchmaking_error", { message: "Invalid match id." });
        return;
      }
      const mode = payload.mode === "paid" ? "paid" : "free";
      const betAmount = mode === "paid"
        ? Math.max(0, Math.floor(Number(payload.betAmount) || 0))
        : 0;
      const uid = typeof payload.uid === "string" && payload.uid.length > 0
        ? payload.uid
        : socket.id;
      if (mode === "paid" && betAmount <= 0) {
        socket.emit("matchmaking_error", {
          message: "Invalid stake for a money match.",
        });
        return;
      }
      const room = `fs_${rid}`;
      if (!firestoreMatchWaiters.has(rid)) {
        firestoreMatchWaiters.set(rid, { socket, uid });
        socket.join(room);
        socket.room = room;
        socket.firestoreMatchWaiterKey = rid;
        socket.emit("waiting");
        return;
      }
      const first = firestoreMatchWaiters.get(rid);
      firestoreMatchWaiters.delete(rid);
      if (!first?.socket?.connected || first.socket.id === socket.id) {
        socket.emit("matchmaking_error", {
          message: "Match room expired. Try again.",
        });
        return;
      }
      const gameId = crypto.randomUUID();
      const whiteUid = first.uid;
      const blackUid = uid;
      first.socket.join(room);
      socket.join(room);
      first.socket.room = room;
      socket.room = room;
      first.socket.firestoreMatchWaiterKey = undefined;
      first.socket.matchMeta = {
        room,
        color: "white",
        gameId,
        betAmount,
        mode,
        playerId: whiteUid,
      };
      socket.matchMeta = {
        room,
        color: "black",
        gameId,
        betAmount,
        mode,
        playerId: blackUid,
      };
      const st = createRoomState(room, gameId, mode, betAmount, whiteUid, blackUid);
      const startPayload = (color) => ({
        room,
        color,
        gameId,
        betAmount: mode === "paid" ? betAmount : 0,
        mode,
        whiteUid,
        blackUid,
        clock: liveClockPayloadFromState(st),
      });
      first.socket.emit("start", startPayload("white"));
      socket.emit("start", startPayload("black"));
      emitPresenceState(st);
      return;
    }
    // Normal queue flow
    const mode = payload.mode === "paid" ? "paid" : "free";
    const betAmount = mode === "paid"
      ? Math.max(0, Math.floor(Number(payload.betAmount) || 0))
      : 0;
    const uid = typeof payload.uid === "string" && payload.uid.length > 0
      ? payload.uid
      : socket.id;
    if (mode === "paid" && betAmount <= 0) {
      socket.emit("matchmaking_error", {
        message: "Invalid stake for a money match.",
      });
      return;
    }
    const guestLike =
      typeof payload.uid === "string" && payload.uid.startsWith("guest_");
    if (mode === "paid" && (!payload.uid || (payload.uid === socket.id && !guestLike))) {
      socket.emit("matchmaking_error", {
        message: "Use a guest id for paid test matches.",
      });
      return;
    }
    const key = queueKey(mode, betAmount);
    if (!waitingQueues.has(key)) waitingQueues.set(key, []);
    const queue = waitingQueues.get(key);
    const entry = { socket, uid, mode, betAmount };
    if (queue.length > 0) {
      const waitingPlayer = queue.shift();
      const room = `${waitingPlayer.socket.id}#${socket.id}`;
      const gameId = crypto.randomUUID();
      const whiteUid = waitingPlayer.uid;
      const blackUid = entry.uid;
      socket.join(room);
      waitingPlayer.socket.join(room);
      socket.room = room;
      waitingPlayer.socket.room = room;
      waitingPlayer.socket.matchMeta = {
        room,
        color: "white",
        gameId,
        betAmount,
        mode,
        playerId: whiteUid,
      };
      socket.matchMeta = {
        room,
        color: "black",
        gameId,
        betAmount,
        mode,
        playerId: blackUid,
      };
      const st = createRoomState(room, gameId, mode, betAmount, whiteUid, blackUid);
      const startPayload = (color) => ({
        room,
        color,
        gameId,
        betAmount: mode === "paid" ? betAmount : 0,
        mode,
        whiteUid,
        blackUid,
        clock: liveClockPayloadFromState(st),
      });
      waitingPlayer.socket.emit("start", startPayload("white"));
      socket.emit("start", startPayload("black"));
      emitPresenceState(st);
    } else {
      queue.push(entry);
      socket.waitingQueueKey = key;
      socket.emit("waiting");
    }
  });
  socket.on("rejoinMatch", (payload = {}) => {
    const room = typeof payload.room === "string" ? payload.room : "";
    const uid = typeof payload.uid === "string" && payload.uid.length > 0 ? payload.uid : "";
    if (!room || !uid) {
      socket.emit("rejoinFailed", { message: "Invalid rejoin payload." });
      return;
    }
    const st = roomStates.get(room);
    if (!st || st.isFinished) {
      socket.emit("rejoinFailed", { message: "Match not active." });
      return;
    }
    if (uid !== st.whiteUid && uid !== st.blackUid) {
      socket.emit("rejoinFailed", { message: "Not a player in this match." });
      return;
    }
    const color = uid === st.whiteUid ? "white" : "black";
    socket.join(room);
    socket.room = room;
    socket.matchMeta = {
      room,
      color,
      gameId: st.gameId,
      betAmount: st.betAmount,
      mode: st.mode,
      playerId: uid,
    };
    markOnlineAndClearAllGrace(room, color);
    socket.emit("rejoinOk", {
      room,
      color,
      gameId: st.gameId,
      fen: st.chess.fen(),
      moves: st.chess.history(),
      betAmount: st.betAmount,
      mode: st.mode,
      whiteUid: st.whiteUid,
      blackUid: st.blackUid,
      clock: liveClockPayloadFromState(st),
    });
    const live = liveClockPayloadFromState(st);
    io.to(room).emit("clockSync", live);
    io.to(room).emit("gameState", live);
    emitPresenceState(st);
  });
  socket.on("playerBackground", (payload = {}) => {
    const room = socket.matchMeta?.room;
    const color = socket.matchMeta?.color;
    if (!room || !color || socket.room !== room) return;
    const st = roomStates.get(room);
    if (!st || st.isFinished) return;
    const reqGid = payload.gameId != null ? String(payload.gameId) : "";
    if (reqGid && reqGid !== st.gameId) return;
    startBackgroundGrace(room, color);
  });
  socket.on("playerForeground", (payload = {}) => {
    const room = socket.matchMeta?.room;
    const color = socket.matchMeta?.color;
    if (!room || !color || socket.room !== room) return;
    const st = roomStates.get(room);
    if (!st || st.isFinished) return;
    const reqGid = payload.gameId != null ? String(payload.gameId) : "";
    if (reqGid && reqGid !== st.gameId) return;
    stopBackgroundGrace(room, color);
  });
  socket.on("move", (data = {}) => {
    if (!data?.move) return;
    const room = typeof data.room === "string" ? data.room : "";
    if (!room || socket.room !== room || !socket.matchMeta) return;
    const st = roomStates.get(room);
    if (!st || st.isFinished) return;
    const mover = moverCharFromMeta(socket.matchMeta);
    if (!mover || mover !== st.toMove) return;
    const now = Date.now();
    const bank = st.toMove === "w" ? st.whiteMs : st.blackMs;
    const elapsed = Math.max(0, now - st.turnClockStartedAt);
    if (elapsed >= bank) {
      finalizeTimeoutFlag(room);
      return;
    }
    const moveTry = st.chess.move({
      from: data.move.from,
      to: data.move.to,
      promotion: data.move.promotion || "q",
    });
    if (!moveTry) return;
    if (st.toMove === "w") st.whiteMs = bank - elapsed;
    else st.blackMs = bank - elapsed;
    st.toMove = st.toMove === "w" ? "b" : "w";
    st.turnClockStartedAt = now;
    io.to(room).emit("move", data.move);
    const liveAfter = liveClockPayloadFromState(st);
    io.to(room).emit("clockSync", liveAfter);
    io.to(room).emit("gameState", liveAfter);
    if (st.chess.isCheckmate()) {
      const loser = st.chess.turn();
      const winnerColor = loser === "w" ? "black" : "white";
      endMatch(room, {
        reason: "checkmate",
        winnerColor,
        draw: false,
      });
      return;
    }
    if (st.chess.isDraw()) {
      endMatch(room, {
        reason: "draw",
        draw: true,
        winnerColor: null,
      });
    }
  });
  socket.on("playerResigned", (payload) => handlePlayerResigned(socket, payload));
  socket.on("resign", (payload) => handlePlayerResigned(socket, payload));
  socket.on("disconnect", () => {
    const fsKey = socket.firestoreMatchWaiterKey;
    if (fsKey && firestoreMatchWaiters.get(fsKey)?.socket === socket) {
      firestoreMatchWaiters.delete(fsKey);
    }
    const meta = socket.matchMeta;
    if (meta?.room && meta?.color) {
      const st = roomStates.get(meta.room);
      if (st && !st.isFinished) {
        startDisconnectGrace(meta.room, meta.color);
      }
    }
    const key = socket.waitingQueueKey;
    if (!key) return;
    const queue = waitingQueues.get(key);
    if (!queue) return;
    const idx = queue.findIndex((e) => e.socket === socket);
    if (idx >= 0) {
      queue.splice(idx, 1);
    }
    if (queue.length === 0) {
      waitingQueues.delete(key);
    }
  });
});
setInterval(tickActiveGames, 1000);
const PORT = Number(process.env.PORT) || 4000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Chess socket server listening on ${PORT}`);
});
