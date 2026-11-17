"use strict";

const path = require("path");
const express = require("express");
const agencyApi = require("./functions/agency_api");

const app = express();
const clientDir = path.join(__dirname, "client");
const port = Number(process.env.PORT) || 3000;

app.use("/server/agency_api", agencyApi);
app.use("/app", express.static(clientDir));
app.get("/", (_req, res) => {
  res.redirect("/app/index.html");
});

app.listen(port, () => {
  console.log(`ECTS portal: http://localhost:${port}/app/index.html`);
});
