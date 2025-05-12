const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const UPLOAD_DIR = path.join(__dirname, "uploads");
const MAX_IMAGES = 30;

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `screenshot_${timestamp}${ext}`);
  },
});

const upload = multer({ storage });
const router = express.Router();

router.post("/api/upload", upload.single("screenshot"), async (req, res) => {
  try {
    const usage = JSON.parse(req.body.usage || "{}");
    const file = req.file;

    // Get all images sorted by creation time (oldest first)
    const files = fs
      .readdirSync(UPLOAD_DIR)
      .map((file) => ({
        name: file,
        time: fs.statSync(path.join(UPLOAD_DIR, file)).birthtimeMs,
      }))
      .sort((a, b) => a.time - b.time);

    // Delete oldest files if limit exceeded
    if (files.length > MAX_IMAGES) {
      const toDelete = files.slice(0, files.length - MAX_IMAGES);
      toDelete.forEach((fileObj) => {
        fs.unlinkSync(path.join(UPLOAD_DIR, fileObj.name));
      });
    }

    return res.status(200).json({ message: "Upload success" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to upload" });
  }
});

module.exports = router;
