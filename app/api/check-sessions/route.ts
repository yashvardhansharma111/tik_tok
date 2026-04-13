/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/currentUser";
import { spawn } from "child_process";
import path from "path";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const accountIds: string[] = Array.isArray(body.accountIds) ? body.accountIds : [];
  if (accountIds.length === 0) {
    return NextResponse.json({ error: "accountIds required" }, { status: 400 });
  }
  if (accountIds.length > 200) {
    return NextResponse.json({ error: "Max 200 accounts per check" }, { status: 400 });
  }

  console.log(`[check-sessions] spawning health check script for ${accountIds.length} accounts`);

  const scriptPath = path.join(process.cwd(), "scripts", "checkSessionHealth.ts");

  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn("npx", ["tsx", scriptPath], {
      env: { ...process.env },
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      const line = data.toString();
      stderr += line;
      process.stderr.write(line);
    });

    child.stdin.write(JSON.stringify({ accountIds }));
    child.stdin.end();

    child.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });

    child.on("error", (err) => {
      resolve({ stdout, stderr: stderr + "\n" + String(err), code: 1 });
    });
  });

  console.log(`[check-sessions] script exited with code ${result.code}`);

  if (result.code !== 0) {
    console.error("[check-sessions] script stderr:", result.stderr);
    return NextResponse.json(
      { error: "Health check failed", details: result.stderr.slice(-500) },
      { status: 500 }
    );
  }

  try {
    const data = JSON.parse(result.stdout);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "Failed to parse script output", raw: result.stdout.slice(-500) },
      { status: 500 }
    );
  }
}
