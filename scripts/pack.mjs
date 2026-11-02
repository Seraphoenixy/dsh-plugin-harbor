import { mkdirSync } from "node:fs";
import { npm } from "./npm.mjs";

mkdirSync("artifacts", { recursive: true });
for (const args of [
  ["run", "build"],
  ["pack", "--ignore-scripts", "--pack-destination", "artifacts"],
]) {
  const result = npm(args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}