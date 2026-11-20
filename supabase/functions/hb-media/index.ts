// Hero Board — confidential media in a private Cloudflare R2 bucket.
// Hands out short-lived signed links:
//   { action: "upload", week_id | update_id, ext, page? }       admin only → PUT link (15 min)
//   { action: "view", keys, store_token? | link_key? }            admin, signed-in store, or store staff link → GET links (1 h)
//   { action: "delete", keys }                                    admin only
//   { action: "status" }                                          admin only → is R2 configured / reachable
// Secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { AwsClient } from "npm:aws4fetch@1.0.20";

const VIEW_SECONDS = 3600, UPLOAD_SECONDS = 900;
const KEY_RE = /^[wu]\d+\/[0-9a-f-]{36}(-p\d+)?\.(mp4|mov|webm|m4v|jpg)$/;

const env = (k: string) => Deno.env.get(k) || "";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// Any page address may call this function: access is controlled by the admin login, store session or
// staff link checked below, not by the page's address. Reflect whatever headers the browser asks to send.
function cors(req: Request) {
  return {
    "Access-Control-Allow-Origin": req.headers.get("origin") || "*",
    "Access-Control-Allow-Headers": req.headers.get("access-control-request-headers") || "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin, Access-Control-Request-Headers",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

function r2() {
  const [acct, id, secret, bucket] = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].map(env);
  if (!acct || !id || !secret || !bucket) return null;
  return { aws: new AwsClient({ accessKeyId: id, secretAccessKey: secret, service: "s3", region: "auto" }), base: `https://${acct}.r2.cloudflarestorage.com/${bucket}/` };
}
async function signed(c: NonNullable<ReturnType<typeof r2>>, key: string, method: string, seconds: number) {
  const url = new URL(c.base + key.split("/").map(encodeURIComponent).join("/"));
  url.searchParams.set("X-Amz-Expires", String(seconds));
  const r = await c.aws.sign(new Request(url, { method }), { aws: { signQuery: true } });
  return r.url;
}
async function isAdmin(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.startsWith("sb_")) return false;
  const { data } = await db.auth.getUser(jwt);
  if (!data?.user) return false;
  const { data: row } = await db.from("hb_admins").select("user_id").eq("user_id", data.user.id).maybeSingle();
  return !!row;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json(req, { error: "Bad request" }, 400); }
  const c = r2();
  const action = String(body.action || "");

  try {
    if (action === "upload" || action === "delete" || action === "status") {
      if (!(await isAdmin(req))) return json(req, { error: "Admins only" }, 403);
      if (!c) return json(req, { error: "R2_NOT_CONFIGURED" }, 503);
      if (action === "status") {
        const res = await c.aws.fetch(c.base + "?list-type=2&max-keys=1");
        return json(req, { ok: res.ok, status: res.status });
      }
      if (action === "upload") {
        const week = Number(body.week_id), upd = Number(body.update_id), ext = String(body.ext || "").toLowerCase();
        const folder = Number.isInteger(upd) && upd > 0 ? `u${upd}` : Number.isInteger(week) && week > 0 ? `w${week}` : "";
        if (!folder || !/^(mp4|mov|webm|m4v|jpg)$/.test(ext)) return json(req, { error: "Bad upload request" }, 400);
        const pg = Number(body.page);
        const page = Number.isInteger(pg) && pg >= 1 && pg <= 999 ? `-p${pg}` : "";
        const key = `${folder}/${crypto.randomUUID()}${page}.${ext}`;
        return json(req, { key, url: await signed(c, key, "PUT", UPLOAD_SECONDS) });
      }
      const keys = (Array.isArray(body.keys) ? body.keys.slice(0, 50) : []).map(String).filter((k) => KEY_RE.test(k)).slice(0, 50);
      const results = await Promise.all(keys.map(async (k) => (await c.aws.fetch(c.base + k, { method: "DELETE" })).ok));
      return json(req, { deleted: results.filter(Boolean).length });
    }

    if (action === "view") {
      if (!c) return json(req, { error: "R2_NOT_CONFIGURED" }, 503);
      const keys = (Array.isArray(body.keys) ? body.keys.slice(0, 50) : []).map(String).filter((k) => KEY_RE.test(k)).slice(0, 50);
      let allowed: Set<string> | null = null, store = null;
      if (!(await isAdmin(req))) {
        const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
        const st = uuid(body.store_token), wt = uuid(body.week_token), lk = uuid(body.link_key);
        if (!st && !lk) return json(req, { error: "LINK_INVALID" }, 403);
        const { data, error } = await db.rpc("hb_media_keys", { p_store_token: st, p_week_token: st ? null : wt, p_link_key: st ? null : lk });
        if (error) return json(req, { error: error.message.includes("SESSION_EXPIRED") ? "SESSION_EXPIRED" : "LINK_INVALID" }, 403);
        allowed = new Set((data?.keys || []) as string[]); store = data?.store || null;
      }
      const urls: Record<string, string> = {};
      for (const k of keys) if (!allowed || allowed.has(k)) urls[k] = await signed(c, k, "GET", VIEW_SECONDS);
      return json(req, { urls, store, expires_in: VIEW_SECONDS });
    }
    return json(req, { error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json(req, { error: "Something went wrong. Please try again." }, 500);
  }
});
