const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");

const app = express();
const PORT = 5001;

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "./uploads";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    cb(null, `screenshot_${timestamp}.png`);
  },
});

const upload = multer({ storage });

let logs = []; // Stores data like { imageUrl, usage, timestamp }

app.post("/api/upload", upload.single("screenshot"), (req, res) => {
  const { timestamp } = req.body;
  const usage = JSON.parse(req.body.usage || "{}");

  const fileUrl = `http://localhost:${PORT}/uploads/${req.file.filename}`;

  logs.unshift({
    imageUrl: fileUrl,
    usage,
    timestamp,
  });

  // Keep only the last 20 logs
  if (logs.length > 20) logs.pop();

  res.status(200).json({ message: "Uploaded" });
});

app.get("/api/logs", (req, res) => {
  res.json(logs);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
