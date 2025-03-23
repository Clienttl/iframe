const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

// Set up Multer to handle video uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/"); // Store videos in the 'uploads' folder
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname); // Keep original file name
  },
});

const upload = multer({ storage: storage });

// Serve static files from 'uploads' folder
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Simple route to serve the homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Route to handle video upload
app.post("/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).send("No video file uploaded.");
  }

  // Generate a random string (e.g., for shortening)
  const randomString = crypto.randomBytes(3).toString("hex");

  // Generate a shortened URL
  const shortenedLink = `${req.protocol}://${req.get("host")}/?=${randomString}`;

  // In a real app, save the video path and corresponding random string to a database.
  // For simplicity, we'll use an in-memory object for mapping
  global.videos = global.videos || {};
  global.videos[randomString] = req.file.path;

  // Return the shortened URL to the user
  res.json({ shortenedLink });
});

// Route for redirecting to the uploaded video
app.get("/?:id", (req, res) => {
  const videoId = req.query.id;
  const videoPath = global.videos[videoId];

  if (videoPath) {
    res.redirect(`/uploads/${path.basename(videoPath)}`);
  } else {
    res.status(404).send("Video not found.");
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
