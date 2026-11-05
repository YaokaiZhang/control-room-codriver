import type { NextConfig } from "next"

// 127.0.0.1 is how a forwarded port is often opened; Next blocks dev resources for origins it does not know.
// The Rules page became the Lessons page; old links still land.
const config: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1"],
  redirects: async () => [{ source: "/rules", destination: "/lessons", permanent: false }],
}

export default config
