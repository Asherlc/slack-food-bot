import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { type AppConfig, loadConfig } from "./config.js";
import { createNotFoundResponse, handleHealthRequest } from "./http/health-handler.js";
import { createWebRuntime } from "./runtime.js";
import { createExceptionReporter } from "./telemetry.js";

const nodeRequestOrigin = "http://127.0.0.1";
const fetchForbiddenMethods = new Set(["CONNECT", "TRACE", "TRACK"]);

export type HealthServer = {
  port: number;
  close: () => Promise<void>;
};

export async function createHealthServer(options: { port?: number } = {}): Promise<HealthServer> {
  const server = createServer((request, response) => {
    void respondToNodeRequest(request, response).catch(() => {
      response.destroy();
    });
  });

  await listen(server, options.port ?? 3000);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Health server did not expose a TCP address");
  }

  return {
    port: address.port,
    close: () => closeServer(server),
  };
}

async function respondToNodeRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let handled: Response;

  try {
    const method = request.method ?? "GET";
    const hasMalformedHost = request.headers.host
      ? !URL.canParse(`http://${request.headers.host}`)
      : false;

    handled =
      hasMalformedHost || fetchForbiddenMethods.has(method.toUpperCase())
        ? createNotFoundResponse()
        : handleHealthRequest(
            new Request(new URL(request.url ?? "/", nodeRequestOrigin), { method }),
          );
  } catch {
    handled = createNotFoundResponse();
  }

  response.writeHead(handled.status, Object.fromEntries(handled.headers));
  response.end(await handled.text());
}

export function startApplication(env: NodeJS.ProcessEnv = process.env): Promise<HealthServer> {
  const config: AppConfig = loadConfig(env);
  const runtime = createWebRuntime(config);
  return runtime.start().then((server) => ({
    port: config.port,
    close: async () => {
      await runtime.stop();
      server.close();
    },
  }));
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  startApplication().catch((error: unknown) => {
    createExceptionReporter().captureException(error, { operation: "startup" });
    process.exitCode = 1;
  });
}
