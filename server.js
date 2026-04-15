const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// API to get bot move
app.post("/move", (req, res) => {
  const { fen } = req.body;

  if (!fen) {
    return res.status(400).json({ error: "FEN is required" });
  }

  const engine = Stockfish(); // create fresh engine

  let responded = false;

  engine.postMessage("position fen " + fen);
  engine.postMessage("go depth 10"); // keep it light

  engine.onmessage = function (event) {
    const line = event;

    if (typeof line === "string" && line.includes("bestmove") && !responded) {
      responded = true;

      const move = line.split(" ")[1];

      res.json({ move });

      engine.terminate(); // VERY IMPORTANT (free memory)
    }
  };
});

// Health check route
app.get("/", (req, res) => {
  res.send("Bot server running 🚀");
});

// Render port
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Bot server running on port", PORT);
});
