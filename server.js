const express = require("express");
const { spawn } = require("child_process");
const readline = require("readline");
const app = express();
app.use(express.json({ limit: "32kb" }));
const PORT = Number(process.env.PORT) || 3000;
const DEPTH = Number(process.env.BOT_DEPTH) || 15;
const STOCKFISH_BIN = process.env.STOCKFISH_PATH || "stockfish";
/**
 * Ask Stockfish for best move (UCI), e.g. "e2e4".
 */
function bestMoveFromFen(fen, depth) {
  return new Promise((resolve, reject) => {
    const sf = spawn(STOCKFISH_BIN, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = readline.createInterface({ input: sf.stdout });
    sf.stderr.on("data", () => {});
    sf.on("error", (err) => {
      rl.close();
      reject(err);
    });
    sf.stdin.write("uci\n");
    rl.on("line", (line) => {
      if (line === "uciok") {
        sf.stdin.write("isready\n");
        return;
      }
      if (line === "readyok") {
        sf.stdin.write(`position fen ${fen}\n`);
        sf.stdin.write(`go depth ${depth}\n`);
        return;
      }
      if (line.startsWith("bestmove")) {
        const parts = line.trim().split(/\s+/);
        const mv = parts[1];
        rl.close();
        sf.kill("SIGKILL");
        if (!mv || mv === "(none)") {
          resolve(null);
        } else {
          resolve(mv);
        }
      }
    });
    sf.on("close", (code) => {
      // If process exits before bestmove, fail softly
      rl.close();
    });
  });
}
app.get("/", (_req, res) => {
  res.type("text").send("Chess bot API — POST /bestmove { fen, level }");
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, depth: DEPTH });
});
app.post("/bestmove", async (req, res) => {
  const fen = typeof req.body?.fen === "string" ? req.body.fen.trim() : "";
  if (!fen) {
    res.status(400).json({ error: "Missing fen" });
    return;
  }
  try {
    const move = await bestMoveFromFen(fen, DEPTH);
    if (!move) {
      res.status(422).json({ error: "No legal move", move: null });
      return;
    }
    // Your GameScreen accepts move or bestmove (UCI string like e2e4)
    res.json({ move, bestmove: move });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "Engine error",
      detail: process.env.NODE_ENV === "development" ? String(e.message) : undefined,
    });
  }
});
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Bot API on http://0.0.0.0:${PORT} (depth ${DEPTH}, ${STOCKFISH_BIN})`);
});