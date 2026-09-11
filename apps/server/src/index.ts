import { createServer } from "./app";
import { loadConfig } from "./config";

async function main() {
  const app = createServer();
  const config = loadConfig();
  await app.listen({ host: config.host, port: config.port });
}

void main();
