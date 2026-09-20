import { dropxOneRelease } from "@/lib/dropx-one-release";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(dropxOneRelease, {
    headers: {
      "Cache-Control": "no-store, max-age=0"
    }
  });
}
