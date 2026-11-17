"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const https = require("https");
const crypto = require("crypto");
const axios = require("axios");
const catalyst = require("zcatalyst-sdk-node");
const config = require("./config");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const PORT = 443;
const ORG_CONNECTOR = "agency_crm_org";

function getAppBaseUrl(req) {
  const isLocal = process.env.X_ZOHO_CATALYST_IS_LOCAL === "true";
  const host = isLocal ? req.headers.host : req.headers.host.split(":")[0];
  const protocol = isLocal ? "http" : "https";
  return `${protocol}://${host}`;
}

function getApiBasePath() {
  return "/server/agency_api";
}

function getRedirectUri(req) {
  return `${getAppBaseUrl(req)}${getApiBasePath()}/auth/callback`;
}

function signSession(payload) {
  const secret = config.CLIENT_SECRET || "agency-portal-dev-secret";
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return null;
  }
  const [body, sig] = token.split(".");
  const secret = config.CLIENT_SECRET || "agency-portal-dev-secret";
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function setSessionCookie(res, payload, req) {
  const isLocal = process.env.X_ZOHO_CATALYST_IS_LOCAL === "true";
  res.cookie(config.SESSION_COOKIE, signSession(payload), {
    httpOnly: true,
    secure: !isLocal,
    sameSite: "lax",
    maxAge: config.SESSION_MAX_AGE_MS,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(config.SESSION_COOKIE, { path: "/" });
}

function requireSession(req, res) {
  const session = verifySession(req.cookies[config.SESSION_COOKIE]);
  if (!session || !session.agency_id || !session.email) {
    res.status(401).json({ message: "Not authenticated" });
    return null;
  }
  return session;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

async function exchangeCodeForTokens(code, redirectUri) {
  const url =
    `${config.ACCOUNTS_HOST}/oauth/v2/token` +
    `?code=${encodeURIComponent(code)}` +
    `&client_id=${encodeURIComponent(config.CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(config.CLIENT_SECRET)}` +
    `&grant_type=authorization_code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  const response = await axios.post(url);
  if (!response.data || (!response.data.refresh_token && !response.data.access_token)) {
    throw new Error(
      response.data?.error || "Failed to obtain tokens from Zoho"
    );
  }
  return response.data;
}

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

async function getOrgAccessToken(req, forceFresh = false) {
  if (!config.REFRESH_TOKEN || config.REFRESH_TOKEN.includes("YOUR_REFRESH")) {
    throw new Error(
      "ZOHO_REFRESH_TOKEN is missing. Open /server/agency_api/auth/zoho-connect once, then paste the refresh token into .env"
    );
  }

  if (!forceFresh && cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }

  const url =
    `${config.ACCOUNTS_HOST}/oauth/v2/token` +
    `?refresh_token=${encodeURIComponent(config.REFRESH_TOKEN)}` +
    `&client_id=${encodeURIComponent(config.CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(config.CLIENT_SECRET)}` +
    `&grant_type=refresh_token`;

  const response = await axios.post(url);
  if (!response.data?.access_token) {
    throw new Error(response.data?.error || "Could not refresh Zoho access token");
  }

  cachedAccessToken = response.data.access_token;
  const expiresIn = Number(response.data.expires_in) || 3600;
  cachedAccessTokenExpiresAt = Date.now() + Math.max(60, expiresIn - 300) * 1000;

  return cachedAccessToken;
}

async function crmRequest(accessToken, method, path, body) {
  let token = accessToken;
  if (!token) {
    token = await getOrgAccessToken();
  }

  function execute(curToken) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: config.CRM_API_HOST,
        port: PORT,
        method,
        path,
        headers: {
          Authorization: `Zoho-oauthtoken ${curToken}`,
          "Content-Type": "application/json",
        },
      };
      const request = https.request(options, (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = { raw: data };
          }
          resolve({ status: response.statusCode, data: parsed });
        });
      });
      request.on("error", reject);
      if (body) {
        request.write(JSON.stringify(body));
      }
      request.end();
    });
  }

  let result = await execute(token);

  // If token expired, auto-refresh and retry once
  if (
    result.status === 401 ||
    result.data?.code === "INVALID_TOKEN" ||
    result.data?.data?.[0]?.code === "INVALID_TOKEN"
  ) {
    console.warn("[CRM] Received INVALID_TOKEN. Refreshing access token and retrying request...");
    try {
      const freshToken = await getOrgAccessToken(null, true);
      result = await execute(freshToken);
    } catch (refreshErr) {
      console.error("[CRM] Auto-refresh failed:", refreshErr.message);
    }
  }

  return result;
}

function agencyFieldsParam() {
  const fields = [
    config.FIELD_AGENCY_NAME,
    config.FIELD_PORTAL_EMAIL,
    config.FIELD_CREDENTIAL,
    "Account_Name",
  ];
  return [...new Set(fields)].join(",");
}

async function findAgencyByEmail(accessToken, email) {
  const criteria = `(${config.AGENCY_EMAIL_FIELD}:equals:${email})`;
  const path =
    `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}/search` +
    `?criteria=${encodeURIComponent(criteria)}` +
    `&fields=${encodeURIComponent(agencyFieldsParam())}`;
  const result = await crmRequest(accessToken, "GET", path);
  if (result.status === 204 || !result.data || !result.data.data) {
    return null;
  }
  return result.data.data[0] || null;
}

async function getAgencyById(accessToken, id) {
  const path =
    `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}/${id}` +
    `?fields=${encodeURIComponent(agencyFieldsParam())}`;
  const result = await crmRequest(accessToken, "GET", path);
  return result.data?.data?.[0] || null;
}

async function enableResetApiLink(accessToken, agencyId) {
  const path = `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}`;
  const body = {
    data: [
      {
        id: agencyId,
        [config.FIELD_RESET_API_LINK]: true,
      },
    ],
    trigger: ["workflow"],
  };
  const result = await crmRequest(accessToken, "PUT", path, body);
  const row = result.data?.data?.[0];
  const ok =
    result.status < 400 &&
    row &&
    (row.status === "success" || row.code === "SUCCESS");
  return { ...result, ok, row };
}

async function updateAgencyPassword(accessToken, agencyId, newPassword) {
  const path = `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}`;
  const body = {
    data: [
      {
        id: agencyId,
        [config.FIELD_CREDENTIAL]: newPassword,
      },
    ],
  };
  const result = await crmRequest(accessToken, "PUT", path, body);
  const row = result.data?.data?.[0];
  const ok =
    result.status < 400 &&
    row &&
    (row.status === "success" || row.code === "SUCCESS");
  return { ...result, ok, row };
}

// extraFields: optional plain fields (e.g. { Description: "PORTAL_PENDING::..." }) merged
// into the same PUT body so the Deluge trigger and the stamp are a single atomic write.
async function updateAgencySelectedTherapists(accessToken, agencyId, therapistIds, existingAccountData = null, extraFields = {}) {
  const path = `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}`;
  const fieldName = config.FIELD_SELECTED_THERAPISTS;

  const targetIds = new Set(
    (Array.isArray(therapistIds) ? therapistIds : [])
      .map((id) => (typeof id === "object" && id.id ? String(id.id) : String(id)))
      .filter(Boolean)
  );

  // 1. Check existing Multi-Select Lookup linking records
  let currentLinks = [];
  if (existingAccountData && Array.isArray(existingAccountData[fieldName])) {
    currentLinks = existingAccountData[fieldName];
  } else {
    try {
      const accRes = await crmRequest(
        accessToken,
        "GET",
        `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}/${encodeURIComponent(agencyId)}`
      );
      const accountData = accRes.data?.data?.[0] || {};
      currentLinks = Array.isArray(accountData[fieldName]) ? accountData[fieldName] : [];
    } catch (err) {
      console.warn("[send-credentials] Could not fetch current account links, proceeding with direct association:", err.message);
    }
  }

  const operations = [];
  const alreadyLinkedTherapistIds = new Set();

  // Handle existing linking records (preserve active ones, unlink unselected ones)
  for (const link of currentLinks) {
    const linkedContactObj =
      link[fieldName] && typeof link[fieldName] === "object" ? link[fieldName] : link;
    const contactId = linkedContactObj?.id ? String(linkedContactObj.id) : null;
    const junctionId = link.id ? String(link.id) : null;

    if (contactId && targetIds.has(contactId)) {
      alreadyLinkedTherapistIds.add(contactId);
      if (junctionId) {
        operations.push({ id: junctionId });
      }
    } else if (junctionId) {
      operations.push({ _delete: null, id: junctionId });
    }
  }

  // Add new links for target IDs not yet linked
  for (const tid of targetIds) {
    if (!alreadyLinkedTherapistIds.has(tid)) {
      operations.push({
        [fieldName]: { id: tid },
      });
    }
  }

  // Merge extraFields (e.g. Description stamp) so the trigger + stamp are one atomic write
  const body = {
    data: [
      {
        id: agencyId,
        [fieldName]: operations,
        ...extraFields,
      },
    ],
    trigger: ["workflow"],
  };

  console.log(`[send-credentials] Updating CRM Accounts (${agencyId}) field ${fieldName}:`, JSON.stringify(body));
  let result = await crmRequest(accessToken, "PUT", path, body);
  console.log(`[send-credentials] CRM Response:`, result.status, JSON.stringify(result.data));

  let row = result.data?.data?.[0];
  let ok =
    result.status < 400 &&
    row &&
    (row.status === "success" || row.code === "SUCCESS");

  // Fallback: If linking module failed, attempt direct array of objects.
  // extraFields (e.g. Description stamp) MUST be included here too so the
  // pending marker is always present even when the fallback path is taken.
  if (!ok && operations.length > 0) {
    const fallbackObjects = Array.from(targetIds).map((id) => ({ id }));
    const fallbackBody = {
      data: [
        {
          id: agencyId,
          [fieldName]: fallbackObjects,
          ...extraFields,
        },
      ],
      trigger: ["workflow"],
    };

    console.log(`[send-credentials] Retrying with direct array of objects:`, JSON.stringify(fallbackBody));
    result = await crmRequest(accessToken, "PUT", path, fallbackBody);
    console.log(`[send-credentials] CRM Fallback Response:`, result.status, JSON.stringify(result.data));
    row = result.data?.data?.[0];
    ok =
      result.status < 400 &&
      row &&
      (row.status === "success" || row.code === "SUCCESS");
  }

  return { ...result, ok, row, responseData: result.data };
}

async function clearAgencySelectedTherapists(accessToken, agencyId) {
  const path = `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}`;
  const fieldName = config.FIELD_SELECTED_THERAPISTS;

  try {
    const accRes = await crmRequest(
      accessToken,
      "GET",
      `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}/${encodeURIComponent(agencyId)}`
    );
    const accountData = accRes.data?.data?.[0] || {};
    const currentLinks = Array.isArray(accountData[fieldName]) ? accountData[fieldName] : [];

    if (currentLinks.length === 0) {
      return { ok: true, count: 0 };
    }

    const deleteOperations = currentLinks
      .filter((link) => link.id)
      .map((link) => ({ _delete: null, id: String(link.id) }));

    if (deleteOperations.length === 0) {
      return { ok: true, count: 0 };
    }

    const body = {
      data: [
        {
          id: agencyId,
          [fieldName]: deleteOperations,
        },
      ],
    };

    console.log(`[send-credentials] Clearing ${fieldName} for Agency ${agencyId}...`);
    const res = await crmRequest(accessToken, "PUT", path, body);
    console.log(`[send-credentials] Clear response:`, res.status, JSON.stringify(res.data));
    return res;
  } catch (err) {
    console.warn(`[send-credentials] Failed to clear ${fieldName}:`, err.message);
  }
}

function pickAgencyDetails(agency) {
  if (!agency) {
    return null;
  }
  const agencyName =
    agency[config.FIELD_AGENCY_NAME] ||
    agency.Agency_Name ||
    agency.Account_Name ||
    agency.Name ||
    null;
  const portalEmail =
    agency[config.FIELD_PORTAL_EMAIL] ||
    agency.Portal_Access_Email ||
    agency[config.AGENCY_EMAIL_FIELD] ||
    null;
  const credential =
    agency[config.FIELD_CREDENTIAL] || agency.Credential || null;

  return {
    id: agency.id,
    agencyName,
    portalAccessEmail: portalEmail,
    credential,
    name: agencyName,
    email: portalEmail,
  };
}

function getRecordCredential(agency) {
  return String(
    agency?.[config.FIELD_CREDENTIAL] ?? agency?.Credential ?? ""
  ).trim();
}

// --- Routes ---

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "agency_api",
    crmConnected: Boolean(
      config.REFRESH_TOKEN && !config.REFRESH_TOKEN.includes("YOUR_REFRESH")
    ),
  });
});

app.get("/api/config", (_req, res) => {
  res.status(200).json({
    formEmbedUrl: config.ZOHO_FORM_EMBED_URL,
    agencyModule: config.AGENCY_MODULE,
  });
});

/**
 * One-time admin step: connect Zoho CRM with consent.
 * Copy the returned refresh token into .env as ZOHO_REFRESH_TOKEN.
 */
app.get("/auth/zoho-connect", (req, res) => {
  if (!config.CLIENT_ID) {
    return res.status(500).send(
      "ZOHO_CLIENT_ID is not configured for this Catalyst environment. " +
      "Open Console → switch to Production → Functions → agency_api → " +
      "Configuration → Environment Variables, then add ZOHO_CLIENT_ID " +
      "(and the other ZOHO_* keys). Development and Production each need their own env vars."
    );
  }

  const redirectUri = getRedirectUri(req);
  const authUrl =
    `${config.ACCOUNTS_HOST}/oauth/v2/auth` +
    `?scope=${encodeURIComponent(config.OAUTH_SCOPES)}` +
    `&client_id=${encodeURIComponent(config.CLIENT_ID)}` +
    `&response_type=code` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { code, error, error_description: errorDescription } = req.query;
    if (error) {
      return res.status(400).send(errorDescription || error);
    }
    if (!code) {
      return res.status(400).send("Missing OAuth code");
    }

    try {
      catalyst.initialize(req);
    } catch (initErr) {
      console.warn("Catalyst initialize warning:", initErr.message);
    }

    const tokens = await exchangeCodeForTokens(code, getRedirectUri(req));
    const refreshToken = tokens.refresh_token || "(no refresh_token returned — revoke app access and retry with prompt=consent)";

    res
      .status(200)
      .type("html")
      .send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Zoho connected</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:3rem auto;padding:0 1rem;line-height:1.5}
  code,textarea{display:block;width:100%;box-sizing:border-box;margin:1rem 0;padding:0.75rem;font-size:0.9rem}
  textarea{min-height:5rem}
</style></head><body>
  <h1>Zoho CRM connected</h1>
  <p>Paste this into your project <code>.env</code> file, then restart <code>catalyst serve</code>:</p>
  <textarea readonly>ZOHO_REFRESH_TOKEN=${refreshToken}</textarea>
  <p>Then open <a href="/app/index.html">Agency Portal login</a>.</p>
</body></html>`);
  } catch (err) {
    console.error("auth/callback error:", err.response?.data || err);
    res.status(500).send(err.response?.data?.error || err.message || "OAuth failed");
  }
});

