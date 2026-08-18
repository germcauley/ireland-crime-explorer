import vinext from "vinext";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

// Separate config for Vercel: the default vite.config.ts wires in Cloudflare
// Workers bindings (D1/R2) and the OpenAI site-creator plugin, neither of
// which apply on Vercel. This app doesn't use those bindings on its one
// route, so a plain vinext + Nitro build is enough.
export default defineConfig({
  plugins: [vinext(), nitro()],
});
