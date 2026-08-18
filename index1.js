const express = require('express');
const app = express();
const port = process.env.PORT || 8000;
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const pairRouter = require('./arslan');
app.use('/', pairRouter);

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

// ================= SELF PING (PREVENT SLEEP) =================
const axios = require("axios");

setInterval(async () => {
    try {
        const appName = process.env.HEROKU_APP_NAME;

        if (!appName) return;

        const url = `https://${appName}.herokuapp.com/status`;

        await axios.get(url);
        console.log("🔄 Self ping sent to:", url);

    } catch (err) {
        console.log("⚠ Self ping failed");
    }
}, 300000); // 5 minutes

module.exports = app;