/**
 * Portal login: Portal Access Email + Credential from CRM Accounts.
 */
app.post("/auth/login", async (req, res) => {
  try {
    const portalEmail = String(
      req.body.portalEmail || req.body.email || ""
    ).trim();
    const credential = String(req.body.credential || req.body.password || "").trim();

    if (!portalEmail || !credential) {
      return res.status(400).json({
        message: "Portal Access Email and Credential are required",
      });
    }

    const accessToken = await getOrgAccessToken(req);
    const agency = await findAgencyByEmail(accessToken, portalEmail);

    if (!agency || !safeEqual(getRecordCredential(agency), credential)) {
      return res.status(401).json({
        message: "Invalid Portal Access Email or Credential",
      });
    }

    const details = pickAgencyDetails(agency);
    setSessionCookie(
      res,
      {
        email: details.portalAccessEmail,
        agency_id: agency.id,
        agency_name: details.agencyName || details.portalAccessEmail,
        display_name: details.agencyName || details.portalAccessEmail,
      },
      req
    );

    return res.status(200).json({
      ok: true,
      redirectTo: "/app/dashboard.html",
      agency: {
        id: details.id,
        agencyName: details.agencyName,
        portalAccessEmail: details.portalAccessEmail,
      },
    });
  } catch (err) {
    console.error("/auth/login error:", err.response?.data || err);
    res.status(500).json({
      message: err.message || "Login failed",
    });
  }
});

/**
 * Forgot password: find Accounts by Portal Access Email and enable
 * the Reset API Link checkbox so CRM can send the reset flow.
 */
app.post("/auth/forgot-password", async (req, res) => {
  const friendlyOk =
    "Please check your inbox to reset your password.";
  const friendlyFail =
    "We couldn’t start the password reset right now. Please try again in a few minutes.";

  try {
    const portalEmail = String(
      req.body.portalEmail || req.body.email || ""
    ).trim();

    if (!portalEmail) {
      return res.status(400).json({
        message: "Please enter your Portal Access Email.",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(portalEmail)) {
      return res.status(400).json({
        message: "Please enter a valid email address.",
      });
    }

    const accessToken = await getOrgAccessToken(req);
    const agency = await findAgencyByEmail(accessToken, portalEmail);

    if (!agency) {
      return res.status(404).json({
        ok: false,
        message: "No profile found with this email in our records.",
      });
    }

    const update = await enableResetApiLink(accessToken, agency.id);
    if (!update.ok) {
      console.error("Reset checkbox update failed:", update.data);
      return res.status(502).json({
        message: friendlyFail,
      });
    }

    return res.status(200).json({
      ok: true,
      message: friendlyOk,
    });
  } catch (err) {
    console.error("/auth/forgot-password error:", err.response?.data || err);
    res.status(500).json({
      message: friendlyFail,
    });
  }
});

/**
 * Reset password: verify current password & update new password in Zoho CRM.
 */
app.post("/auth/reset-password", async (req, res) => {
  try {
    const portalEmail = String(
      req.body.portalEmail || req.body.email || ""
    ).trim();
    const currentPassword = String(req.body.currentPassword || "").trim();
    const newPassword = String(req.body.newPassword || "").trim();

    if (!portalEmail) {
      return res.status(400).json({
        message: "Please enter your Portal Access Email.",
      });
    }

    if (!currentPassword) {
      return res.status(400).json({
        message: "Please enter your current password.",
      });
    }

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        message: "New password must be at least 6 characters long.",
      });
    }

    const accessToken = await getOrgAccessToken(req);
    const agency = await findAgencyByEmail(accessToken, portalEmail);

    if (!agency) {
      return res.status(404).json({
        ok: false,
        message: "No profile found with this email in our records.",
      });
    }

    if (!safeEqual(getRecordCredential(agency), currentPassword)) {
      return res.status(401).json({
        ok: false,
        message: "Current password is incorrect.",
      });
    }

    const update = await updateAgencyPassword(accessToken, agency.id, newPassword);
    if (!update.ok) {
      console.error("Password update in CRM failed:", update.data);
      return res.status(502).json({
        message: "Failed to update password. Please try again later.",
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Password updated successfully. You can now sign in.",
    });
  } catch (err) {
    console.error("/auth/reset-password error:", err.response?.data || err);
    res.status(500).json({
      message: err.message || "Failed to update password.",
    });
  }
});

/**
 * Change password (authenticated session): verify current password & update in Zoho CRM.
 */
app.post("/api/change-password", async (req, res) => {
  try {
    const session = requireSession(req, res);
    if (!session) {
      return;
    }

    const currentPassword = String(req.body.currentPassword || "").trim();
    const newPassword = String(req.body.newPassword || "").trim();

    if (!currentPassword) {
      return res.status(400).json({
        message: "Please enter your current password.",
      });
    }

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        message: "New password must be at least 6 characters long.",
      });
    }

    const accessToken = await getOrgAccessToken(req);
    let agency = await getAgencyById(accessToken, session.agency_id);
    if (!agency) {
      agency = await findAgencyByEmail(accessToken, session.email);
    }

    if (!agency) {
      return res.status(404).json({
        message: "Agency record not found in CRM.",
      });
    }

    if (!safeEqual(getRecordCredential(agency), currentPassword)) {
      return res.status(401).json({
        message: "Current password is incorrect.",
      });
    }

    const update = await updateAgencyPassword(accessToken, agency.id, newPassword);
    if (!update.ok) {
      console.error("Password change in CRM failed:", update.data);
      return res.status(502).json({
        message: "Failed to update password. Please try again later.",
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Password changed successfully.",
    });
  } catch (err) {
    console.error("/api/change-password error:", err.response?.data || err);
    res.status(500).json({
      message: err.message || "Failed to change password.",
    });
  }
});

app.post("/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
});

app.get("/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.redirect(`${getAppBaseUrl(req)}/app/index.html`);
});

app.get("/api/me", async (req, res) => {
  try {
    const session = requireSession(req, res);
    if (!session) {
      return;
    }

    const accessToken = await getOrgAccessToken(req);
    let agency = await getAgencyById(accessToken, session.agency_id);
    if (!agency) {
      agency = await findAgencyByEmail(accessToken, session.email);
    }

    if (!agency) {
      clearSessionCookie(res);
      return res.status(403).json({
        message: "Accounts record no longer available for this login",
      });
    }

    const details = pickAgencyDetails(agency);
    res.status(200).json({
      user: {
        email: session.email,
        displayName: session.display_name || details.agencyName || session.email,
      },
      agency: details,
      formEmbedUrl: config.ZOHO_FORM_EMBED_URL,
    });
  } catch (err) {
    console.error("/api/me error:", err.response?.data || err);
    res.status(500).json({
      message: "Failed to load agency details",
      error: err.message,
    });
  }
});

app.get("/api/patients", async (req, res) => {
  try {
    const session = requireSession(req, res);
    if (!session) {
      return;
    }

    const accessToken = await getOrgAccessToken(req);
    const agencyId = session.agency_id;

    const fields = [
      "Deal_Name",
      "DOB",
      "Gender",
      "Patient_s_Phone_1",
      "Street",
      "Stage",
      "Start_Day_Of_Certification",
      "Last_Day_of_Cert",
      "Tag",
      "Owner",
      "Account_Name",
      "Created_Time",
      "id",
    ].join(",");

    let deals = [];

    // 1. Primary lookup: Search Deals by Account_Name
    try {
      const searchPath =
        `/crm/v3/Deals/search` +
        `?criteria=${encodeURIComponent(`(Account_Name:equals:${agencyId})`)}` +
        `&fields=${encodeURIComponent(fields)}`;
      const searchRes = await crmRequest(accessToken, "GET", searchPath);
      if (searchRes.status === 200 && Array.isArray(searchRes.data?.data)) {
        deals = searchRes.data.data;
      }
    } catch (searchErr) {
      console.warn("Deals search error, attempting related list lookup:", searchErr.message);
    }

    // 2. Fallback: Lookup Deals related to Account
    if (!deals.length) {
      try {
        const relPath =
          `/crm/v3/Accounts/${encodeURIComponent(agencyId)}/Deals` +
          `?fields=${encodeURIComponent(fields)}`;
        const relRes = await crmRequest(accessToken, "GET", relPath);
        if (relRes.status === 200 && Array.isArray(relRes.data?.data)) {
          deals = relRes.data.data;
        }
      } catch (relErr) {
        console.warn("Accounts Deals related list lookup:", relErr.message);
      }
    }

    const patients = deals.map((d) => ({
      id: d.id,
      patientName: d.Deal_Name || "—",
      dob: d.DOB || "—",
      gender: d.Gender || "—",
      phone: d.Patient_s_Phone_1 || "—",
      street: d.Street || "—",
      stage: d.Stage || "Pending",
      startCert: d.Start_Day_Of_Certification || "—",
      lastCert: d.Last_Day_of_Cert || "—",
      tags: Array.isArray(d.Tag)
        ? d.Tag.map((t) => (typeof t === "object" ? t.name : t))
        : [],
      owner: d.Owner?.name || "Eagle Creek Therapy",
      accountName: d.Account_Name?.name || session.display_name,
      createdTime: d.Created_Time || null,
    }));

    res.status(200).json({
      ok: true,
      count: patients.length,
      patients,
    });
  } catch (err) {
    console.error("/api/patients error:", err.response?.data || err);
    res.status(500).json({
      message: "Failed to fetch patient referral records",
      error: err.message,
    });
  }
});

