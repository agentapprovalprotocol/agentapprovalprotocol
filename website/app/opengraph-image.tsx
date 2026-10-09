import fs from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";
import { site } from "@/site.config";

export const alt = site.name;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Social cards use the light lockup on porcelain, matching the brand guidance.
export default function OpenGraphImage() {
  const lockup = fs.readFileSync(path.join(process.cwd(), "public/brand/aap-lockup-light.svg"));
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 96px", background: "#f9f9f8", color: "#0a0d17" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`data:image/svg+xml;base64,${lockup.toString("base64")}`} alt="" width={512} height={192} style={{ marginLeft: -12 }} />
      <div style={{ marginTop: 48, fontSize: 44, lineHeight: 1.3, maxWidth: 900 }}>{site.description}</div>
    </div>,
    size,
  );
}
