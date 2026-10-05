import fs from "node:fs/promises";
import { errorJson } from "@/lib/http";
import { evidencePath, mimeForFilename } from "@/lib/storage/evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Serve a screenshot or downloaded file. Unguessable task ids make these capability URLs. */
export async function GET(_req: Request, ctx: { params: Promise<{ taskId: string; file: string }> }): Promise<Response> {
  const { taskId, file } = await ctx.params;
  const filename = decodeURIComponent(file);
  const filePath = evidencePath(taskId, filename);
  if (!filePath) return errorJson("NOT_FOUND", "Evidence not found.");
  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch {
    return errorJson("NOT_FOUND", "Evidence not found or expired.");
  }
  const mime = mimeForFilename(filename);
  const inline = INLINE_TYPES.has(mime);
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      // Downloaded files are untrusted third-party content: never render them on this origin.
      "content-type": inline ? mime : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "content-length": String(data.length),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
}
