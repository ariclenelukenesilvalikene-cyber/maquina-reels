import { getStore } from "@netlify/blobs";

const API = "https://api.higgsfield.ai";

export type Job = {
  id: string;
  prompt: string;
  wantVideo: boolean;
  state: "pending" | "img_wait" | "vid_pending" | "vid_wait" | "done" | "error";
  imgReq?: string;
  vidReq?: string;
  imageUrl?: string;
  videoUrl?: string;
  hasImage?: boolean;
  hasVideo?: boolean;
  error?: string;
  tries: number;
  createdAt: number;
  updatedAt: number;
  lockUntil?: number;
};

export const store = () => getStore({ name: "reels", consistency: "strong" });

const env = (k: string) => (globalThis as any).Netlify?.env?.get(k) ?? process.env[k];

function authHeader() {
  const key = env("HF_API_KEY");
  if (key) return `Key ${key}`;
  return `Key ${env("HF_API_KEY_ID")}:${env("HF_API_KEY_SECRET")}`;
}

export function checkPassword(req: Request) {
  const pass = env("APP_PASSWORD");
  if (!pass) return false;
  const url = new URL(req.url);
  const given = req.headers.get("x-app-key") || url.searchParams.get("k");
  return given === pass;
}

const IMAGE_MODEL = () => env("HF_IMAGE_MODEL") || "/higgsfield-ai/soul/v2/standard";
const VIDEO_MODEL = () => env("HF_VIDEO_MODEL") || "/kling-video/v2.5-turbo/standard/image-to-video";

const STYLE =
  ", vertical 9:16 composition, cinematic lighting, highly detailed, eye-catching viral social media reel frame";

class HfError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

async function hf(path: string, body?: unknown) {
  const res = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new HfError(res.status, `HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function submitImage(prompt: string) {
  try {
    return await hf(IMAGE_MODEL(), { prompt: prompt + STYLE, aspect_ratio: "9:16" });
  } catch (e: any) {
    // Some models reject unknown fields: retry with prompt only
    if (e instanceof HfError && (e.status === 400 || e.status === 422)) {
      return await hf(IMAGE_MODEL(), { prompt: prompt + STYLE });
    }
    throw e;
  }
}

async function submitVideo(prompt: string, imageUrl: string) {
  return hf(VIDEO_MODEL(), {
    prompt: prompt + ", smooth natural motion, dynamic camera movement",
    image_url: imageUrl,
    duration: 5,
  });
}

const status = (id: string) => hf(`/requests/${id}/status`);

async function saveFile(key: string, url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const buf = await r.arrayBuffer();
  await store().set(key, buf, {
    metadata: { type: r.headers.get("content-type") || "application/octet-stream" },
  });
}

const RETRYABLE = (e: any) => e instanceof HfError && (e.status === 429 || e.status >= 500);

export async function saveJob(j: Job) {
  j.updatedAt = Date.now();
  await store().setJSON(`job/${j.id}`, j);
}

export async function listJobs(): Promise<Job[]> {
  const s = store();
  const { blobs } = await s.list({ prefix: "job/" });
  const jobs = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return (jobs.filter(Boolean) as Job[]).sort((a, b) => b.createdAt - a.createdAt);
}

export async function createJobs(prompt: string, count: number, wantVideo: boolean) {
  const ids: string[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const id = `${now}-${i}-${Math.random().toString(36).slice(2, 7)}`;
    await saveJob({ id, prompt, wantVideo, state: "pending", tries: 0, createdAt: now + i, updatedAt: now });
    ids.push(id);
  }
  return ids;
}

/** Advance one job by one step. Safe to call repeatedly. */
async function step(j: Job) {
  if (j.state === "done" || j.state === "error") return;
  if (j.lockUntil && j.lockUntil > Date.now()) return;
  j.lockUntil = Date.now() + 25_000;
  await saveJob(j);
  try {
    if (j.state === "pending") {
      const r = await submitImage(j.prompt);
      j.imgReq = r.request_id;
      j.state = "img_wait";
    } else if (j.state === "img_wait") {
      const s = await status(j.imgReq!);
      if (s.status === "completed") {
        j.imageUrl = s.images?.[0]?.url;
        await saveFile(`file/${j.id}/image`, j.imageUrl!);
        j.hasImage = true;
        j.state = j.wantVideo ? "vid_pending" : "done";
      } else if (["failed", "nsfw", "canceled"].includes(s.status)) {
        j.state = "error";
        j.error = `Imagem: ${s.status}${s.error ? " – " + s.error : ""}`;
      }
    } else if (j.state === "vid_pending") {
      const r = await submitVideo(j.prompt, j.imageUrl!);
      j.vidReq = r.request_id;
      j.state = "vid_wait";
    } else if (j.state === "vid_wait") {
      const s = await status(j.vidReq!);
      if (s.status === "completed") {
        j.videoUrl = s.video?.url;
        await saveFile(`file/${j.id}/video`, j.videoUrl!);
        j.hasVideo = true;
        j.state = "done";
      } else if (["failed", "nsfw", "canceled"].includes(s.status)) {
        j.state = "error";
        j.error = `Vídeo: ${s.status}${s.error ? " – " + s.error : ""}`;
      }
    }
  } catch (e: any) {
    j.tries++;
    if (!RETRYABLE(e) && j.tries >= 3) {
      j.state = "error";
      j.error = String(e.message || e);
    }
  }
  j.lockUntil = undefined;
  await saveJob(j);
}

/** Advance all open jobs; stays under ~20s. */
export async function advanceAll() {
  const open = (await listJobs()).filter((j) => j.state !== "done" && j.state !== "error");
  const deadline = Date.now() + 20_000;
  await Promise.all(
    open.map((j) =>
      Promise.race([step(j), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))])
    )
  );
  return open.length;
}
