// server.js
const express = require('express');
const mongoose = require('mongoose');
const ShortUrl = require('./models/shortUrl');
const app = express();

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('Connected to MongoDB')).catch(err => console.error('MongoDB connection error:', err));

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: false }));

app.get('/', async (req, res) => {
  const shortUrls = await ShortUrl.find();
  res.render('index', { shortUrls });
});

app.post('/shorten', async (req, res) => {
  await ShortUrl.create({ full: req.body.fullUrl });
  res.redirect('/');
});

app.get('/:shortUrl', async (req, res) => {
  const shortUrl = await ShortUrl.findOne({ short: req.params.shortUrl });
  if (!shortUrl) return res.sendStatus(404);

  res.redirect(shortUrl.full);
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));


// models/shortUrl.js
const mongoose = require('mongoose');
const shortId = require('shortid');

const shortUrlSchema = new mongoose.Schema({
  full: { type: String, required: true },
  short: { type: String, required: true, default: shortId.generate }
});

module.exports = mongoose.model('ShortUrl', shortUrlSchema);


// views/index.ejs
<!DOCTYPE html>
<html>
<head>
  <title>Link Shortener</title>
</head>
<body>
  <h1>URL Shortener</h1>
  <form action="/shorten" method="POST">
    <input type="url" name="fullUrl" placeholder="Enter URL" required>
    <button type="submit">Shorten</button>
  </form>
  <ul>
    <% shortUrls.forEach(url => { %>
      <li>
        <a href="/<%= url.short %>">/<%= url.short %></a> - <a href="<%= url.full %>"><%= url.full %></a>
      </li>
    <% }) %>
  </ul>
</body>
</html>
