const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5001;
const BASE_URL = process.env.BASE_URL || `https://sstamp.onrender.com`; // Render base URL fallback
let currentInterval = 30;

app.use(cors());
app.use(
  express.json({
    origin: "http://localhost:3005", // Replace with your frontend's origin
    methods: ["GET"],
    credentials: true,
  })
);
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
app.post("/api/interval", (req, res) => {
  const { interval } = req.body;
  currentInterval = parseInt(interval);
  fs.writeFileSync("interval.txt", currentInterval.toString());
  res.status(200).json({ message: "Interval updated" });
});


app.post("/api/upload", upload.single("screenshot"), (req, res) => {
  const { timestamp } = req.body;
  const usage = JSON.parse(req.body.usage || "{}");

  const fileUrl = `${BASE_URL}/uploads/${req.file.filename}`;

  logs.unshift({
    imageUrl: fileUrl,
    usage,
    timestamp,
  });

  if (logs.length > 100){


    const removed = logs.pop();

    const filename = removed.imageUrl.split("/").pop();
    const filePath = path.join(__dirname, "uploads", filename);

    fs.unlink(filePath, (err) => {
      if (err) console.error("Failed to delete old screenshot:", err);
    });
  }

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
