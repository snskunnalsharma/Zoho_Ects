"use strict";

const path = require("path");
const fs = require("fs");

/**
 * Preferred source (deployed): Catalyst Function Environment Variables
 * (set in catalyst-config.json → env_variables, or Console → Function → Configuration).
 *
 * Local fallback: project `.env` / `functions/agency_api/.env` via dotenv.
 * Existing process.env values are never overwritten (so Catalyst env wins).
 */
function loadLocalEnvFile() {
  const candidates = [
    path.resolve(__dirname, ".env"),
    path.resolve(__dirname, "../../.env"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
  ];

  for (const start of [__dirname, process.cwd()]) {
    let dir = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      candidates.push(path.join(dir, ".env"));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!fs.existsSync(candidate)) continue;
    try {
      require("dotenv").config({ path: candidate, override: false });
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

loadLocalEnvFile();

/**
 * Reads Zoho / app settings from process.env (Catalyst env vars or local .env).
 */
module.exports = {
  CLIENT_ID: process.env.ZOHO_CLIENT_ID || "",
  CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET || "",
  REFRESH_TOKEN: process.env.ZOHO_REFRESH_TOKEN || "",

  ACCOUNTS_HOST: process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com",
  CRM_API_HOST: process.env.ZOHO_CRM_API_HOST || "www.zohoapis.com",

  OAUTH_SCOPES: [
    "ZohoCRM.modules.ALL",
    "ZohoCRM.users.READ",
    "AaaServer.profile.READ",
    "WorkDrive.workspace.ALL",
    "WorkDrive.files.ALL",
    "WorkDrive.files.READ",
    "WorkDrive.team.ALL",
    "ZohoMail.messages.CREATE",
  ].join(","),

  AGENCY_MODULE: process.env.ZOHO_AGENCY_MODULE || "Accounts",
  AGENCY_EMAIL_FIELD:
    process.env.ZOHO_AGENCY_EMAIL_FIELD || "Portal_Access_Email",

  FIELD_AGENCY_NAME: process.env.ZOHO_FIELD_AGENCY_NAME || "Agency_Name",
  FIELD_PORTAL_EMAIL:
    process.env.ZOHO_FIELD_PORTAL_EMAIL || "Portal_Access_Email",
  FIELD_CREDENTIAL: process.env.ZOHO_FIELD_CREDENTIAL || "Credential",
  // Checkbox on Accounts (API name is "Reset")
  FIELD_RESET_API_LINK: process.env.ZOHO_FIELD_RESET_API_LINK || "Reset",
  // Multi-Select Lookup on Accounts linking to Contacts (Therapists)
  FIELD_SELECTED_THERAPISTS:
    process.env.ZOHO_FIELD_SELECTED_THERAPISTS || "Portal_Selected_Therapists",

  ZOHO_FORM_EMBED_URL:
    process.env.ZOHO_FORM_EMBED_URL ||
    "https://forms.zohopublic.com/eaglecreektherapyservices/form/PatientReferralForm/formperma/Iv84Mm6yJ1Q6qjJctjoYY2zmmB0t7_YjncLn10nlbBs",

  SESSION_COOKIE: "agency_portal_session",
  SESSION_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
};
