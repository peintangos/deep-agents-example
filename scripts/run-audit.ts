import process from "node:process";
import { runCli } from "../src/cli";

const result = runCli(process.argv);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
