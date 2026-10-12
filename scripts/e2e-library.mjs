// Loads the exercise library fixture (tests/fixtures/library/fedb-sample.json: real free-exercise-db entries, with image
// paths kept on four of them so the start stays fast) into a
// local e2e D1/R2 with the production import script. The images are a small generated placeholder JPEG per key, so
// the e2e run needs no network and no library media in git.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PLACEHOLDER_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDsKKKKRAUVmazq/wDZXk/uPN83d/HtxjHsfWsv/hLv+nD/AMjf/Y1VmZyrQi7NnT0VzH/CXf8ATh/5G/8Asav6Rrv9p3TQfZvK2oXz5m7uB6D1osxKtCTsmbFFFFSahRRRQBzHjP8A5c/+B/8AstcxXT+M/wDlz/4H/wCy1zFax2POxH8RhW94Q/5Csv8A1wP/AKEtYNb3hD/kKy/9cD/6EtD2Jo/GjsKKKKyPTCiiigDH8QaVPqf2fyHiXy92d5I649AfSsf/AIRW/wD+e1t/303+FdhRVKTRlKjCTuzj/wDhFb//AJ7W3/fTf4VpaFotzpt6807wsrRlAEJJzkHuPat6ijmYo0IRd0FFFFSbH//Z", "base64");
const DATASET = "tests/fixtures/library/fedb-sample.json";

export function loadLibrary(persistTo) {
  const dir = mkdtempSync(join(tmpdir(), "lg-e2e-images-"));
  try {
    for (const x of JSON.parse(readFileSync(DATASET, "utf8"))) {
      for (const img of x.images) {
        mkdirSync(dirname(join(dir, img)), { recursive: true });
        writeFileSync(join(dir, img), PLACEHOLDER_JPEG);
      }
    }
    execFileSync("npx", ["tsx", "seed/import-exercises.ts", "--local", "--persist-to", persistTo, "--dataset", DATASET, "--images", dir], { stdio: "inherit" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