const workDriveFilesCache = new Map();
const WORKDRIVE_CACHE_TTL_MS = 5 * 60 * 1000;

// forceFresh=true bypasses the 5-min cache — used during send-credentials
// pre-screening so newly uploaded WorkDrive files are always visible.
async function fetchWorkDriveFolderFiles(accessToken, folderId, forceFresh = false) {
  if (!folderId || folderId === "—" || folderId.toLowerCase() === "null" || folderId.toLowerCase() === "undefined") {
    return [];
  }

  const cleanFolderId = folderId.trim();

  // Check in-memory cache (skipped when forceFresh is true)
  const cached = workDriveFilesCache.get(cleanFolderId);
  if (!forceFresh && cached && Date.now() - cached.timestamp < WORKDRIVE_CACHE_TTL_MS) {
    return cached.files;
  }

  // Helper to extract and normalize file objects
  function normalizeFileList(rawList) {
    if (!Array.isArray(rawList) || rawList.length === 0) return null;
    return rawList.map((f) => {
      const attr = f.attributes || f;
      const fileId = f.id || attr.id || attr.resource_id || attr.resourceId || "";
      const fileName = attr.name || attr.file_name || attr.filename || f.name || "document";
      const extn = attr.extn || attr.extension || (fileName.includes(".") ? fileName.split(".").pop() : "");
      const size = attr.storage_info?.size || attr.size_in_bytes || attr.size || null;
      const downloadUrl = fileId
        ? `https://www.zohoapis.com/workdrive/api/v1/download/${fileId}`
        : (attr.download_url || attr.downloadUrl || null);
      const createdTime = attr.created_time || attr.createdTime || null;
      const modifiedTime = attr.modified_time || attr.modifiedTime || null;

      return {
        id: fileId,
        name: fileName,
        extn: extn,
        size: size,
        downloadUrl: downloadUrl,
        createdTime: createdTime,
        modifiedTime: modifiedTime,
        attributes: f.attributes || undefined,
      };
    });
  }

  // 1. Try Zoho CRM WorkDrive Connector API (GET & POST)
  try {
    const connectorBase = `https://crm.zoho.com/market/api/connectorAPI/execute.do`;
    const connectorUrl = `${connectorBase}?nameSpace=zohocrmforzohoworkdrive.zohoworkdriveconnector.listfolderfiles0&folder_id=${encodeURIComponent(cleanFolderId)}&folderId=${encodeURIComponent(cleanFolderId)}`;

    const connectorRes = await axios.get(connectorUrl, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        Accept: "application/json",
      },
      timeout: 8000,
    });

    let list = null;
    if (Array.isArray(connectorRes.data)) list = connectorRes.data;
    else if (Array.isArray(connectorRes.data?.data)) list = connectorRes.data.data;
    else if (Array.isArray(connectorRes.data?.files)) list = connectorRes.data.files;
    else if (Array.isArray(connectorRes.data?.response)) list = connectorRes.data.response;
    else if (typeof connectorRes.data?.response === "string") {
      try {
        const parsed = JSON.parse(connectorRes.data.response);
        list = Array.isArray(parsed?.data) ? parsed.data : (Array.isArray(parsed) ? parsed : null);
      } catch { }
    }

    const normalized = normalizeFileList(list);
    if (normalized && normalized.length > 0) {
      return normalized;
    }
  } catch (connectorErr) {
    console.warn(`[WorkDrive] Connector API GET failed for folder ${cleanFolderId}:`, connectorErr.response?.data || connectorErr.message);
  }

  // Try Connector API POST
  try {
    const connectorUrl = `https://crm.zoho.com/market/api/connectorAPI/execute.do?nameSpace=zohocrmforzohoworkdrive.zohoworkdriveconnector.listfolderfiles0`;
    const connectorPostRes = await axios.post(
      connectorUrl,
      { folder_id: cleanFolderId, folderId: cleanFolderId },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 8000,
      }
    );

    let list = null;
    if (Array.isArray(connectorPostRes.data)) list = connectorPostRes.data;
    else if (Array.isArray(connectorPostRes.data?.data)) list = connectorPostRes.data.data;
    else if (Array.isArray(connectorPostRes.data?.files)) list = connectorPostRes.data.files;
    else if (Array.isArray(connectorPostRes.data?.response)) list = connectorPostRes.data.response;

    const normalized = normalizeFileList(list);
    if (normalized && normalized.length > 0) {
      return normalized;
    }
  } catch (postErr) {
    // continue to REST API
  }

  // 2. Direct WorkDrive REST API (files & folders endpoints across domains)
  const hosts = ["www.zohoapis.com", "workdrive.zoho.com"];
  const paths = [
    `/workdrive/api/v1/files/${encodeURIComponent(cleanFolderId)}/files`,
    `/workdrive/api/v1/folders/${encodeURIComponent(cleanFolderId)}/files`,
    `/api/v1/files/${encodeURIComponent(cleanFolderId)}/files`,
  ];

  for (const host of hosts) {
    for (const path of paths) {
      try {
        const wdUrl = `https://${host}${path}`;
        const wdRes = await axios.get(wdUrl, {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            Accept: "application/vnd.api+json",
          },
          timeout: 8000,
        });

        const filesData = wdRes.data?.data || wdRes.data?.files || (Array.isArray(wdRes.data) ? wdRes.data : null);
        const normalized = normalizeFileList(filesData);
        if (normalized && normalized.length > 0) {
          workDriveFilesCache.set(cleanFolderId, { files: normalized, timestamp: Date.now() });
          return normalized;
        }
      } catch (wdErr) {
        // continue trying next path/host
      }
    }
  }

  workDriveFilesCache.set(cleanFolderId, { files: [], timestamp: Date.now() });
  return [];
}

