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
        // The 3D picker's model, decoder and code chunk are cached on first use instead (web/src/sw.ts).
        globIgnores: ["models/**", "assets/anatomy3d-*.js", "assets/draco_*"],
      },
      devOptions: { enabled: false },
    }),
  ],
});
