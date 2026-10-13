// The 3D anatomy model (SPEC-v6 §1, §5): where the app serves it and the cache that keeps it, its Draco decoder and
// the 3D code chunk after first use. scripts/anatomy-assets.mjs checks the model's SHA-256 at build time. The decoder is
// three.js's glTF build (three/examples/jsm/libs/draco/gltf/), which Vite copies into /assets/ with a content hash
// (DRACOLoader's DRACO_GLTF_CONFIG), so it is self-hosted and every version has its own URL.

/** SHA-256 of web/public/models/body.glb (hpfrei/body-anatomy-3d-viewer@0fc76a9, unmodified). */
export const GLB_SHA256 = "0886b6a068e655b284903664e2178d7964f80b1c0ce798461909ac806bcef2e3";

/** The model, versioned by its hash so a changed file never comes from an old cache. */
export const GLB_URL = `/models/body.glb?v=${GLB_SHA256.slice(0, 12)}`;
/** Service-worker cache for the model, the decoder and the 3D code chunk. */
export const ANATOMY_CACHE = `anatomy-${GLB_SHA256.slice(0, 12)}`;
/** True for the requests the anatomy cache serves: the model, the Draco decoder and the lazily loaded 3D chunk. */
export const isAnatomyAsset = (pathname: string): boolean =>
  pathname === "/models/body.glb" || /^\/assets\/(anatomy3d|draco_decoder|draco_wasm_wrapper)-[\w-]+\.(js|wasm)$/.test(pathname);
