import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  root: "web",
  publicDir: "public",
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022", assetsInlineLimit: 0 },
  plugins: [
    preact(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ["**/*.{html,js,css,woff2,png,svg,webmanifest}"],
      },
      devOptions: { enabled: false },
    }),
  ],
});