app.get("/api/therapists", async (req, res) => {
  try {
    const session = requireSession(req, res);
    if (!session) {
      return;
    }

    const accessToken = await getOrgAccessToken(req);
    const agencyId = session.agency_id;
    const searchQuery = (req.query.search || req.query.q || "").trim();
    let disciplineQuery = (req.query.discipline || "").trim().toUpperCase();

    // Discipline matcher with strict ST vs STA separation
    function matchDisciplineCode(recordDisc, filterDisc) {
      if (!filterDisc || filterDisc === "ALL") return true;
      const rd = (recordDisc || "").trim().toUpperCase();
      const fd = filterDisc.trim().toUpperCase();
      if (fd === "NONE") {
        return !rd || rd === "—" || rd === "-" || rd === "NONE" || rd === "N/A" || rd === "NULL" || rd === "UNDEFINED";
      }
      if (fd === "STA") {
        return (
          rd === "STA" ||
          rd === "SLPA" ||
          /\bSTA\b/.test(rd) ||
          /\bSLPA\b/.test(rd) ||
          rd.includes("SPEECH THERAPY ASSISTANT") ||
          rd.includes("SPEECH LANGUAGE PATHOLOGY ASSISTANT") ||
          (rd.includes("SPEECH") && (rd.includes("ASSISTANT") || rd.includes("ASST")))
        );
      }
      if (fd === "ST") {
        if (
          rd === "STA" ||
          rd === "SLPA" ||
          /\bSTA\b/.test(rd) ||
          /\bSLPA\b/.test(rd) ||
          (rd.includes("SPEECH") && (rd.includes("ASSISTANT") || rd.includes("ASST")))
        ) {
          return false;
        }
        return (
          rd === "ST" ||
          rd === "SLP" ||
          /\bST\b/.test(rd) ||
          /\bSLP\b/.test(rd) ||
          rd.includes("SPEECH THERAPIST") ||
          rd.includes("SPEECH LANGUAGE PATHOLOGIST") ||
          (rd.includes("SPEECH") && !rd.includes("ASSISTANT"))
        );
      }
      if (fd === "PT") {
        if (rd === "PTA" || /\bPTA\b/.test(rd) || (rd.includes("PHYSICAL") && (rd.includes("ASSISTANT") || rd.includes("ASST")))) return false;
        return rd === "PT" || /\bPT\b/.test(rd) || (rd.includes("PHYSICAL") && !rd.includes("ASSISTANT"));
      }
      if (fd === "PTA") {
        return rd === "PTA" || /\bPTA\b/.test(rd) || (rd.includes("PHYSICAL") && (rd.includes("ASSISTANT") || rd.includes("ASST")));
      }
      if (fd === "OT") {
        if (rd === "COTA" || /\bCOTA\b/.test(rd) || (rd.includes("OCCUPATIONAL") && (rd.includes("ASSISTANT") || rd.includes("ASST")))) return false;
        return rd === "OT" || /\bOT\b/.test(rd) || (rd.includes("OCCUPATIONAL") && !rd.includes("ASSISTANT"));
      }
      if (fd === "COTA") {
        return rd === "COTA" || /\bCOTA\b/.test(rd) || (rd.includes("OCCUPATIONAL") && (rd.includes("ASSISTANT") || rd.includes("ASST")));
      }
      if (fd === "MSW") {
        return rd.includes("MSW") || rd.includes("SOCIAL");
      }
      return rd === fd;
    }

    function detectDisciplineQuery(query) {
      if (!query) return null;
      const q = query.trim().toLowerCase();

      // STA / Speech Therapy Assistant
      if (
        q === "sta" ||
        q === "slpa" ||
        q === "speech therapy assistant" ||
        q === "speech therapist assistant" ||
        q === "speech assistant" ||
        q.includes("speech therapy assistant") ||
        q.includes("speech assistant")
      ) {
        return "STA";
      }

      // ST / Speech Therapist / Speech Therapy
      if (
        q === "st" ||
        q === "slp" ||
        q === "speech" ||
        q === "speech therapist" ||
        q === "speech therapy" ||
        q === "speech language pathologist" ||
        q === "speech pathologist" ||
        (q.includes("speech") && !q.includes("assistant"))
      ) {
        return "ST";
      }

      // PTA / Physical Therapist Assistant
      if (
        q === "pta" ||
        q === "physical therapist assistant" ||
        q === "physical therapy assistant" ||
        q === "physical assistant" ||
        q.includes("physical therapy assistant") ||
        q.includes("physical therapist assistant")
      ) {
        return "PTA";
      }

      // PT / Physical Therapist / Physical Therapy
      if (
        q === "pt" ||
        q === "physical" ||
        q === "physical therapist" ||
        q === "physical therapy" ||
        (q.includes("physical") && !q.includes("assistant"))
      ) {
        return "PT";
      }

      // COTA / Occupational Therapy Assistant
      if (
        q === "cota" ||
        q === "ota" ||
        q === "occupational therapy assistant" ||
        q === "occupational therapist assistant" ||
        q === "certified occupational therapy assistant" ||
        q.includes("occupational therapy assistant") ||
        q.includes("occupational therapist assistant")
      ) {
        return "COTA";
      }

      // OT / Occupational Therapist / Occupational Therapy
      if (
        q === "ot" ||
        q === "occupational" ||
        q === "occupational therapist" ||
        q === "occupational therapy" ||
        (q.includes("occupational") && !q.includes("assistant"))
      ) {
        return "OT";
      }

      // MSW / Medical Social Worker
      if (
        q === "msw" ||
        q === "medical social worker" ||
        q === "social worker" ||
        q === "social work" ||
        q.includes("medical social worker") ||
        q.includes("social worker")
      ) {
        return "MSW";
      }

      return null;
    }

    function getDisciplineAliases(discCode) {
      const code = (discCode || "").trim().toUpperCase();
      switch (code) {
        case "PT":
          return ["PT", "Physical Therapy", "Physical Therapist"];
        case "PTA":
          return ["PTA", "Physical Therapy Assistant", "Physical Therapist Assistant"];
        case "OT":
          return ["OT", "Occupational Therapy", "Occupational Therapist"];
        case "COTA":
          return ["COTA", "Occupational Therapy Assistant", "Certified Occupational Therapy Assistant"];
        case "ST":
          return ["ST", "Speech Therapy", "Speech Therapist", "Speech-Language Pathologist", "Speech Language Pathologist"];
        case "STA":
          return ["STA", "Speech Therapy Assistant", "Speech-Language Pathology Assistant", "Speech Language Pathology Assistant", "SLPA"];
        case "MSW":
          return ["MSW", "Medical Social Worker"];
        default:
          return [code];
      }
    }

    function buildEqualsCriteria(field, values) {
      if (!values || values.length === 0) return "";
      let expr = `(${field}:equals:${values[0]})`;
      for (let i = 1; i < values.length; i++) {
        expr = `(${expr}or(${field}:equals:${values[i]}))`;
      }
      return expr;
    }

    // Automatically detect discipline from search query if not provided explicitly
    const detectedSearchDisc = detectDisciplineQuery(searchQuery);
    if ((!disciplineQuery || disciplineQuery === "ALL") && detectedSearchDisc) {
      disciplineQuery = detectedSearchDisc;
    }

    const fields = [
      "Full_Name",
      "First_Name",
      "Last_Name",
      "Email",
      "Phone",
      "Discipline",
      "Mailing_Street",
      "Mailing_City",
      "Mailing_State",
      "Mailing_Zip",
      "Mailing_Address_Line_2",
      "Layout",
      "Created_Time",
      "Owner",
      "Account_Name",
      "Status",
      "License_Number",
      "License",
      "State_License",
      "zohocrmforzohoworkdrive__Work_Drive_Files",
      "id",
    ].join(",");

    let records = [];
    const contactRoleMap = new Map();
    let actualAgencyName = session.agency_name || session.display_name || "";
    if (actualAgencyName === session.email) {
      actualAgencyName = "";
    }

    if (searchQuery || (disciplineQuery && disciplineQuery !== "ALL")) {
      // 1. Global search across ALL agencies for matching Supervisors and Assistants
      const targetDisc = (disciplineQuery && disciplineQuery !== "ALL") ? disciplineQuery : detectedSearchDisc;

      if (targetDisc) {
        const aliases = getDisciplineAliases(targetDisc);
        try {
          const critClause = buildEqualsCriteria("Discipline", aliases);
          const critPath =
            `/crm/v3/Contacts/search` +
            `?criteria=${encodeURIComponent(critClause)}` +
            `&fields=${encodeURIComponent(fields)}&per_page=200`;
          const critRes = await crmRequest(accessToken, "GET", critPath);
          if (critRes.status === 200 && Array.isArray(critRes.data?.data)) {
            records.push(...critRes.data.data);
          }
        } catch (critErr) {
          console.warn("Contacts discipline criteria search error:", critErr.message);
        }

        // Secondary fallback: word search for discipline keywords
        if (records.length < 10) {
          const wordsToTry = [targetDisc];
          if (targetDisc === "PT") wordsToTry.push("Physical");
          if (targetDisc === "ST") wordsToTry.push("Speech");
          if (targetDisc === "OT") wordsToTry.push("Occupational");
          if (targetDisc === "MSW") wordsToTry.push("Social");

          for (const w of wordsToTry) {
            try {
              const wordPath =
                `/crm/v3/Contacts/search` +
                `?word=${encodeURIComponent(w)}` +
                `&fields=${encodeURIComponent(fields)}&per_page=200`;
              const wordRes = await crmRequest(accessToken, "GET", wordPath);
              if (wordRes.status === 200 && Array.isArray(wordRes.data?.data)) {
                records.push(...wordRes.data.data);
              }
            } catch (wErr) {
              console.warn(`Contacts word search for ${w} error:`, wErr.message);
            }
          }
        }
      }

      // If user typed a search query with non-discipline keywords
      const searchTerms = searchQuery
        ? (detectedSearchDisc ? searchQuery.replace(new RegExp(`\\b${detectedSearchDisc}\\b`, "gi"), "").trim() : searchQuery)
        : "";

      if (searchTerms && searchTerms.length >= 2) {
        try {
          const searchPath =
            `/crm/v3/Contacts/search` +
            `?word=${encodeURIComponent(searchTerms)}` +
            `&fields=${encodeURIComponent(fields)}&per_page=200`;
          const searchRes = await crmRequest(accessToken, "GET", searchPath);
          if (searchRes.status === 200 && Array.isArray(searchRes.data?.data)) {
            records.push(...searchRes.data.data);
          }
        } catch (searchErr) {
          console.warn("Contacts word search error, trying criteria search:", searchErr.message);
        }

        if (!records || records.length === 0) {
          try {
            const critClause = `((Full_Name:contains:${searchTerms})or(First_Name:contains:${searchTerms})or(Last_Name:contains:${searchTerms})or(Email:contains:${searchTerms}))`;
            const critPath =
              `/crm/v3/Contacts/search` +
              `?criteria=${encodeURIComponent(critClause)}` +
              `&fields=${encodeURIComponent(fields)}&per_page=200`;
            const critRes = await crmRequest(accessToken, "GET", critPath);
            if (critRes.status === 200 && Array.isArray(critRes.data?.data)) {
              records.push(...critRes.data.data);
            }
          } catch (critErr) {
            console.warn("Contacts criteria search error:", critErr.message);
          }
        }
      }
    } else {
      // 2. Fetch all "Assistant" and "Supervisor" therapists from all Therapies of the logged-in agency
      try {
        let therapyPage = 1;
        let hasMoreTherapies = true;
        const maxTherapyPages = 10; // Support up to 2,000 therapies
        const therapyFields = "id,Supervisor,Assistant,Supervisor_C,Assistant_C,Discipline,Agency,Agency_Name";

        while (hasMoreTherapies && therapyPage <= maxTherapyPages) {
          const therapyRes = await crmRequest(
            accessToken,
            "GET",
            `/crm/v3/Therapy/search?criteria=${encodeURIComponent(`(Agency:equals:${agencyId})`)}&fields=${encodeURIComponent(therapyFields)}&per_page=200&page=${therapyPage}`
          );

          if (therapyRes.status === 200 && Array.isArray(therapyRes.data?.data)) {
            for (const t of therapyRes.data.data) {
              if (!actualAgencyName) {
                actualAgencyName = t.Agency?.name || t.Agency_Name || "";
              }

              // Extract Supervisor(s)
              const supId = t.Supervisor?.id || t.Supervisor_C?.id;
              if (supId) {
                const sIdStr = String(supId);
                const sName = t.Supervisor?.name || t.Supervisor_C?.name || "";
                if (!sName.toLowerCase().includes("need therapist") && !sName.toLowerCase().includes("na na")) {
                  contactRoleMap.set(sIdStr, "Supervisor");
                }
              }

              // Extract Assistant(s)
              const astId = t.Assistant?.id || t.Assistant_C?.id;
              if (astId) {
                const aIdStr = String(astId);
                const aName = t.Assistant?.name || t.Assistant_C?.name || "";
                if (!aName.toLowerCase().includes("need therapist") && !aName.toLowerCase().includes("na na")) {
                  const currentRole = contactRoleMap.get(aIdStr);
                  contactRoleMap.set(aIdStr, currentRole === "Supervisor" ? "Therapist / Asst" : "Assistant");
                }
              }
            }

            hasMoreTherapies = therapyRes.data.info?.more_records === true;
            therapyPage++;
          } else {
            hasMoreTherapies = false;
          }
        }
      } catch (therapyErr) {
        console.warn("[therapists] Therapy module search error:", therapyErr.message);
      }

      // If agency name still not resolved, query Agency Account
      if (!actualAgencyName) {
        try {
          const accRes = await crmRequest(
            accessToken,
            "GET",
            `/crm/v3/Accounts/${encodeURIComponent(agencyId)}?fields=Account_Name,Agency_Name`
          );
          const accData = accRes.data?.data?.[0];
          if (accData) {
            actualAgencyName = accData.Account_Name || accData.Agency_Name || "";
          }
        } catch (accNameErr) {
          console.warn("[therapists] Agency account name fetch error:", accNameErr.message);
        }
      }

      // Fallback: If no therapists were found from Therapy records, check Account.Therapists
      if (contactRoleMap.size === 0) {
        try {
          const accRes = await crmRequest(accessToken, "GET", `/crm/v3/Accounts/${encodeURIComponent(agencyId)}`);
          const accountData = accRes.data?.data?.[0];
          if (accountData) {
            if (!actualAgencyName) {
              actualAgencyName = accountData.Account_Name || accountData.Agency_Name || "";
            }
            if (Array.isArray(accountData.Therapists)) {
              for (const item of accountData.Therapists) {
                const tObj = item.Therapists && typeof item.Therapists === "object" ? item.Therapists : item;
                const cId = tObj.id || item.id;
                if (cId) {
                  contactRoleMap.set(String(cId), "Therapist");
                }
              }
            }
          }
        } catch (accErr) {
          console.warn("[therapists] Account.Therapists fallback fetch error:", accErr.message);
        }
      }

      // Fetch full Contact details in parallel batches of 50 IDs
      const uniqueContactIds = Array.from(contactRoleMap.keys()).filter((id) => id && id.length > 5);
      if (uniqueContactIds.length > 0) {
        const idChunks = [];
        for (let i = 0; i < uniqueContactIds.length; i += 50) {
          idChunks.push(uniqueContactIds.slice(i, i + 50));
        }

        try {
          const contactDetailsResponses = await Promise.all(
            idChunks.map((chunk) =>
              crmRequest(
                accessToken,
                "GET",
                `/crm/v3/Contacts?ids=${encodeURIComponent(chunk.join(","))}&fields=${encodeURIComponent(fields)}`
              )
            )
          );

          for (const resItem of contactDetailsResponses) {
            if (resItem.status === 200 && Array.isArray(resItem.data?.data)) {
              records.push(...resItem.data.data);
            }
          }
        } catch (detailsErr) {
          console.warn("[therapists] Batch Contacts details fetch error:", detailsErr.message);
        }
      }
    }

    // 3. Map & Deduplicate records: if multiple records have the same name, email, or ID, show one time
    const therapistList = [];
    const idIndex = new Map();
    const nameIndex = new Map();
    const emailIndex = new Map();
    const namePhoneIndex = new Map();

    for (const c of records) {
      if (!c || !c.id) continue;
      const name = (c.Full_Name || `${c.First_Name || ""} ${c.Last_Name || ""}`).trim().toLowerCase();
      if (name === "need therapist" || name === "na na" || name === "n/a" || name === "unassigned") {
        continue;
      }
      const st = (c.Status || "").trim().toLowerCase();
      if (st && st !== "active") continue;

      const cId = String(c.id).trim();

      const fullName =
        c.Full_Name ||
        `${c.First_Name || ""} ${c.Last_Name || ""}`.trim() ||
        "Therapist";

      const phone = c.Phone || c.Mobile || "—";
      const email = c.Email || "—";
      const status = c.Status || "Active";
      const owner = c.Owner?.name || "Eagle Creek Therapy";

      // Determine role: therapy role map first, then discipline
      const mappedRole = contactRoleMap.get(cId);
      let role = mappedRole;
      if (!role) {
        const disc = (c.Discipline || "").trim().toUpperCase();
        const isAssistant =
          disc === "PTA" ||
          disc === "COTA" ||
          disc === "STA" ||
          disc === "SLPA" ||
          /\bSTA\b/.test(disc) ||
          /\bPTA\b/.test(disc) ||
          /\bCOTA\b/.test(disc) ||
          disc.includes("ASSISTANT") ||
          disc.endsWith("A") ||
          (c.Layout?.name || "").toLowerCase().includes("assistant");
        role = isAssistant ? "Assistant" : "Supervisor";
      }

      const folderId = String(
        c.zohocrmforzohoworkdrive__Work_Drive_Files || ""
      ).trim();

      const addressParts = [
        c.Mailing_Street,
        c.Mailing_Address_Line_2,
        c.Mailing_City,
        c.Mailing_State ? `${c.Mailing_State} ${c.Mailing_Zip || ""}`.trim() : c.Mailing_Zip,
      ].filter(Boolean);

      const locObj = {
        street: c.Mailing_Street || "",
        street2: c.Mailing_Address_Line_2 || "",
        city: c.Mailing_City || "—",
        state: c.Mailing_State || "—",
        zip: c.Mailing_Zip || "—",
        fullAddress: addressParts.length > 0 ? addressParts.join(", ") : "—",
      };

      const isMyAgency = contactRoleMap.has(cId) || c.Account_Name?.id === agencyId;
      const agencyName = isMyAgency
        ? (actualAgencyName || c.Account_Name?.name || "")
        : (c.Account_Name?.name || actualAgencyName || "");

      const licenseVal = c.License_Number || c.License || c.State_License || null;

      // Entity resolution keys
      const cleanEmail = (c.Email || "").trim().toLowerCase();
      const hasValidEmail = Boolean(cleanEmail && cleanEmail !== "—" && cleanEmail !== "-" && cleanEmail.includes("@"));

      const cleanPhone = (c.Phone || c.Mobile || "").replace(/\D/g, "");
      const hasValidPhone = cleanPhone.length >= 7;

      const cleanName = fullName.toLowerCase().replace(/[^a-z0-9]/g, "");
      const isMeaningfulName = Boolean(cleanName && cleanName !== "therapist" && cleanName.length >= 2);

      // Find existing record across multiple matching criteria:
      // Priority: ID -> Same Name -> Same Email -> Same Name + Phone
      let existing = null;
      if (cId && idIndex.has(cId)) {
        existing = idIndex.get(cId);
      } else if (isMeaningfulName && nameIndex.has(cleanName)) {
        existing = nameIndex.get(cleanName);
      } else if (hasValidEmail && emailIndex.has(cleanEmail)) {
        existing = emailIndex.get(cleanEmail);
      } else if (isMeaningfulName && hasValidPhone && namePhoneIndex.has(`${cleanName}|${cleanPhone}`)) {
        existing = namePhoneIndex.get(`${cleanName}|${cleanPhone}`);
      }

      if (!existing) {
        const newTherapist = {
          id: c.id,
          ids: [c.id],
          name: fullName,
          firstName: c.First_Name || "",
          lastName: c.Last_Name || "",
          email,
          emails: hasValidEmail ? [cleanEmail] : [],
          phone,
          phones: hasValidPhone ? [cleanPhone] : [],
          mobile: c.Mobile || "—",
          discipline: c.Discipline || "—",
          disciplines: c.Discipline ? [c.Discipline] : [],
          role,
          agencyName,
          agencies: agencyName ? [agencyName] : [],
          isMyAgency,
          status,
          folderId: folderId || "—",
          address: locObj.fullAddress,
          city: locObj.city,
          state: locObj.state,
          zip: locObj.zip,
          locations: locObj.fullAddress !== "—" ? [locObj] : [],
          licenses: licenseVal ? [licenseVal] : [],
          layout: c.Layout?.display_label || c.Layout?.name || role,
          owner,
          createdTime: c.Created_Time || null,
          files: [],
        };

        therapistList.push(newTherapist);
        idIndex.set(cId, newTherapist);
        if (isMeaningfulName) nameIndex.set(cleanName, newTherapist);
        if (hasValidEmail) emailIndex.set(cleanEmail, newTherapist);
        if (isMeaningfulName && hasValidPhone) namePhoneIndex.set(`${cleanName}|${cleanPhone}`, newTherapist);
      } else {
        // Associate this secondary ID to the existing object
        if (c.id && !existing.ids.includes(c.id)) {
          existing.ids.push(c.id);
        }
        if (cId) idIndex.set(cId, existing);
        if (isMeaningfulName) nameIndex.set(cleanName, existing);
        if (hasValidEmail) {
          emailIndex.set(cleanEmail, existing);
          if (!Array.isArray(existing.emails)) existing.emails = [];
          if (!existing.emails.includes(cleanEmail)) {
            existing.emails.push(cleanEmail);
          }
        }
        if (hasValidPhone) {
          if (!Array.isArray(existing.phones)) existing.phones = [];
          if (!existing.phones.includes(cleanPhone)) {
            existing.phones.push(cleanPhone);
          }
        }
        if (isMeaningfulName && hasValidPhone) namePhoneIndex.set(`${cleanName}|${cleanPhone}`, existing);

        // Aggregate locations
        if (locObj.fullAddress !== "—") {
          const exists = existing.locations.some(
            (l) => (l.fullAddress || "").toLowerCase() === locObj.fullAddress.toLowerCase()
          );
          if (!exists) {
            existing.locations.push(locObj);
          }
        }

        // Aggregate licenses
        if (licenseVal && !existing.licenses.includes(licenseVal)) {
          existing.licenses.push(licenseVal);
        }

        // Aggregate disciplines
        if (c.Discipline && !existing.disciplines.includes(c.Discipline)) {
          existing.disciplines.push(c.Discipline);
          if (existing.discipline === "—") {
            existing.discipline = c.Discipline;
          } else if (!existing.discipline.includes(c.Discipline)) {
            existing.discipline = `${existing.discipline}, ${c.Discipline}`;
          }
        }

        // Aggregate agencies
        if (agencyName && !existing.agencies.includes(agencyName)) {
          existing.agencies.push(agencyName);
        }
        if (isMyAgency) {
          existing.isMyAgency = true;
          existing.agencyName = agencyName || existing.agencyName;
        }

        // Keep best contact info if primary was missing
        if ((!existing.email || existing.email === "—") && email && email !== "—") {
          existing.email = email;
        }
        if ((!existing.phone || existing.phone === "—") && phone && phone !== "—") {
          existing.phone = phone;
        }
        if ((!existing.folderId || existing.folderId === "—") && folderId && folderId !== "—") {
          existing.folderId = folderId;
        }
      }
    }

    let therapists = therapistList;

    // Apply explicit discipline filter if requested
    if (disciplineQuery && disciplineQuery !== "ALL") {
      therapists = therapists.filter((t) => matchDisciplineCode(t.discipline, disciplineQuery));
    }

    // When searching, exclude any contacts without a discipline available (only therapists have disciplines)
    if (searchQuery) {
      therapists = therapists.filter((t) => {
        const d = (t.discipline || "").trim().toUpperCase();
        const hasSingle = Boolean(d && d !== "—" && d !== "-" && d !== "NONE" && d !== "N/A" && d !== "NULL");
        if (hasSingle) return true;
        if (Array.isArray(t.disciplines) && t.disciplines.length > 0) {
          return t.disciplines.some((disc) => {
            const s = String(disc || "").trim().toUpperCase();
            return Boolean(s && s !== "—" && s !== "-" && s !== "NONE" && s !== "N/A" && s !== "NULL");
          });
        }
        return false;
      });
    }

    // If search query has non-discipline keywords, apply text matching on attributes
    const searchFilterText = detectedSearchDisc
      ? searchQuery.replace(new RegExp(`\\b${detectedSearchDisc}\\b`, "gi"), "").trim()
      : searchQuery;

    if (searchFilterText) {
      const qLower = searchFilterText.toLowerCase();

      therapists = therapists.filter((t) => {
        const cleanDigits = qLower.replace(/\D/g, "");
        return (
          (t.name || "").toLowerCase().includes(qLower) ||
          (t.email || "").toLowerCase().includes(qLower) ||
          (Array.isArray(t.emails) && t.emails.some((e) => e.toLowerCase().includes(qLower))) ||
          (t.phone || "").toLowerCase().includes(qLower) ||
          (cleanDigits.length >= 3 && Array.isArray(t.phones) && t.phones.some((p) => p.includes(cleanDigits))) ||
          (t.city || "").toLowerCase().includes(qLower) ||
          (t.zip || "").toLowerCase().includes(qLower) ||
          (t.agencyName || "").toLowerCase().includes(qLower) ||
          (Array.isArray(t.agencies) && t.agencies.some((a) => a.toLowerCase().includes(qLower))) ||
          (Array.isArray(t.locations) && t.locations.some((l) => (l.fullAddress || "").toLowerCase().includes(qLower))) ||
          (Array.isArray(t.licenses) && t.licenses.some((lic) => String(lic).toLowerCase().includes(qLower)))
        );
      });
    }

    res.status(200).json({
      ok: true,
      agencyName: actualAgencyName,
      count: therapists.length,
      therapists,
    });
  } catch (err) {
    console.error("/api/therapists error:", err.response?.data || err);
    res.status(500).json({
      message: "Failed to fetch therapist records",
      error: err.message,
    });
  }
});

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendCrmMail(accessToken, recordId, { toEmail, toName, subject, html }) {
  if (!toEmail) {
    return { ok: false, message: "No recipient email" };
  }
  const fromEmail = process.env.CRM_FROM_EMAIL || "ects@eaglecreektherapy.net";
  const body = {
    data: [
      {
        from: { user_name: "Eagle Creek Therapy", email: fromEmail },
        to: [{ user_name: toName || toEmail, email: toEmail }],
        subject,
        content: html,
        mail_format: "html",
      },
    ],
  };
  try {
    const result = await crmRequest(
      accessToken,
      "POST",
      `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}/${encodeURIComponent(recordId)}/actions/send_mail`,
      body
    );
    const row = result.data?.data?.[0];
    const ok = result.status < 400 && row && (row.status === "success" || row.code === "SUCCESS");
    return { ok, status: result.status, message: row?.message || result.data?.message || "" };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function notifyAgencyOwnerOfMissingCredentials({ req, accessToken, agencyId, missingTherapists, session, accountData = null }) {
  if (!Array.isArray(missingTherapists) || missingTherapists.length === 0) {
    return;
  }

  try {
    let token = accessToken;
    if (!token) {
      token = await getOrgAccessToken(req);
    }

    // 1. Fetch Account and Owner information from CRM if not provided
    let agencyName = accountData?.Account_Name || accountData?.Agency_Name || session?.display_name || "Agency";
    let ownerName = accountData?.Owner?.name || "Eagle Creek Therapy";
    let ownerEmail = accountData?.Owner?.email || null;
    let portalEmail = accountData?.Portal_Access_Email || accountData?.Email || session?.email || null;

    if (!accountData) {
      try {
        const accRes = await crmRequest(
          token,
          "GET",
          `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}/${encodeURIComponent(agencyId)}?fields=Account_Name,Agency_Name,Owner,Portal_Access_Email,Email`
        );
        const acc = accRes.data?.data?.[0];
        if (acc) {
          agencyName = acc.Account_Name || acc.Agency_Name || agencyName;
          if (acc.Owner) {
            ownerName = acc.Owner.name || ownerName;
            ownerEmail = acc.Owner.email || null;
          }
          portalEmail = acc.Portal_Access_Email || acc.Email || portalEmail;
        }
      } catch (accErr) {
        console.warn("[notify-owner] Could not fetch agency details for owner notification:", accErr.message);
      }
    }

    const recipientEmail = ownerEmail || portalEmail || "brooke@eaglecreektherapy.com";

    const missingNamesList = missingTherapists
      .map((t) => `- ${t.name || "Therapist"} (ID: ${t.id || "N/A"}) — Reason: No credential files found in WorkDrive`)
      .join("\n");

    const missingNamesHtml = missingTherapists
      .map(
        (t) =>
          `<li style="margin-bottom: 6px;"><strong>${escapeHtml(t.name || "Therapist")}</strong> (ID: ${escapeHtml(
            String(t.id || "N/A")
          )}) &mdash; <span style="color: #dc2626; font-weight: 500;">No credential file found in WorkDrive</span></li>`
      )
      .join("");

    const timestampStr = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }) + " (CST)";
    const emailSubject = `[Action Required] Missing Credential Documents for Therapist(s) - ${agencyName}`;

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #ffffff; color: #1e293b;">
        <div style="background: linear-gradient(135deg, #b91c1c 0%, #991b1b 100%); color: #ffffff; padding: 18px 24px; border-radius: 6px; margin-bottom: 20px;">
          <h2 style="margin: 0; font-size: 19px; font-weight: 700;">
            ⚠️ Missing Credential Documents Alert
          </h2>
        </div>

        <p style="font-size: 15px; margin-top: 0;">Hello <strong>${escapeHtml(ownerName)}</strong>,</p>

        <p style="font-size: 14px; line-height: 1.6; color: #334155;">
          A request to dispatch certified therapist credentials was submitted for <strong>${escapeHtml(agencyName)}</strong>. However, credentials <strong>could not be sent</strong> to the agency for the following therapist(s) because no credential documents were found in their Zoho WorkDrive folder:
        </p>

        <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 16px 20px; margin: 18px 0;">
          <h4 style="margin: 0 0 10px 0; color: #991b1b; font-size: 14px; text-transform: uppercase; letter-spacing: 0.03em;">
            Therapist(s) with Missing Credentials:
          </h4>
          <ul style="margin: 0; padding-left: 20px; color: #7f1d1d; font-size: 14px; line-height: 1.6;">
            ${missingNamesHtml}
          </ul>
        </div>

        <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px 16px; margin: 18px 0; font-size: 13.5px; color: #475569; line-height: 1.5;">
          <strong>Action Required:</strong> Please upload the required licenses, certifications, and credential documents to the respective therapist's folder in Zoho WorkDrive or CRM so that future credential dispatch requests can be fulfilled.
        </div>

        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12.5px; color: #64748b; line-height: 1.6;">
          <div><strong>Agency:</strong> ${escapeHtml(agencyName)} (ID: ${escapeHtml(String(agencyId))})</div>
          <div><strong>Requested By:</strong> ${escapeHtml(String(session?.email || "Portal User"))}</div>
          <div><strong>Date & Time:</strong> ${escapeHtml(timestampStr)}</div>
        </div>
      </div>
    `;

    // 2. Attempt Catalyst Email SDK delivery
    if (req) {
      try {
        const catalystApp = catalyst.initialize(req);
        const emailService = catalystApp.email();
        await emailService.sendMail({
          from_email: process.env.CATALYST_FROM_EMAIL || "ects@eaglecreektherapy.net",
          to_email: [recipientEmail],
          subject: emailSubject,
          content: emailHtml,
          html_mode: true,
        });
        console.log(`[notify-owner] Sent missing credentials notification email to ${recipientEmail}`);
      } catch (emailErr) {
        console.warn(`[notify-owner] Catalyst email send failed:`, emailErr.message);
        const crmMail = await sendCrmMail(token, agencyId, {
          toEmail: recipientEmail,
          toName: ownerName,
          subject: emailSubject,
          html: emailHtml,
        });
        if (crmMail.ok) {
          console.log(`[notify-owner] Sent missing credentials notification through CRM mail to ${recipientEmail}`);
        } else {
          console.warn(`[notify-owner] CRM mail fallback failed:`, crmMail.message);
        }
      }
    }

    // 3. Log Note on Agency Account in CRM for audit trail & in-app CRM alert
    try {
      const noteRes = await crmRequest(token, "POST", "/crm/v3/Notes", {
        data: [
          {
            Note_Title: "Alert: Missing Therapist Credential Files",
            Note_Content: `Credential dispatch request on ${timestampStr} by ${session?.email || "Portal User"}.\n\nCredentials could not be sent to ${agencyName} for the following therapist(s) because no files were found in WorkDrive:\n\n${missingNamesList}\n\nPlease upload their credential files to WorkDrive.`,
            Parent_Id: { id: agencyId },
            $se_module: "Accounts",
          },
        ],
      });
      console.log(`[notify-owner] Logged CRM Note on Account ${agencyId}:`, noteRes.status);
    } catch (noteErr) {
      console.warn(`[notify-owner] Could not create CRM note on Account:`, noteErr.message);
    }
  } catch (err) {
    console.error("[notify-owner] Unexpected error in notifyAgencyOwnerOfMissingCredentials:", err.message);
  }
}

/**
 * Send credentials:
 * Checks WorkDrive files per therapist, writes Portal_Selected_Therapists,
 * and turns on Therapists_From_Portal and Portal_Send_Credentials.
 * That is what starts Send_Therapist_From_Portal.
 *
 * The function emails Portal_Access_Email from ects@eaglecreektherapy.net,
 * then sets Credential_Sent_Time, clears both checkboxes, and unlinks
 * Portal_Selected_Therapists. It does not write PORTAL_RESULT.
 *
 * send_status values returned to frontend:
 *   "all"       — Deluge confirmed full delivery (EMAIL_SENT=true, no missing)
 *   "partial"   — some sent, some missing
 *   "failed"    — Deluge confirmed EMAIL_SENT=false
 *   "none"      — no candidates had WorkDrive files (pre-screen fail)
 *   "submitted" — CRM update OK, but Deluge did not respond in poll window
 */
/* eslint-disable max-lines-per-function */
app.post("/api/therapists/send-credentials", async (req, res) => {
  try {
    const session = requireSession(req, res);
    if (!session) {
      return;
    }

    const therapistIds = req.body.therapistIds || req.body.selectedTherapists || [];
    if (!Array.isArray(therapistIds) || therapistIds.length === 0) {
      return res.status(400).json({
        ok: false,
        message: "Please select at least one therapist to send credentials.",
      });
    }

    const accessToken = await getOrgAccessToken(req);
    const agencyId = session.agency_id;

    // 1. Fetch Contact details and Account details in parallel
    const contactFields = [
      "Full_Name",
      "First_Name",
      "Last_Name",
      "zohocrmforzohoworkdrive__Work_Drive_Files",
      "id",
    ].join(",");

    let fetchedContacts = [];
    let accountData = null;

    try {
      const [detailsRes, accRes] = await Promise.all([
        crmRequest(
          accessToken,
          "GET",
          `/crm/v3/Contacts?ids=${encodeURIComponent(therapistIds.join(","))}&fields=${encodeURIComponent(contactFields)}`
        ),
        crmRequest(
          accessToken,
          "GET",
          `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}/${encodeURIComponent(agencyId)}?fields=Account_Name,Agency_Name,Owner,Portal_Access_Email,Email,Therapists_From_Portal,Portal_Send_Credentials,Credential_Sent_Time,${encodeURIComponent(config.FIELD_SELECTED_THERAPISTS)}`
        ),
      ]);

      if (detailsRes.status === 200 && Array.isArray(detailsRes.data?.data)) {
        fetchedContacts = detailsRes.data.data;
      }
      accountData = accRes.data?.data?.[0] || null;
    } catch (parallelErr) {
      console.warn("[send-credentials] Error in parallel fetch:", parallelErr.message);
    }

    const contactMap = new Map();
    fetchedContacts.forEach((c) => contactMap.set(String(c.id), c));

    // 2. Pre-screen therapists for presence of WorkDrive files (using in-memory cache)
    const candidatesToSend = [];
    const missingTherapists = [];

    await Promise.all(
      therapistIds.map(async (rawId) => {
        const idStr = String(typeof rawId === "object" && rawId.id ? rawId.id : rawId);
        const contact = contactMap.get(idStr) || {};
        const fullName =
          contact.Full_Name ||
          `${contact.First_Name || ""} ${contact.Last_Name || ""}`.trim() ||
          "Therapist";

        const folderId = (contact.zohocrmforzohoworkdrive__Work_Drive_Files || "").trim();

        if (!folderId || folderId === "—" || folderId.toLowerCase() === "null" || folderId.toLowerCase() === "undefined") {
          missingTherapists.push({ id: idStr, name: fullName, fileCount: 0 });
          return;
        }

        let files = [];
        try {
          // forceFresh=true: bypass 5-min cache so newly uploaded files are always seen
          files = await fetchWorkDriveFolderFiles(accessToken, folderId, true);
        } catch (filesErr) {
          console.warn(`[send-credentials] Error checking files for ${fullName}:`, filesErr.message);
        }

        if (!files || files.length === 0) {
          missingTherapists.push({ id: idStr, name: fullName, folderId, fileCount: 0 });
        } else {
          candidatesToSend.push({ id: idStr, name: fullName, folderId, fileCount: files.length, files });
        }
      })
    );

    // If NO selected therapists have available documents, notify owner and return error immediately
    if (candidatesToSend.length === 0) {
      const missingNames = missingTherapists.map((t) => t.name).join(", ");

      // Send email & CRM notification to Agency Owner about missing files (fast - reuses accountData)
      await notifyAgencyOwnerOfMissingCredentials({
        req,
        accessToken,
        agencyId,
        missingTherapists,
        session,
        accountData,
      });

      return res.status(400).json({
        ok: false,
        success: false,
        send_status: "none",
        fileCount: 0,
        totalFilesCount: 0,
        message: `Email could not be sent to the following therapist(s): ${missingNames} because licensed documents are not available.`,
        sentTherapists: [],
        missingTherapists,
      });
    }

    // Send_Therapist_From_Portal emails only Portal_Access_Email.
    // It returns without sending when that field is blank, and it leaves the
    // checkbox on. Stop here instead of starting a run that cannot email.
    const portalEmail = String(accountData?.Portal_Access_Email || "").trim();
    if (accountData && !portalEmail) {
      return res.status(400).json({
        ok: false,
        success: false,
        send_status: "failed",
        message: "Portal Access Email is missing on this agency. Zoho will not send the credential email until that field is filled.",
      });
    }

    // 3. The workflow runs when a send checkbox changes to true.
    //    If a previous run left one on, turn both off first (no workflow),
    //    then turn them on with the therapist lookup in one write.
    const nowMs = Date.now();
    const requestId = crypto.randomUUID();
    const checkboxAlreadyOn =
      accountData?.Therapists_From_Portal === true ||
      accountData?.Portal_Send_Credentials === true;
    if (checkboxAlreadyOn) {
      const reset = await crmRequest(
        accessToken,
        "PUT",
        `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}`,
        {
          data: [{
            id: agencyId,
            Therapists_From_Portal: false,
            Portal_Send_Credentials: false,
          }],
          trigger: [],
        }
      );
      console.log("[send-credentials] Reset send checkboxes before a new run:", reset.status, JSON.stringify(reset.data));
    }

    const validIdsToSend = candidatesToSend.map((t) => t.id);
    let pendingStamp = {
      Therapists_From_Portal: true,
      Portal_Send_Credentials: true,
    };
    let update = await updateAgencySelectedTherapists(
      accessToken, agencyId, validIdsToSend, accountData, pendingStamp
    );
    if (!update.ok) {
      console.warn("[send-credentials] Update with Portal_Send_Credentials failed; retrying with Therapists_From_Portal only.");
      pendingStamp = { Therapists_From_Portal: true };
      update = await updateAgencySelectedTherapists(
        accessToken, agencyId, validIdsToSend, accountData, pendingStamp
      );
    }

    if (!update.ok) {
      console.error("[send-credentials] Failed to update Portal_Selected_Therapists in CRM:",
        update.responseData || update.data);
      return res.status(502).json({
        ok: false,
        message: update.row?.message || "Failed to update selected therapists in CRM.",
        details: update.responseData || update.data,
      });
    }

    // 4. Notify owner about pre-screen missing therapists BEFORE polling
    //    so the notification is not delayed by the 30 s poll window.
    //    Track notified IDs to deduplicate later.
    const preScreenMissingIds = new Set(missingTherapists.map((t) => t.id).filter(Boolean));
    if (missingTherapists.length > 0) {
      notifyAgencyOwnerOfMissingCredentials({
        req, accessToken, agencyId,
        missingTherapists, session, accountData,
      }).catch((e) => console.warn("[send-credentials] Pre-screen owner notification failed:", e.message));
    }

    // 5. Poll Account Description for a correlated Deluge result
    //    Window: 30 attempts × 1 000 ms = 30 seconds
    //
    // Expected Deluge result format (written back to Account Description):
    //   PORTAL_RESULT::REQ=<uuid>::STATUS=SUCCESS|PARTIAL|FAILED::
    //   EMAIL_SENT=true|false::SENT=Name A|Name B::MISSING=Name C::ERROR=<msg>::TIME=<ms>
    //
    // The REQ value must match requestId — stale results are ignored.
    let delugeResponded  = false;
    let delugeResult     = {};
    // parsed fields from Deluge response
    let delugeSentNames     = [];
    let delugeMissingNames  = [];
    let delugeStatus        = "";
    let delugeEmailSent     = null;   // true | false | null (unknown)
    let delugeError         = "";

    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        let checkAcc = await crmRequest(
          accessToken, "GET",
          `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}/${encodeURIComponent(agencyId)}?fields=Credential_Sent_Time,Therapists_From_Portal,Portal_Send_Credentials,WorkDrive_Credential_Folder_ID,Description`
        );
        if (checkAcc.status >= 400) {
          checkAcc = await crmRequest(
            accessToken, "GET",
            `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}/${encodeURIComponent(agencyId)}?fields=Credential_Sent_Time,Therapists_From_Portal`
          );
        }
        const accountRow = checkAcc.data?.data?.[0] || {};
        const desc = (accountRow.Description || "").trim();
        const sentAtMs = Date.parse(accountRow.Credential_Sent_Time || "");

        // The live workflow does not always write PORTAL_RESULT. It stamps
        // Credential_Sent_Time and turns Therapists_From_Portal back off.
        if (!desc.startsWith("PORTAL_RESULT::")) {
          if (Number.isFinite(sentAtMs) && sentAtMs >= nowMs - 5000) {
            delugeStatus = "SUCCESS";
            delugeEmailSent = true;
            delugeSentNames = candidatesToSend.map((c) => c.name);
            delugeMissingNames = [];
            delugeError = "";
            delugeResult = { delugeStatus, delugeEmailSent, delugeSentNames, delugeMissingNames, delugeError, via: "Credential_Sent_Time" };
            delugeResponded = true;
            console.log(
              `[send-credentials] Workflow finished on attempt ${attempt + 1}:`,
              accountRow.Credential_Sent_Time,
              "folder",
              accountRow.WorkDrive_Credential_Folder_ID || ""
            );
            break;
          }
          continue;
        }

        // ── Section parser ────────────────────────────────────────────────────
        // Split on "::" so colons inside names/messages don't corrupt sections.
        const sections = desc.split("::");

        const getVal = (prefix) => {
          const sec = sections.find((s) => s.startsWith(prefix + "="));
          return sec ? sec.slice(prefix.length + 1).trim() : "";
        };

        const resultReqId = getVal("REQ");

        // Correlation check — ignore any result that belongs to a different request
        if (resultReqId && resultReqId !== requestId) {
          console.warn(
            `[send-credentials] Ignoring stale PORTAL_RESULT (REQ=${resultReqId}, expected ${requestId}).`
          );
          continue;
        }

        // ── Name list helper ──────────────────────────────────────────────────
        // Prefer "|" delimiter (safe for names containing commas); fall back to ",".
        const splitNames = (raw) =>
          raw.trim()
            ? (raw.includes("|") ? raw.split("|") : raw.split(","))
                .map((s) => s.trim())
                .filter(Boolean)
            : [];

        delugeStatus       = getVal("STATUS").toUpperCase();          // SUCCESS|PARTIAL|FAILED
        delugeEmailSent    = getVal("EMAIL_SENT").toLowerCase();      // "true"|"false"|""  
        delugeSentNames    = splitNames(getVal("SENT"));
        delugeMissingNames = splitNames(getVal("MISSING"));
        delugeError        = getVal("ERROR");

        // Normalise EMAIL_SENT to boolean or null
        if (delugeEmailSent === "true")  delugeEmailSent = true;
        else if (delugeEmailSent === "false") delugeEmailSent = false;
        else delugeEmailSent = null;

        delugeResult    = { delugeStatus, delugeEmailSent, delugeSentNames, delugeMissingNames, delugeError };
        delugeResponded = true;
        console.log(`[send-credentials] Deluge responded on attempt ${attempt + 1}:`, delugeResult);
        break;
        // ─────────────────────────────────────────────────────────────────────
      } catch (pollErr) {
        console.warn(`[send-credentials] Poll error attempt ${attempt + 1}:`, pollErr.message);
      }
    }

    // NOTE: clearAgencySelectedTherapists is intentionally NOT called here.
    // The Deluge function owns cleanup of Portal_Selected_Therapists after it finishes.
    // A backend-side delayed clear would race with the Deluge execution.

    // 6. Assemble Sent / Missing / Unconfirmed breakdown
    const norm   = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    let sentTherapists        = [];
    let unconfirmedTherapists = [];

    if (delugeResponded) {
      const normSentSet    = new Set(delugeSentNames.map(norm));
      const normMissingSet = new Set(delugeMissingNames.map(norm));
      const mentionedNorms = new Set([...normSentSet, ...normMissingSet]);

      // Candidates explicitly confirmed as sent
      sentTherapists = candidatesToSend
        .filter((c) => normSentSet.has(norm(c.name)))
        .map((c) => ({ id: c.id, name: c.name, fileCount: c.fileCount || 0 }));

      // Candidates explicitly marked missing by Deluge (dedup with pre-screen list)
      delugeMissingNames.forEach((dName) => {
        if (!missingTherapists.some((m) => norm(m.name) === norm(dName))) {
          const match = candidatesToSend.find((c) => norm(c.name) === norm(dName));
          missingTherapists.push({ id: match?.id || null, name: dName, fileCount: 0 });
        }
      });

      // Candidates Deluge did not mention at all → unconfirmed (NOT optimistic success)
      candidatesToSend.forEach((c) => {
        const isSent    = sentTherapists.some((s) => s.id === c.id);
        const isMissing = missingTherapists.some((m) => m.id === c.id);
        if (!mentionedNorms.has(norm(c.name)) && !isSent && !isMissing) {
          console.warn(
            `[send-credentials] Candidate "${c.name}" (${c.id}) not mentioned by Deluge — marked unconfirmed.`
          );
          unconfirmedTherapists.push({ id: c.id, name: c.name, fileCount: c.fileCount || 0 });
        }
      });

      // Notify owner about any NEW missing therapists reported by Deluge
      // that were not already covered by the pre-screen notification.
      const newlyMissingForNotification = missingTherapists.filter(
        (m) => !preScreenMissingIds.has(m.id)
      );
      if (newlyMissingForNotification.length > 0) {
        notifyAgencyOwnerOfMissingCredentials({
          req, accessToken, agencyId,
          missingTherapists: newlyMissingForNotification, session,
        }).catch((e) => console.warn("[send-credentials] Post-Deluge owner notification failed:", e.message));
      }
    }

    // 7. Build response
    const totalFilesCount = sentTherapists.reduce((sum, t) => sum + (t.fileCount || 0), 0);
    const sentNames        = sentTherapists.map((t) => t.name).join(", ");
    const missingNames     = missingTherapists.map((t) => t.name).join(", ");
    const unconfirmedNames = unconfirmedTherapists.map((t) => t.name).join(", ");

    // ── 7a. Deluge did not respond within 30 s ────────────────────────────────
    if (!delugeResponded) {
      const submittedNames  = candidatesToSend.map((t) => t.name).join(", ");
      const submittedFiles  = candidatesToSend.reduce((s, t) => s + (t.fileCount || 0), 0);
      console.warn(
        `[send-credentials] Deluge did not respond within 30 s (REQ=${requestId}). ` +
        "CRM update succeeded — request submitted but delivery unconfirmed."
      );
      return res.status(200).json({
        ok: true,
        success: true,
        send_status: "submitted",
        requestId,
        fileCount: submittedFiles,
        totalFilesCount: submittedFiles,
        message:
          `Credential request submitted to Zoho CRM for: ${submittedNames}. ` +
          "The automation is still processing — email delivery has not yet been confirmed.",
        sentTherapists: [],
        unconfirmedTherapists: candidatesToSend.map((c) => ({ id: c.id, name: c.name, fileCount: c.fileCount || 0 })),
        missingTherapists,
      });
    }

    // ── 7b. Deluge confirmed EMAIL_SENT=false (delivery failure) ──────────────
    if (delugeEmailSent === false || delugeStatus === "FAILED") {
      return res.status(200).json({
        ok: false,
        success: false,
        send_status: "failed",
        requestId,
        fileCount: 0,
        totalFilesCount: 0,
        message:
          `Credential delivery failed for: ${sentNames || candidatesToSend.map((t) => t.name).join(", ")}. ` +
          (delugeError ? `Reason: ${delugeError}.` : "Please check the Zoho CRM workflow logs."),
        sentTherapists: [],
        unconfirmedTherapists,
        missingTherapists,
      });
    }

    // ── 7c. None were confirmed sent (all missing after Deluge ran) ───────────
    if (sentTherapists.length === 0 && unconfirmedTherapists.length === 0) {
      return res.status(400).json({
        ok: false,
        success: false,
        send_status: "none",
        requestId,
        fileCount: 0,
        totalFilesCount: 0,
        message:
          `Credential documents could not be sent for: ${missingNames} ` +
          "because no credential files were found in WorkDrive. The Agency Owner has been notified.",
        sentTherapists: [],
        unconfirmedTherapists,
        missingTherapists,
      });
    }

    // ── 7d. Partial: some confirmed sent, some missing ────────────────────────
    if (missingTherapists.length > 0 || unconfirmedTherapists.length > 0) {
      const extraNote = unconfirmedNames
        ? `Unconfirmed (Deluge did not report status for): ${unconfirmedNames}. ` : "";
      return res.status(200).json({
        ok: true,
        success: true,
        send_status: "partial",
        requestId,
        fileCount: totalFilesCount,
        totalFilesCount,
        message:
          `Credentials sent successfully for: ${sentNames}` +
          (missingNames   ? `. Could not be sent for: ${missingNames}` : "") +
          (extraNote      ? `. ${extraNote}` : "") +
          ". The Agency Owner has been notified about missing credentials.",
        sentTherapists,
        unconfirmedTherapists,
        missingTherapists,
      });
    }

    // ── 7e. Full success ──────────────────────────────────────────────────────
    return res.status(200).json({
      ok: true,
      success: true,
      send_status: "all",
      requestId,
      fileCount: totalFilesCount,
      totalFilesCount,
      message: `Credential email was sent to ${portalEmail || "the Portal Access Email"} for: ${sentNames}. Zoho clears the selected therapists after the email is sent.`,
      sentTherapists,
      unconfirmedTherapists: [],
      missingTherapists,
    });
  } catch (err) {
    console.error("/api/therapists/send-credentials error:", err.response?.data || err);
    res.status(500).json({
      ok: false,
      message: "Failed to submit credentials request",
      error: err.message,
    });
  }
});

/**
 * Add / Link Contacts to Agency's Therapists subform in Zoho CRM.
 */
async function addContactsToAgencyTherapists(accessToken, agencyId, contactIds) {
  const path = `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}`;
  const targetIds = new Set(
    (Array.isArray(contactIds) ? contactIds : [])
      .map((id) => (typeof id === "object" && id.id ? String(id.id) : String(id)))
      .filter(Boolean)
  );

  if (targetIds.size === 0) {
    return { ok: false, message: "No contacts to add" };
  }

  // 1. Fetch current Account to inspect existing Therapists subform/links
  let existingLinks = [];
  const alreadyLinkedContactIds = new Set();
  try {
    const accRes = await crmRequest(
      accessToken,
      "GET",
      `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}/${encodeURIComponent(agencyId)}`
    );
    const accountData = accRes.data?.data?.[0] || {};
    if (Array.isArray(accountData.Therapists)) {
      existingLinks = accountData.Therapists;
      for (const item of existingLinks) {
        const tObj = item.Therapists && typeof item.Therapists === "object" ? item.Therapists : item;
        const cId = tObj.id || item.id;
        if (cId) alreadyLinkedContactIds.add(String(cId));
      }
    }
  } catch (err) {
    console.warn("[add-therapists] Could not fetch current account therapists:", err.message);
  }

  // 2. Build operations array
  const operations = [];

  // Keep existing junction records
  for (const link of existingLinks) {
    if (link.id) {
      operations.push({ id: String(link.id) });
    } else {
      const cId = link.Therapists?.id || link.id;
      if (cId) {
        operations.push({ Therapists: { id: String(cId) } });
      }
    }
  }

  // Add new links for target IDs not yet linked
  for (const cid of targetIds) {
    if (!alreadyLinkedContactIds.has(cid)) {
      operations.push({
        Therapists: { id: cid },
      });
    }
  }

  const body = {
    data: [
      {
        id: agencyId,
        Therapists: operations,
      },
    ],
  };

  console.log(`[add-therapists] Updating CRM Accounts (${agencyId}) Therapists:`, JSON.stringify(body));
  let result = await crmRequest(accessToken, "PUT", path, body);
  console.log(`[add-therapists] CRM Response:`, result.status, JSON.stringify(result.data));

  let row = result.data?.data?.[0];
  let ok =
    result.status < 400 &&
    row &&
    (row.status === "success" || row.code === "SUCCESS");

  // Fallback: direct array of objects
  if (!ok) {
    const allUniqueIds = new Set([...alreadyLinkedContactIds, ...targetIds]);
    const fallbackObjects = Array.from(allUniqueIds).map((id) => ({ id }));
    const fallbackBody = {
      data: [
        {
          id: agencyId,
          Therapists: fallbackObjects,
        },
      ],
    };
    console.log(`[add-therapists] Retrying with direct fallback array:`, JSON.stringify(fallbackBody));
    result = await crmRequest(accessToken, "PUT", path, fallbackBody);
    console.log(`[add-therapists] CRM Fallback Response:`, result.status, JSON.stringify(result.data));
    row = result.data?.data?.[0];
    ok =
      result.status < 400 &&
      row &&
      (row.status === "success" || row.code === "SUCCESS");
  }

  return { ...result, ok, row, responseData: result.data };
}

/**
 * GET /api/therapists/available (or /api/therapists/unassigned)
 * Fetches Zoho CRM Contacts that are Active and have a non-empty Discipline,
 * excluding any contacts already linked to the current agency.
 */
app.get(["/api/therapists/available", "/api/therapists/unassigned"], async (req, res) => {
  try {
    const session = requireSession(req, res);
    if (!session) return;

    const accessToken = await getOrgAccessToken(req);
    const agencyId = session.agency_id;

    // 1. Fetch currently linked contact IDs on the Agency
    const assignedContactIds = new Set();
    try {
      const accRes = await crmRequest(
        accessToken,
        "GET",
        `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}/${encodeURIComponent(agencyId)}`
      );
      const accountData = accRes.data?.data?.[0];
      if (accountData && Array.isArray(accountData.Therapists)) {
        for (const item of accountData.Therapists) {
          const tObj = item.Therapists && typeof item.Therapists === "object" ? item.Therapists : item;
          const cId = tObj.id || item.id;
          if (cId) assignedContactIds.add(String(cId));
        }
      }
    } catch (accErr) {
      console.warn("Could not fetch current agency therapists:", accErr.message);
    }

    let rawContacts = [];
    const contactFields = [
      "Full_Name",
      "First_Name",
      "Last_Name",
      "Email",
      "Phone",
      "Mobile",
      "Owner",
      "Status",
      "Discipline",
      "Layout",
      "id",
      "$approved",
      "$approval_state",
    ].join(",");

    // 2. Fetch all contacts from Zoho CRM across all pages with full pagination
    try {
      let page = 1;
      let hasMore = true;
      const maxPages = 20; // Support up to 4,000 contacts

      while (hasMore && page <= maxPages) {
        let contactsRes = null;
        try {
          contactsRes = await crmRequest(
            accessToken,
            "GET",
            `/crm/v3/Contacts?cvid=5631595000001218947&fields=${encodeURIComponent(contactFields)}&per_page=200&page=${page}`
          );
        } catch (cvidErr) {
          console.warn("[therapists/available] cvid fetch failed, falling back to standard Contacts:", cvidErr.message);
        }

        if (!contactsRes || contactsRes.status !== 200 || !Array.isArray(contactsRes.data?.data)) {
          contactsRes = await crmRequest(
            accessToken,
            "GET",
            `/crm/v3/Contacts?fields=${encodeURIComponent(contactFields)}&per_page=200&page=${page}`
          );
        }

        if (contactsRes && contactsRes.status === 200 && Array.isArray(contactsRes.data?.data)) {
          rawContacts.push(...contactsRes.data.data);
          hasMore = contactsRes.data.info?.more_records === true;
          page++;
        } else {
          hasMore = false;
        }
      }
    } catch (fetchErr) {
      console.error("[therapists/available] Error fetching contacts from Zoho CRM:", fetchErr.message);
    }

    // 4. Apply strict filtering rules:
    // Filter 1: Discipline must not be empty (Discipline != null && Discipline != "" && Discipline != "—")
    // Filter 2: Status must be Active (Status == "Active" or $approved == true / $approval_state == "approved")
    // Filter 3: Must not be already assigned to this agency
    const filteredContacts = rawContacts
      .filter((c) => {
        if (!c || !c.id) return false;
        if (assignedContactIds.has(String(c.id))) return false;

        // Discipline must not be empty
        const discipline = (c.Discipline || "").trim();
        if (!discipline || discipline === "—" || discipline.toLowerCase() === "null" || discipline.toLowerCase() === "empty") {
          return false;
        }

        // Status must be Active
        const rawStatus = (c.Status || "").trim().toLowerCase();
        const isExplicitInactive =
          rawStatus === "inactive" ||
          rawStatus === "terminated" ||
          rawStatus === "closed" ||
          c.$approved === false;
        if (isExplicitInactive) return false;
        if (rawStatus && rawStatus !== "active") return false;

        return true;
      })
      .map((c) => {
        const fullName =
          c.Full_Name ||
          `${c.First_Name || ""} ${c.Last_Name || ""}`.trim() ||
          "Therapist";

        return {
          id: String(c.id),
          name: fullName,
          fullName: fullName,
          firstName: c.First_Name || "",
          lastName: c.Last_Name || "",
          discipline: c.Discipline || "—",
          email: c.Email || "—",
          phone: c.Phone || "—",
          mobile: c.Mobile || "—",
          status: c.Status || (c.$approval_state === "approved" || c.$approved ? "Active" : "Active"),
          owner: c.Owner?.name || "Eagle Creek Therapy",
        };
      });

    return res.status(200).json({
      success: true,
      ok: true,
      count: filteredContacts.length,
      total: filteredContacts.length,
      contacts: filteredContacts,
    });
  } catch (err) {
    console.error("/api/therapists/available error:", err.response?.data || err);
    res.status(500).json({
      success: false,
      ok: false,
      message: "Failed to fetch available contacts from Zoho CRM",
      error: err.message,
    });
  }
});

/**
 * POST /api/therapists/add
 * Validates selected contact IDs against Zoho CRM (must have Discipline & Active status)
 * and links them to the logged-in agency's Therapists subform.
 */
app.post("/api/therapists/add", async (req, res) => {
  try {
    const session = requireSession(req, res);
    if (!session) return;

    const contactIds = req.body.contactIds || req.body.contacts || [];
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please select at least one contact to add.",
      });
    }

    const accessToken = await getOrgAccessToken(req);
    const agencyId = session.agency_id;

    // 1. Backend Security Validation: Fetch contact details from Zoho CRM
    const contactFields = ["Full_Name", "Discipline", "Status", "$approved", "$approval_state", "id"].join(",");
    const contactDetailsRes = await crmRequest(
      accessToken,
      "GET",
      `/crm/v3/Contacts?ids=${encodeURIComponent(contactIds.join(","))}&fields=${encodeURIComponent(contactFields)}`
    );

    const fetchedContacts = Array.isArray(contactDetailsRes.data?.data)
      ? contactDetailsRes.data.data
      : [];

    // Validate: Discipline != null/empty AND Status == "Active"
    const validContactIds = fetchedContacts
      .filter((c) => {
        const disc = (c.Discipline || "").trim();
        if (!disc || disc === "—" || disc.toLowerCase() === "null" || disc.toLowerCase() === "empty") return false;

        const rawStatus = (c.Status || "").trim().toLowerCase();
        const isExplicitInactive =
          rawStatus === "inactive" ||
          rawStatus === "terminated" ||
          rawStatus === "closed" ||
          c.$approved === false;
        if (isExplicitInactive) return false;
        if (rawStatus && rawStatus !== "active") return false;

        return true;
      })
      .map((c) => String(c.id));

    if (validContactIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "None of the selected contacts meet the requirements (must be Active and have a valid Discipline assigned).",
      });
    }

    // 2. Link with Agency in Zoho CRM
    const update = await addContactsToAgencyTherapists(accessToken, agencyId, validContactIds);

    if (!update.ok) {
      console.error("Failed to add therapists in CRM:", update.responseData || update.data);
      return res.status(502).json({
        success: false,
        message: update.row?.message || "Unable to add therapists in Zoho CRM.",
        details: update.responseData || update.data,
      });
    }

    return res.status(200).json({
      success: true,
      ok: true,
      message: `Successfully added ${validContactIds.length} therapist${validContactIds.length === 1 ? "" : "s"} to your agency roster.`,
      addedCount: validContactIds.length,
      contactIds: validContactIds,
    });
  } catch (err) {
    console.error("/api/therapists/add error:", err.response?.data || err);
    res.status(500).json({
      success: false,
      message: err.message || "Unable to add therapists",
    });
  }
});

/**
 * Remove / Unlink Contacts from Agency's Therapists subform/junction in Zoho CRM.
 */
async function removeContactsFromAgencyTherapists(accessToken, agencyId, contactIdsToRemove) {
  const path = `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}`;
  const removeIdSet = new Set(
    (Array.isArray(contactIdsToRemove) ? contactIdsToRemove : [])
      .map((id) => (typeof id === "object" && id.id ? String(id.id) : String(id)))
      .filter(Boolean)
  );

  if (removeIdSet.size === 0) {
    return { ok: false, message: "No therapists specified to remove" };
  }

  // 1. Fetch current Account to inspect existing Therapists subform/links
  let existingLinks = [];
  try {
    const accRes = await crmRequest(
      accessToken,
      "GET",
      `/crm/v3/${encodeURIComponent(config.AGENCY_MODULE)}/${encodeURIComponent(agencyId)}`
    );
    const accountData = accRes.data?.data?.[0] || {};
    if (Array.isArray(accountData.Therapists)) {
      existingLinks = accountData.Therapists;
    }
  } catch (err) {
    console.warn("[remove-therapists] Could not fetch current account therapists:", err.message);
  }

  // 2. Build operations array with _delete: null for targeted rows
  const operations = [];
  for (const link of existingLinks) {
    const tObj = link.Therapists && typeof link.Therapists === "object" ? link.Therapists : link;
    const cId = String(tObj.id || link.id || "");
    const junctionId = link.id ? String(link.id) : null;

    if (removeIdSet.has(cId) || (junctionId && removeIdSet.has(junctionId))) {
      if (junctionId) {
        operations.push({ id: junctionId, _delete: null });
      }
    } else {
      if (junctionId) {
        operations.push({ id: junctionId });
      } else if (cId) {
        operations.push({ Therapists: { id: cId } });
      }
    }
  }

  const body = {
    data: [
      {
        id: agencyId,
        Therapists: operations,
      },
    ],
  };

  console.log(`[remove-therapists] Updating CRM Accounts (${agencyId}) Therapists:`, JSON.stringify(body));
  let result = await crmRequest(accessToken, "PUT", path, body);
  console.log(`[remove-therapists] CRM Response:`, result.status, JSON.stringify(result.data));

  let row = result.data?.data?.[0];
  let ok =
    result.status < 400 &&
    row &&
    (row.status === "success" || row.code === "SUCCESS");

  // Fallback: provide array of remaining contact objects
  if (!ok) {
    const remainingObjects = [];
    for (const link of existingLinks) {
      const tObj = link.Therapists && typeof link.Therapists === "object" ? link.Therapists : link;
      const cId = String(tObj.id || link.id || "");
      if (!removeIdSet.has(cId)) {
        remainingObjects.push({ id: cId });
      }
    }
    const fallbackBody = {
      data: [
        {
          id: agencyId,
          Therapists: remainingObjects,
        },
      ],
    };
    console.log(`[remove-therapists] Retrying with remaining array fallback:`, JSON.stringify(fallbackBody));
    result = await crmRequest(accessToken, "PUT", path, fallbackBody);
    console.log(`[remove-therapists] CRM Fallback Response:`, result.status, JSON.stringify(result.data));
    row = result.data?.data?.[0];
    ok =
      result.status < 400 &&
      row &&
      (row.status === "success" || row.code === "SUCCESS");
  }

  return { ...result, ok, row, responseData: result.data };
}

/**
 * POST /api/therapists/remove
 * Unlinks selected therapist contact IDs from the logged-in agency in Zoho CRM.
 */
app.post("/api/therapists/remove", async (req, res) => {
  try {
    const session = requireSession(req, res);
    if (!session) return;

    const therapistIds = req.body.therapistIds || req.body.contactIds || [];
    if (!Array.isArray(therapistIds) || therapistIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please select at least one therapist to remove.",
      });
    }

    const accessToken = await getOrgAccessToken(req);
    const agencyId = session.agency_id;

    const update = await removeContactsFromAgencyTherapists(accessToken, agencyId, therapistIds);

    if (!update.ok) {
      console.error("Failed to remove therapists in CRM:", update.responseData || update.data);
      return res.status(502).json({
        success: false,
        message: update.row?.message || "Unable to remove therapists in Zoho CRM.",
        details: update.responseData || update.data,
      });
    }

    return res.status(200).json({
      success: true,
      ok: true,
      message: `Successfully removed ${therapistIds.length} therapist${therapistIds.length === 1 ? "" : "s"} from your agency roster.`,
      removedCount: therapistIds.length,
      therapistIds,
    });
  } catch (err) {
    console.error("/api/therapists/remove error:", err.response?.data || err);
    res.status(500).json({
      success: false,
      message: err.message || "Unable to remove therapists",
    });
  }
});

module.exports = app;

