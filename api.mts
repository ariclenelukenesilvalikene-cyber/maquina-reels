import type { Context, Config } from "@netlify/functions";
import { checkPassword, createJobs, listJobs, advanceAll, store } from "../lib/core.mts";

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });

export default async (req: Request, _ctx: Context) => {
  if (!checkPassword(req)) return json({ error: "Palavra-passe errada" }, 401);
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "");

  if (path === "/jobs" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const prompt = String(b.prompt || "").trim().slice(0, 1500);
    if (!prompt) return json({ error: "Escreve um tema" }, 400);
    const count = Math.min(10, Math.max(1, Number(b.count) || 1));
    const ids = await createJobs(prompt, count, b.video !== false);
    await advanceAll(); // arranca já
    return json({ ids });
  }

  if (path === "/jobs" && req.method === "GET") {
    const jobs = (await listJobs()).map(({ lockUntil, ...j }) => j);
    return json({ jobs });
  }

  if (path === "/tick" && req.method === "POST") {
    return json({ open: await advanceAll() });
  }

  const m = path.match(/^\/file\/([\w-]+)\/(image|video)$/);
  if (m && req.method === "GET") {
    const r = await store().getWithMetadata(`file/${m[1]}/${m[2]}`, { type: "arrayBuffer" });
    if (!r) return new Response("Não encontrado", { status: 404 });
    const type = (r.metadata?.type as string) || (m[2] === "video" ? "video/mp4" : "image/jpeg");
    const ext = m[2] === "video" ? "mp4" : type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    const headers: Record<string, string> = { "Content-Type": type, "Cache-Control": "private, max-age=86400" };
    if (url.searchParams.get("dl")) headers["Content-Disposition"] = `attachment; filename="reel-${m[1]}.${ext}"`;
    return new Response(r.data as ArrayBuffer, { headers });
  }

  if (path.startsWith("/job/") && req.method === "DELETE") {
    const id = path.slice(5);
    const s = store();
    await Promise.all([s.delete(`job/${id}`), s.delete(`file/${id}/image`), s.delete(`file/${id}/video`)]);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
};

export const config: Config = { path: "/api/*" };
