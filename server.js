const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5001;
const BASE_URL = process.env.BASE_URL || `https://sstamp.onrender.com`; // Render base URL fallback

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

  const fileUrl = `${BASE_URL}/uploads/${req.file.filename}`;

  logs.unshift({
    imageUrl: fileUrl,
    usage,
    timestamp,
  });

  if (logs.length > 20) logs.pop();

  res.status(200).json({ message: "Uploaded" });
});

app.get("/api/logs", (req, res) => {
  res.json(logs);
});

// Custom 404 Handler
app.use((req, res) => {
  res.status(404).send("<h1>Welcome Fucker</h1>"); // Still edgy? 😏
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
