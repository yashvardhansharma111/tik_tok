import mongoose from "mongoose";

const LOG = "[MongoDB]";

const _mongo = process.env.MONGODB_URI;
if (!_mongo) {
  throw new Error("Missing MONGODB_URI in environment variables");
}
const MONGODB_URI: string = _mongo;

/** Target db from code (may override URI path). */
const DB_NAME = "tiktok_automation";

type Cached = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

declare global {
  var _mongooseCache: Cached | undefined;
  var _mongoLogListenersAttached: boolean | undefined;
  var _mongoSuccessLogged: boolean | undefined;
}

const cached: Cached = global._mongooseCache ?? { conn: null, promise: null };
global._mongooseCache = cached;

const verbose =
  process.env.NODE_ENV === "development" || process.env.MONGODB_DEBUG === "1";

/**
 * Host + db path for logs only — never username, password, or full URI.
 */
export function getMongoLogContext(uri: string) {
  try {
    if (uri.startsWith("mongodb+srv://")) {
      const at = uri.indexOf("@");
      if (at === -1) return { host: "(invalid SRV URI: no @)", dbInUri: "" };
      const rest = uri.slice(at + 1);
      const slash = rest.indexOf("/");
      const q = rest.indexOf("?");
      const host =
        slash === -1
          ? q === -1
            ? rest
            : rest.slice(0, q)
          : rest.slice(0, slash);
      let dbInUri = "";
      if (slash !== -1) {
        const pathEnd = q === -1 ? rest.length : q;
        dbInUri = rest.slice(slash + 1, pathEnd) || "(none in URI)";
      }
      return { host: host.trim(), dbInUri };
    }
    const normalized = uri.replace(/^mongodb:\/\//, "http://");
    const u = new URL(normalized);
    const dbInUri = u.pathname?.replace(/^\//, "") || "(none in URI)";
    return { host: u.port ? `${u.hostname}:${u.port}` : u.hostname, dbInUri };
  } catch {
    return { host: "(URI parse error)", dbInUri: "" };
  }
}

function attachConnectionEventLogsOnce() {
  if (!verbose || global._mongoLogListenersAttached) return;
  global._mongoLogListenersAttached = true;
  const c = mongoose.connection;

  c.on("connecting", () => console.log(LOG, "driver event: connecting…"));
  c.on("connected", () =>
    console.log(LOG, "driver event: connected", { host: c.host, name: c.name })
  );
  c.on("open", () => console.log(LOG, "driver event: open — socket ready"));
  c.on("disconnected", () =>
    console.warn(LOG, "driver event: disconnected", { readyState: c.readyState })
  );
  c.on("close", () => console.warn(LOG, "driver event: close"));
  c.on("reconnected", () => console.log(LOG, "driver event: reconnected"));
  c.on("error", (err: Error) =>
    console.error(LOG, "driver event: error", formatDriverError(err))
  );
}

function formatDriverError(err: Error) {
  const x = err as Error & {
    code?: number | string;
    codeName?: string;
    reason?: { message?: string };
  };
  return {
    name: err.name,
    message: err.message,
    code: x.code,
    codeName: x.codeName,
    reason: x.reason?.message,
  };
}

function logConnectFailure(err: unknown, ctx: { host: string; dbInUri: string; phase: string }) {
  const e = err instanceof Error ? err : new Error(String(err));
  const any = e as Error & {
    code?: number | string;
    codeName?: string;
    cause?: unknown;
    errorLabels?: string[];
    reason?: { type?: string; servers?: unknown };
  };

  const cause =
    any.cause instanceof Error
      ? { name: any.cause.name, message: any.cause.message }
      : any.cause != null
        ? { value: String(any.cause) }
        : undefined;

  console.error(LOG, "CONNECT FAILED", {
    phase: ctx.phase,
    targetDb: DB_NAME,
    uriHost: ctx.host,
    databaseInConnectionString: ctx.dbInUri,
    errorName: e.name,
    message: e.message,
    code: any.code,
    codeName: any.codeName,
    errorLabels: any.errorLabels,
    cause,
    hints: connectionHints(e.message, any.code, any.codeName),
  });
}

function connectionHints(
  message: string,
  code?: number | string,
  codeName?: string
): string[] {
  const hints: string[] = [];
  const m = message.toLowerCase();

  if (m.includes("ip") && m.includes("whitelist")) {
    hints.push("Atlas → Network Access: allow your IP or 0.0.0.0/0 (dev only).");
  }
  if (m.includes("authentication failed") || codeName === "AtlasError") {
    hints.push("Check Database user + password in URI; URL-encode special chars in password (@ → %40).");
  }
  if (m.includes("timed out") || m.includes("serverselection") || code === 8000) {
    hints.push("Timeout: cluster may be Paused (Atlas → Resume), firewall/VPN blocking outbound to MongoDB, or wrong cluster host.");
  }
  if (m.includes("enotfound") || m.includes("getaddrinfo")) {
    hints.push("DNS failure: check hostname in MONGODB_URI and internet/VPN.");
  }
  if (m.includes("ssl") || m.includes("tls") || m.includes("certificate")) {
    hints.push("TLS issue: try updated Node.js; corporate proxy inspecting TLS?");
  }
  if (hints.length === 0) {
    hints.push("Verify MONGODB_URI in .env, restart `npm run dev`, confirm cluster is Active in Atlas.");
  }
  return hints;
}

/**
 * If the first connect fails (VPN, Atlas pause, bad network), we must not keep a rejected
 * promise in cache — otherwise every later request fails until you restart the dev server.
 */
export async function connectDB() {
  attachConnectionEventLogsOnce();

  const ctxBase = getMongoLogContext(MONGODB_URI);

  const ready = cached.conn?.connection?.readyState === 1;
  if (ready) {
    if (verbose && !global._mongoSuccessLogged) {
      global._mongoSuccessLogged = true;
      console.log(LOG, "using existing connection", {
        host: mongoose.connection.host,
        name: mongoose.connection.name,
        readyState: mongoose.connection.readyState,
      });
    }
    return cached.conn;
  }

  const deadConn = cached.conn;
  const dead = deadConn != null && deadConn.connection?.readyState !== 1;
  if (dead) {
    if (verbose) {
      console.warn(LOG, "previous connection not ready — resetting cache", {
        readyState: deadConn.connection?.readyState,
        states: "0=disconnected,1=connected,2=connecting,3=disconnecting",
      });
    }
    cached.conn = null;
    cached.promise = null;
  }

  if (!cached.promise) {
    if (verbose) {
      console.log(LOG, "starting new connection attempt", {
        uriHost: ctxBase.host,
        databaseInConnectionString: ctxBase.dbInUri,
        mongooseDbNameOption: DB_NAME,
        serverSelectionTimeoutMS: 20_000,
      });
    }
    cached.promise = mongoose
      .connect(MONGODB_URI, {
        dbName: DB_NAME,
        serverSelectionTimeoutMS: 20_000,
        socketTimeoutMS: 45_000,
      })
      .then((m) => m);
  }

  try {
    cached.conn = await cached.promise;
    if (verbose && !global._mongoSuccessLogged) {
      global._mongoSuccessLogged = true;
      console.log(LOG, "CONNECT OK", {
        host: mongoose.connection.host,
        db: mongoose.connection.db?.databaseName ?? DB_NAME,
        readyState: mongoose.connection.readyState,
      });
    }
    return cached.conn;
  } catch (err) {
    logConnectFailure(err, { ...ctxBase, phase: "mongoose.connect" });
    cached.promise = null;
    cached.conn = null;
    global._mongoSuccessLogged = false;
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    throw err;
  }
}
