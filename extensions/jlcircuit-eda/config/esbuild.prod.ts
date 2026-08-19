import process from "node:process";
import esbuild from "esbuild";
import common from "./esbuild.common.ts";

const context = await esbuild.context(common);
if (process.argv.includes("--watch")) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
