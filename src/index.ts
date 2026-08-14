import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { type AppConfig, loadConfig } from "./config.js";
import { createExceptionReporter } from "./telemetry.js";

export type HealthServer = {
  port: number;
  close: () => Promise<void>;
};

export async function createHealthServer(options: { port?: number } = {}): Promise<HealthServer> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Not found" }));
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

export function startApplication(env: NodeJS.ProcessEnv = process.env): Promise<HealthServer> {
  const config: AppConfig = loadConfig(env);
  return createHealthServer({ port: config.port });
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
