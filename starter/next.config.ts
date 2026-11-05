import type { NextConfig } from "next"

// 127.0.0.1 is how a forwarded port is often opened; Next blocks dev resources for origins it does not know.
// The persistent Turbopack dev cache makes open tabs reload in a loop after a restart on 16.4 (vercel/next.js#100251, #100267).
// The Rules page became the Lessons page; old links still land.
const config: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1"],
  experimental: { turbopackFileSystemCacheForDev: false },
  redirects: async () => [{ source: "/rules", destination: "/lessons", permanent: false }],
}

export default config
