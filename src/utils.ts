/**
 * Utility functions
 */
import { spawn } from "child_process";

export function execAsync(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sh", ["-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    
    let stdout = "";
    let stderr = "";
    
    proc.stdout?.on("data", (data) => { stdout += data.toString(); });
    proc.stderr?.on("data", (data) => { stderr += data.toString(); });
    
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (exit ${code}): ${command}\n${stderr}`));
      } else {
        resolve(stdout);
      }
    });
    
    proc.on("error", (err) => {
      reject(new Error(`Command error: ${command}\n${err.message}`));
    });
  });
}