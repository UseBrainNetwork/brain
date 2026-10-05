import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: import.meta.dirname },
  agentRules: false,
  // `pg` has optional native bindings and dynamic requires; load it from node_modules, do not bundle it.
  serverExternalPackages: ["pg"],
  // PgStore applies db/schema.sql at runtime; make sure it ships with every serverless function.
  outputFileTracingIncludes: { "/**": ["./db/schema.sql"] },
  async rewrites() {
    // Public OpenAI-compatible surface: /v1/* is served by the gateway route handlers.
    return [{ source: "/v1/:path*", destination: "/api/v1/:path*" }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
